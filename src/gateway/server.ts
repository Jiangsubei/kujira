/**
 * kujira: QQ 官方 Bot API v2 正向网关与 REST 客户端
 *
 * 核心能力：
 * 1. 鉴权与 Token 管理：Singleflight 获取 access_token、提前 60s 自动刷新、401 退避重取；
 * 2. 正向 WSS Gateway 连接：GET /gateway -> HELLO 心跳 + 死链看门狗 (HELLO 超时 & HEARTBEAT_ACK 失联检测)、
 *    IDENTIFY (intents = 1 << 25)、RESUME、RECONNECT (op=7)、INVALID_SESSION (op=9)、指数退避重连；
 * 3. 安全事件分发：onC2CMessage、onDispatch（安全脱敏记录 FRIEND_ADD 等非消息事件）、onReady、onMessageSent；
 * 4. 完整 REST 客户端（不抛未包装异常，统一返回 QQApiResult，日志脱敏不输出 secret/token/query）：
 *    - sendC2CMessage (`POST /v2/users/{openid}/messages`)
 *    - sendC2CStreamMessage (`POST /v2/users/{openid}/stream_messages`)
 *    - sendInputNotify (`msg_type=6, input_type=1, input_second=60`)
 *    - deleteC2CMessage (`DELETE /v2/users/{openid}/messages/{message_id}`)
 *    - uploadC2CMedia（严格 1-based parts[].index 升序 + 累积 offset + 单片 block_size + 裸 PUT + upload_part_finish + /files，
 *      结合 (openid, md5, fileType) 本地 24h media_upload_cache 缓存复用，绝不假设服务端 MD5 秒传）；
 * 5. 只读网关状态查询 `getStatus()`（供 `/状态` 命令展示）。
 */

import { createHash } from 'node:crypto';
import type { AttachmentDescriptor } from '../attachment/types.js';
import {
  QQ_API_BASE,
  QQ_BOT_TOKEN_URL,
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_INPUT_NOTIFY_MAX_SECONDS,
  QQ_INTENT_GROUP_AND_C2C_EVENT,
  QQ_MEDIA_HARD_LIMIT,
  QQ_MEDIA_SOFT_LIMIT_AUDIO,
  QQ_MEDIA_SOFT_LIMIT_IMAGE,
  QQ_MEDIA_SOFT_LIMIT_VIDEO,
  QQ_MSG_TYPE_INPUT_NOTIFY,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_REQUEST_TIMEOUT_MS,
  QQ_TOKEN_REFRESH_MARGIN_MS,
  QQ_UPLOAD_MD5_10M_BYTES,
  QQ_UPLOAD_PUT_TIMEOUT_MS,
  QQ_WS_BACKOFF_MS,
} from '../constants/index.js';
import type {
  MediaUploadCacheRecord,
  QQApiResult,
  QQC2CMessageCreateEvent,
  QQFilesMergeResponse,
  QQGatewayPayload,
  QQMediaFileType,
  QQReadyEvent,
  QQSendMessagePayload,
  QQSendMessageResponse,
  QQStreamMessagePayload,
  QQStreamMessageResponse,
  QQUploadPrepareResponse,
  QqCredential,
} from '../types/index.js';
import { isValidOpenid, openidToPeer } from '../utils/peer.js';

export * from './wait-registry.js';

export interface GatewayLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
}

/** 网关 WebSocket 最小抽象（Node 内置全局 WebSocket 为其超集，便于测试注入假实现） */
export interface QqWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: QqWsEvent) => void): void;
}

export interface QqWsEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

/** Gateway READY 事件提取后的结构化信息 */
export interface GatewayReadyInfo {
  sessionId: string;
  botId: string;
  botName: string;
}

/** 只读网关运行状态（供 `/状态` 命令与运行态面板展示） */
export interface GatewayStatus {
  connected: boolean;
  ready: boolean;
  botId?: string;
  botName?: string;
  reconnectAttempts: number;
}

/** 出站消息成功发送后的事件（供自记录立即落库） */
export interface OutboundSentEvent {
  /** 内部单聊会话 peer (`user_<hash16>`) */
  peer: string;
  /** 目标用户 openid */
  openid: string;
  /** QQ 返回的出站消息 ID (`ROBOT1.0_...`)，仅用于 120s 内 DELETE 撤回，绝不作入站被动锚点 */
  msgId: string;
  /** QQ 返回的出站引用索引 (`ext_info.ref_idx`, `REFIDX_...`) */
  refIdx?: string;
  /** 引用目标消息 ID / ref_idx */
  replyTo?: string | null;
  /** QQ 消息类型: 0=纯文本, 2=Markdown, 7=富媒体 */
  msgType: 0 | 2 | 7;
  /** 纯净文本正文（或富媒体展示文案） */
  text?: string;
  /** 发送载荷快照 */
  payload?: unknown;
  /** 发送完成时间（毫秒时间戳） */
  time: number;
  /** 发送方旁路携带的统一附件描述符 */
  attachments?: AttachmentDescriptor[];
}

/** `sendC2CMessage` 附带的记录元信息（不进入发给 QQ 的请求体） */
export interface OutboundSendMeta {
  peer?: string;
  replyTo?: string | null;
  text?: string;
  attachments?: AttachmentDescriptor[];
  /** 为 true 时跳过自动触发 onMessageSent（由调度层自行统一汇报） */
  skipAutoRecord?: boolean;
}

/** 本地富媒体上传缓存接口（与 MessageDatabase.getCachedMediaUpload / saveCachedMediaUpload 对齐） */
export interface MediaUploadCacheStore {
  getCachedMediaUpload?(openid: string, md5: string, fileType: number): MediaUploadCacheRecord | null | undefined;
  saveCachedMediaUpload?(record: MediaUploadCacheRecord): void;
}

export interface UploadC2CMediaOptions {
  fileType: QQMediaFileType;
  fileName: string;
  db?: MediaUploadCacheStore;
  bypassCache?: boolean;
}

export interface KujiraGatewayClientOptions {
  credentials?: QqCredential;
  appId?: string;
  appSecret?: string;
  logger?: GatewayLogger;
  fetchFn?: typeof fetch;
  createWebSocket?: (url: string) => QqWebSocketLike;
  heartbeatIntervalRatio?: number;
  helloTimeoutMs?: number;
  maxMissedHeartbeatAcks?: number;
  requestTimeoutMs?: number;
  uploadPutTimeoutMs?: number;
  authRetryDelayMs?: number;
  backoffDelaysMs?: readonly number[];
  intents?: number;
  tokenUrl?: string;
  apiBase?: string;
  onC2CMessage?: (event: QQC2CMessageCreateEvent) => void | Promise<void>;
  onDispatch?: (eventName: string, data: unknown, fullPayload: QQGatewayPayload) => void | Promise<void>;
  onReady?: (info: GatewayReadyInfo) => void | Promise<void>;
  onMessageSent?: (event: OutboundSentEvent) => void | Promise<void>;
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MISSED_HEARTBEAT_ACKS = 2;
const DEFAULT_AUTH_RETRY_DELAY_MS = 200;
const DEFAULT_MEDIA_CACHE_TTL_SEC = 86_400;
const TOKEN_401_RETRY_CODE = 401;
const ERR_INVALID_MARKDOWN = 40034011;
const ERR_STREAM_MISSING_MSG_ID = 50015001;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

interface RawHttpResponse {
  ok: boolean;
  status: number;
  text: string;
  contentType: string | null;
  bytes: Uint8Array;
}

function defaultCreateWebSocket(url: string): QqWebSocketLike {
  return new WebSocket(url) as unknown as QqWebSocketLike;
}

const md5Hex = (data: Uint8Array): string => createHash('md5').update(data).digest('hex');
const sha1Hex = (data: Uint8Array): string => createHash('sha1').update(data).digest('hex');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 去除 URL 中的 query 参数，避免预签名/带凭证下载 URL 明文落入日志 */
function stripUrlQuery(rawUrl: string): string {
  const qIndex = rawUrl.indexOf('?');
  return qIndex === -1 ? rawUrl : `${rawUrl.slice(0, qIndex)}?<redacted>`;
}

/** 日志脱敏：隐藏 URL query、secret 与 token */
function sanitizeLogText(text: string, secrets: Array<string | null | undefined>): string {
  let out = text.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => stripUrlQuery(match));
  out = out.replace(/(Bearer|QQBot)\s+[A-Za-z0-9._-]+/gi, '$1 <redacted>');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('<redacted>');
    }
  }
  return out;
}

function resolveEffectiveMediaFileType(requestedType: QQMediaFileType, sizeBytes: number): QQMediaFileType {
  const softLimit =
    requestedType === QQ_FILE_TYPE_IMAGE
      ? QQ_MEDIA_SOFT_LIMIT_IMAGE
      : requestedType === QQ_FILE_TYPE_VIDEO
        ? QQ_MEDIA_SOFT_LIMIT_VIDEO
        : requestedType === QQ_FILE_TYPE_AUDIO
          ? QQ_MEDIA_SOFT_LIMIT_AUDIO
          : Number.POSITIVE_INFINITY;
  return sizeBytes > softLimit ? QQ_FILE_TYPE_FILE : requestedType;
}

function toApiResult<T = any>(res: RawHttpResponse): QQApiResult<T> {
  let body: any = null;
  if (res.text) {
    try {
      body = JSON.parse(res.text);
    } catch {
      body = res.text;
    }
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const code = record?.code ?? record?.errcode;
  const message = record?.message ?? record?.msg ?? record?.errmsg;
  const ok = res.ok && (code === undefined || String(code) === '0');
  return {
    ok,
    status: res.status,
    ...(code === undefined ? {} : { code: code as string | number }),
    ...(message === undefined ? {} : { message: String(message) }),
    body: body as T,
  };
}

export class KujiraGatewayClient {
  private appId: string;
  private appSecret: string;
  private readonly log: GatewayLogger;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: (url: string) => QqWebSocketLike;
  private readonly heartbeatIntervalRatio: number;
  private readonly helloTimeoutMs: number;
  private readonly maxMissedHeartbeatAcks: number;
  private readonly requestTimeoutMs: number;
  private readonly uploadPutTimeoutMs: number;
  private readonly authRetryDelayMs: number;
  private readonly backoffDelays: readonly number[];
  private readonly intents: number;
  private readonly tokenUrl: string;
  private readonly apiBase: string;

  // ── 鉴权状态 ──
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string> | null = null;

  // ── WS 网关状态 ──
  private ws: QqWebSocketLike | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private helloWatchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private lastSeq = 0;
  private reconnectAttempts = 0;
  private missedHeartbeatAcks = 0;
  private awaitingHeartbeatAck = false;
  private isClosing = false;
  private ready = false;
  private botId: string | undefined;
  private botName: string | undefined;

  // ── 内存回退上传缓存（未传入 db 时兜底） ──
  private readonly memoryMediaCache = new Map<string, MediaUploadCacheRecord>();

  // ── 回调集合 ──
  private c2cMessageHandlers: Array<(event: QQC2CMessageCreateEvent) => void | Promise<void>> = [];
  private dispatchHandlers: Array<(eventName: string, data: unknown, fullPayload: QQGatewayPayload) => void | Promise<void>> = [];
  private readyHandlers: Array<(info: GatewayReadyInfo) => void | Promise<void>> = [];
  private messageSentHandlers: Array<(event: OutboundSentEvent) => void | Promise<void>> = [];

  constructor(public readonly options: KujiraGatewayClientOptions = {}) {
    this.appId = (options.credentials?.appId ?? options.appId ?? '').trim();
    this.appSecret = (options.credentials?.appSecret ?? options.appSecret ?? '').trim();
    this.log = options.logger ?? {};
    this.fetchFn = options.fetchFn ?? fetch;
    this.createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
    this.heartbeatIntervalRatio = options.heartbeatIntervalRatio ?? 0.8;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.maxMissedHeartbeatAcks = Math.max(1, options.maxMissedHeartbeatAcks ?? DEFAULT_MAX_MISSED_HEARTBEAT_ACKS);
    this.requestTimeoutMs = options.requestTimeoutMs ?? QQ_REQUEST_TIMEOUT_MS;
    this.uploadPutTimeoutMs = options.uploadPutTimeoutMs ?? QQ_UPLOAD_PUT_TIMEOUT_MS;
    this.authRetryDelayMs = Math.max(0, options.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS);
    this.backoffDelays = options.backoffDelaysMs ?? QQ_WS_BACKOFF_MS;
    this.intents = options.intents ?? QQ_INTENT_GROUP_AND_C2C_EVENT;
    this.tokenUrl = options.tokenUrl ?? QQ_BOT_TOKEN_URL;
    this.apiBase = options.apiBase ?? QQ_API_BASE;

    if (options.onC2CMessage) this.c2cMessageHandlers.push(options.onC2CMessage);
    if (options.onDispatch) this.dispatchHandlers.push(options.onDispatch);
    if (options.onReady) this.readyHandlers.push(options.onReady);
    if (options.onMessageSent) this.messageSentHandlers.push(options.onMessageSent);
  }

  get isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  getStatus(): GatewayStatus {
    return {
      connected: this.isConnected,
      ready: this.ready,
      ...(this.botId ? { botId: this.botId } : {}),
      ...(this.botName ? { botName: this.botName } : {}),
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  updateCredentials(credentials: QqCredential): void {
    this.appId = (credentials.appId ?? '').trim();
    this.appSecret = (credentials.appSecret ?? '').trim();
    this.invalidateToken();
  }

  onC2CMessage(handler: (event: QQC2CMessageCreateEvent) => void | Promise<void>): () => void {
    this.c2cMessageHandlers.push(handler);
    return () => {
      this.c2cMessageHandlers = this.c2cMessageHandlers.filter((h) => h !== handler);
    };
  }

  onDispatch(
    handler: (eventName: string, data: unknown, fullPayload: QQGatewayPayload) => void | Promise<void>
  ): () => void {
    this.dispatchHandlers.push(handler);
    return () => {
      this.dispatchHandlers = this.dispatchHandlers.filter((h) => h !== handler);
    };
  }

  onReady(handler: (info: GatewayReadyInfo) => void | Promise<void>): () => void {
    this.readyHandlers.push(handler);
    return () => {
      this.readyHandlers = this.readyHandlers.filter((h) => h !== handler);
    };
  }

  onMessageSent(handler: (event: OutboundSentEvent) => void | Promise<void>): () => void {
    this.messageSentHandlers.push(handler);
    return () => {
      this.messageSentHandlers = this.messageSentHandlers.filter((h) => h !== handler);
    };
  }

  /** 允许外部调度层在流式结束等场景显式发射 OutboundSentEvent */
  emitMessageSent(event: OutboundSentEvent): void {
    for (const h of this.messageSentHandlers) {
      try {
        const res = h(event);
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          void (res as Promise<unknown>).catch((err) => {
            this.log.warn?.(`[KujiraGateway] onMessageSent 异步回调异常: ${this.sanitize(errorMessage(err))}`);
          });
        }
      } catch (err) {
        this.log.warn?.(`[KujiraGateway] onMessageSent 回调异常: ${this.sanitize(errorMessage(err))}`);
      }
    }
  }

  // ─────────────────────────────── 鉴权 (Singleflight + 提前 60s 刷新) ───────────────────────────────

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) {
      this.invalidateToken();
    }
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt - now > QQ_TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = (async () => {
      try {
        if (!this.appId || !this.appSecret) {
          throw new Error('缺少 QQ Bot 凭据（QQ_BOT_APP_ID / QQ_BOT_SECRET）');
        }
        const res = await this.rawRequest(
          this.tokenUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
          },
          this.requestTimeoutMs
        );
        if (!res.ok) {
          throw new Error(`获取 access_token 失败 [HTTP ${res.status}]: ${this.sanitize(res.text)}`);
        }
        let data: { access_token?: string; expires_in?: number; code?: number; message?: string };
        try {
          data = JSON.parse(res.text);
        } catch {
          throw new Error('获取 access_token 响应非合法 JSON');
        }
        if (!data?.access_token) {
          throw new Error(
            `获取 access_token 响应异常 (code=${String(data?.code ?? 'n/a')} message=${this.sanitize(String(data?.message ?? ''))})`
          );
        }
        const expiresInSec = Number(data.expires_in ?? 7200);
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 7200) * 1000;
        this.log.debug?.(`[KujiraGateway] access_token 已刷新（有效期 ${expiresInSec}s）`);
        return this.accessToken;
      } finally {
        this.tokenPromise = null;
      }
    })();

    return this.tokenPromise;
  }

  private invalidateToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  private async refreshTokenAfter401(): Promise<void> {
    this.invalidateToken();
    if (this.authRetryDelayMs > 0) {
      await sleep(this.authRetryDelayMs);
    }
  }

  private sanitize(text: string): string {
    return sanitizeLogText(text, [this.appSecret, this.accessToken]);
  }

  // ─────────────────────────────── WSS Gateway ───────────────────────────────

  async start(): Promise<void> {
    this.isClosing = false;
    await this.connect();
  }

  stop(): void {
    this.isClosing = true;
    this.ready = false;
    this.clearHeartbeat();
    this.clearHelloWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }

  async restart(credentials?: QqCredential): Promise<void> {
    this.stop();
    this.sessionId = null;
    this.lastSeq = 0;
    this.reconnectAttempts = 0;
    if (credentials) {
      this.updateCredentials(credentials);
    }
    await this.start();
  }

  private async fetchGatewayUrl(allowAuthRetry = true): Promise<string> {
    const token = await this.getAccessToken();
    const res = await this.rawRequest(
      `${this.apiBase}/gateway`,
      { method: 'GET', headers: { Authorization: `QQBot ${token}` } },
      this.requestTimeoutMs
    );
    if (res.status === TOKEN_401_RETRY_CODE && allowAuthRetry) {
      this.log.warn?.('[KujiraGateway] GET /gateway 返回 401，退避刷新 token 重试');
      await this.refreshTokenAfter401();
      return this.fetchGatewayUrl(false);
    }
    if (!res.ok) {
      throw new Error(`获取 Gateway 地址失败 [HTTP ${res.status}]: ${this.sanitize(res.text)}`);
    }
    const parsed = JSON.parse(res.text) as { url?: string };
    if (!parsed?.url) {
      throw new Error('GET /gateway 响应缺少 url 字段');
    }
    return parsed.url;
  }

  private async connect(): Promise<void> {
    if (this.isClosing) return;

    let url: string;
    try {
      url = await this.fetchGatewayUrl();
    } catch (err) {
      this.log.error?.(`[KujiraGateway] 获取 Gateway 失败: ${this.sanitize(errorMessage(err))}`);
      this.scheduleReconnect();
      return;
    }

    if (this.isClosing) return;

    this.log.debug?.(`[KujiraGateway] 连接 Gateway: ${stripUrlQuery(url)}`);
    let ws: QqWebSocketLike;
    try {
      ws = this.createWebSocket(url);
    } catch (err) {
      this.log.error?.(`[KujiraGateway] 创建 WebSocket 失败: ${this.sanitize(errorMessage(err))}`);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.log.debug?.('[KujiraGateway] WebSocket 已连接，等待 HELLO');
      this.armHelloWatchdog(ws);
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
        const parsed = JSON.parse(raw) as QQGatewayPayload;
        this.handlePayload(parsed, ws);
      } catch (err) {
        this.log.warn?.(`[KujiraGateway] 解析 WS 帧失败: ${this.sanitize(errorMessage(err))}`);
      }
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearHeartbeat();
      this.clearHelloWatchdog();
      this.log.warn?.(`[KujiraGateway] WebSocket 关闭 [${ev?.code ?? '?'}]: ${this.sanitize(String(ev?.reason ?? ''))}`);
      if (!this.isClosing) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.log.warn?.('[KujiraGateway] WebSocket 连接出错');
    });
  }

  private handlePayload(payload: QQGatewayPayload, ws: QqWebSocketLike): void {
    if (typeof payload.s === 'number') {
      this.lastSeq = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO: {
        this.clearHelloWatchdog();
        const hello = payload.d as { heartbeat_interval?: number } | undefined;
        const interval = hello?.heartbeat_interval ?? 45_000;
        this.missedHeartbeatAcks = 0;
        this.awaitingHeartbeatAck = false;
        this.startHeartbeat(Math.floor(interval * this.heartbeatIntervalRatio), ws);
        if (this.sessionId) {
          this.fireAndLog(this.sendResume(ws), '发送 RESUME');
        } else {
          this.fireAndLog(this.sendIdentify(ws), '发送 IDENTIFY');
        }
        break;
      }

      case OP_DISPATCH: {
        this.missedHeartbeatAcks = 0;
        this.awaitingHeartbeatAck = false;
        const eventName = String(payload.t ?? '');
        this.invokeDispatchHandlers(eventName, payload.d, payload);

        if (eventName === 'READY') {
          const ready = (payload.d ?? {}) as Partial<QQReadyEvent>;
          this.sessionId = ready.session_id ?? null;
          this.botId = ready.user?.id !== undefined ? String(ready.user.id) : undefined;
          this.botName = ready.user?.username !== undefined ? String(ready.user.username) : undefined;
          this.ready = true;
          this.reconnectAttempts = 0;

          const info: GatewayReadyInfo = {
            sessionId: String(this.sessionId ?? ''),
            botId: this.botId ?? '',
            botName: this.botName ?? '',
          };
          this.log.info?.(`[KujiraGateway] READY: ${info.botName || 'Bot'} (${info.botId || '?'})`);
          this.invokeReadyHandlers(info);
        } else if (eventName === 'RESUMED') {
          this.ready = true;
          this.reconnectAttempts = 0;
          this.log.info?.('[KujiraGateway] RESUMED');
        } else if (eventName === 'C2C_MESSAGE_CREATE') {
          this.invokeC2CMessageHandlers(payload.d as QQC2CMessageCreateEvent);
        } else {
          this.logNonMessageDispatch(eventName, payload.d);
        }
        break;
      }

      case OP_HEARTBEAT_ACK: {
        this.missedHeartbeatAcks = 0;
        this.awaitingHeartbeatAck = false;
        break;
      }

      case OP_RECONNECT: {
        this.log.warn?.('[KujiraGateway] 服务端下发 RECONNECT，关闭当前链接准备恢复重连');
        this.ready = false;
        try {
          ws.close();
        } catch {
          // 忽略关闭异常
        }
        break;
      }

      case OP_INVALID_SESSION: {
        const resumable = payload.d === true;
        this.ready = false;
        if (resumable && this.sessionId) {
          this.log.warn?.('[KujiraGateway] INVALID_SESSION (resumable=true)，尝试 RESUME');
          this.fireAndLog(this.sendResume(ws), '发送 RESUME');
        } else {
          this.log.warn?.('[KujiraGateway] INVALID_SESSION：重置会话并重新 IDENTIFY');
          this.sessionId = null;
          this.lastSeq = 0;
          this.fireAndLog(this.sendIdentify(ws), '重新 IDENTIFY');
        }
        break;
      }

      default:
        break;
    }
  }

  private logNonMessageDispatch(eventName: string, data: unknown): void {
    try {
      const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
      const rawOpenid =
        typeof record?.openid === 'string'
          ? record.openid
          : typeof record?.user_openid === 'string'
            ? record.user_openid
            : undefined;
      const peerTag = rawOpenid && isValidOpenid(rawOpenid) ? ` peer=${openidToPeer(rawOpenid)}` : '';
      this.log.info?.(`[KujiraGateway] 收到非消息网关事件: ${eventName || 'UNKNOWN'}${peerTag}`);
    } catch {
      // 安全日志记录绝不抛出
    }
  }

  private invokeDispatchHandlers(eventName: string, data: unknown, fullPayload: QQGatewayPayload): void {
    for (const h of this.dispatchHandlers) {
      try {
        const res = h(eventName, data, fullPayload);
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          void (res as Promise<unknown>).catch((err) => {
            this.log.error?.(`[KujiraGateway] onDispatch(${eventName}) 异步异常: ${this.sanitize(errorMessage(err))}`);
          });
        }
      } catch (err) {
        this.log.error?.(`[KujiraGateway] onDispatch(${eventName}) 异常: ${this.sanitize(errorMessage(err))}`);
      }
    }
  }

  private invokeReadyHandlers(info: GatewayReadyInfo): void {
    for (const h of this.readyHandlers) {
      try {
        const res = h(info);
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          void (res as Promise<unknown>).catch((err) => {
            this.log.error?.(`[KujiraGateway] onReady 异步异常: ${this.sanitize(errorMessage(err))}`);
          });
        }
      } catch (err) {
        this.log.error?.(`[KujiraGateway] onReady 异常: ${this.sanitize(errorMessage(err))}`);
      }
    }
  }

  private invokeC2CMessageHandlers(event: QQC2CMessageCreateEvent): void {
    for (const h of this.c2cMessageHandlers) {
      try {
        const res = h(event);
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          void (res as Promise<unknown>).catch((err) => {
            this.log.error?.(`[KujiraGateway] onC2CMessage 异步异常: ${this.sanitize(errorMessage(err))}`);
          });
        }
      } catch (err) {
        this.log.error?.(`[KujiraGateway] onC2CMessage 异常: ${this.sanitize(errorMessage(err))}`);
      }
    }
  }

  private async sendIdentify(ws: QqWebSocketLike): Promise<void> {
    if (this.ws !== ws || this.isClosing) return;
    const token = await this.getAccessToken();
    if (this.ws !== ws || this.isClosing) return;
    this.sendWS(
      {
        op: OP_IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          properties: { os: process.platform, browser: 'kujira', device: 'kujira' },
        },
      },
      ws
    );
  }

  private async sendResume(ws: QqWebSocketLike): Promise<void> {
    if (this.ws !== ws || this.isClosing) return;
    const token = await this.getAccessToken();
    if (this.ws !== ws || this.isClosing) return;
    this.sendWS(
      {
        op: OP_RESUME,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.lastSeq,
        },
      },
      ws
    );
  }

  private startHeartbeat(intervalMs: number, ws: QqWebSocketLike): void {
    this.clearHeartbeat();
    if (intervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || this.isClosing) return;
      if (this.awaitingHeartbeatAck) {
        this.missedHeartbeatAcks += 1;
        if (this.missedHeartbeatAcks >= this.maxMissedHeartbeatAcks) {
          this.log.warn?.(
            `[KujiraGateway] 连续 ${this.missedHeartbeatAcks} 次心跳未收到 HEARTBEAT_ACK，判定死链并重连`
          );
          this.handleDeadSocket(ws);
          return;
        }
      }
      this.awaitingHeartbeatAck = true;
      this.sendWS({ op: OP_HEARTBEAT, d: this.lastSeq || null }, ws);
    }, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private armHelloWatchdog(ws: QqWebSocketLike): void {
    this.clearHelloWatchdog();
    this.helloWatchdog = setTimeout(() => {
      this.helloWatchdog = null;
      if (this.isClosing || this.ws !== ws) return;
      this.log.warn?.(`[KujiraGateway] 连接后 ${this.helloTimeoutMs}ms 未收到 HELLO，判定假死并重连`);
      this.handleDeadSocket(ws);
    }, this.helloTimeoutMs);
  }

  private clearHelloWatchdog(): void {
    if (this.helloWatchdog) {
      clearTimeout(this.helloWatchdog);
      this.helloWatchdog = null;
    }
  }

  private handleDeadSocket(ws: QqWebSocketLike): void {
    this.clearHeartbeat();
    this.clearHelloWatchdog();
    this.ready = false;
    if (this.ws === ws) {
      this.ws = null;
    }
    try {
      ws.close();
    } catch {
      // 忽略关闭异常
    }
    if (!this.isClosing) {
      this.scheduleReconnect();
    }
  }

  private sendWS(payload: unknown, ws: QqWebSocketLike | null = this.ws): void {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
      }
    } catch (err) {
      this.log.warn?.(`[KujiraGateway] 发送 WS 帧失败: ${this.sanitize(errorMessage(err))}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.isClosing || this.reconnectTimer) return;
    const delay = this.backoffDelays[Math.min(this.reconnectAttempts, this.backoffDelays.length - 1)] ?? 5000;
    this.reconnectAttempts += 1;
    this.log.info?.(`[KujiraGateway] ${delay}ms 后发起第 ${this.reconnectAttempts} 次重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isClosing) {
        void this.connect();
      }
    }, delay);
  }

  private fireAndLog(promise: Promise<void>, label: string): void {
    void promise.catch((err) => {
      this.log.error?.(`[KujiraGateway] ${label} 失败: ${this.sanitize(errorMessage(err))}`);
    });
  }

  // ─────────────────────────────── 底层 HTTP ───────────────────────────────

  private async rawRequest(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
    timeoutMs: number
  ): Promise<RawHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`请求超时 (${timeoutMs}ms)`)), timeoutMs);
    const requestInit: RequestInit = {
      method: init.method,
      headers: init.headers,
      signal: controller.signal,
    };
    if (typeof init.body === 'string') {
      requestInit.body = init.body;
    } else if (init.body !== undefined) {
      requestInit.body = init.body as unknown as BodyInit;
    }
    try {
      const res = await this.fetchFn(url, requestInit);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      return {
        ok: res.ok,
        status: res.status,
        text,
        contentType: res.headers.get('content-type'),
        bytes,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        text: this.sanitize(errorMessage(err)),
        contentType: null,
        bytes: new Uint8Array(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async authedJsonRequest<T = any>(
    method: 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    allowAuthRetry = true
  ): Promise<QQApiResult<T>> {
    try {
      const token = await this.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      };
      const res = await this.rawRequest(
        url,
        {
          method,
          headers,
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        },
        this.requestTimeoutMs
      );
      if (res.status === TOKEN_401_RETRY_CODE && allowAuthRetry) {
        this.log.warn?.('[KujiraGateway] REST 401，退避刷新 access_token 后重试一次');
        await this.refreshTokenAfter401();
        return this.authedJsonRequest<T>(method, url, payload, false);
      }
      if (res.status === 0) {
        return {
          ok: false,
          status: 0,
          message: this.sanitize(res.text || '网络请求失败'),
          body: null as T,
        };
      }
      return toApiResult<T>(res);
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: this.sanitize(errorMessage(err)),
        body: null as T,
      };
    }
  }

  // ─────────────────────────────── REST 原始方法 ───────────────────────────────

  /**
   * 发送单聊普通/Markdown/输入状态/富媒体消息 (`POST /v2/users/{openid}/messages`)。
   * 永不抛未包装异常，统一返回 `QQApiResult`。
   */
  async sendC2CMessage(
    openid: string,
    payload: QQSendMessagePayload,
    meta?: OutboundSendMeta
  ): Promise<QQApiResult<QQSendMessageResponse>> {
    if (!openid || typeof openid !== 'string' || !isValidOpenid(openid)) {
      return { ok: false, status: 400, message: '无效的目标 openid', body: null as any };
    }

    let finalPayload: QQSendMessagePayload = { ...payload };
    if (finalPayload.msg_type === QQ_MSG_TYPE_MARKDOWN) {
      const mdContent = finalPayload.markdown?.content;
      if (typeof mdContent !== 'string' || mdContent.trim() === '') {
        return {
          ok: false,
          status: 400,
          code: ERR_INVALID_MARKDOWN,
          message: 'msg_type=2 必须携带非空 markdown.content（否则触发 40034011）',
          body: null as any,
        };
      }
      // 实测规范：msg_type=2 时仅下发 markdown.content，不冗余携带 content
      const { content: _omitted, ...rest } = finalPayload;
      finalPayload = { ...rest, markdown: { content: mdContent } };
    }

    const url = `${this.apiBase}/v2/users/${encodeURIComponent(openid)}/messages`;
    const res = await this.authedJsonRequest<QQSendMessageResponse>('POST', url, finalPayload);

    if (
      res.ok &&
      finalPayload.msg_type !== QQ_MSG_TYPE_INPUT_NOTIFY &&
      !meta?.skipAutoRecord &&
      res.body &&
      typeof res.body.id === 'string' &&
      res.body.id.trim() !== ''
    ) {
      const refIdx =
        typeof res.body.ext_info?.ref_idx === 'string' && res.body.ext_info.ref_idx.trim() !== ''
          ? res.body.ext_info.ref_idx.trim()
          : undefined;
      const peer = meta?.peer ?? openidToPeer(openid);
      const replyTo =
        meta?.replyTo !== undefined
          ? meta.replyTo
          : (finalPayload.message_reference?.message_id ?? null);
      const fallbackText =
        finalPayload.msg_type === QQ_MSG_TYPE_MARKDOWN
          ? finalPayload.markdown?.content
          : finalPayload.content;
      const text = meta?.text !== undefined ? meta.text : fallbackText;

      this.emitMessageSent({
        peer,
        openid,
        msgId: res.body.id,
        ...(refIdx ? { refIdx } : {}),
        replyTo: replyTo ?? null,
        msgType: finalPayload.msg_type as 0 | 2 | 7,
        ...(text !== undefined ? { text } : {}),
        payload: finalPayload,
        time: Date.now(),
        ...(meta?.attachments && meta.attachments.length > 0 ? { attachments: meta.attachments } : {}),
      });
    }

    return res;
  }

  /**
   * 发送单聊流式消息 (`POST /v2/users/{openid}/stream_messages`)。
   * 护栏：必须携带有效入站 `msg_id`（无 `msg_id` 必报 `50015001`）。
   */
  async sendC2CStreamMessage(
    openid: string,
    payload: QQStreamMessagePayload
  ): Promise<QQApiResult<QQStreamMessageResponse>> {
    if (!openid || typeof openid !== 'string' || !isValidOpenid(openid)) {
      return { ok: false, status: 400, message: '无效的目标 openid', body: null as any };
    }
    if (!payload?.msg_id || typeof payload.msg_id !== 'string' || payload.msg_id.trim() === '') {
      return {
        ok: false,
        status: 400,
        code: ERR_STREAM_MISSING_MSG_ID,
        message: '流式消息必须携带有效入站 msg_id（无 msg_id 必报 50015001）',
        body: null as any,
      };
    }

    const url = `${this.apiBase}/v2/users/${encodeURIComponent(openid)}/stream_messages`;
    return this.authedJsonRequest<QQStreamMessageResponse>('POST', url, payload);
  }

  /**
   * 发送单聊「正在输入」状态 (`msg_type=6`, `input_type=1`, `input_second=60`)。
   */
  async sendInputNotify(
    openid: string,
    msgId: string,
    msgSeq: number,
    inputSecond = QQ_INPUT_NOTIFY_MAX_SECONDS
  ): Promise<QQApiResult<QQSendMessageResponse>> {
    if (!msgId || typeof msgId !== 'string' || msgId.trim() === '') {
      return { ok: false, status: 400, message: 'sendInputNotify 必须提供有效入站 msgId', body: null as any };
    }
    const clampedSeconds = Math.min(QQ_INPUT_NOTIFY_MAX_SECONDS, Math.max(1, Math.floor(inputSecond)));
    return this.sendC2CMessage(
      openid,
      {
        msg_type: QQ_MSG_TYPE_INPUT_NOTIFY,
        input_notify: {
          input_type: 1,
          input_second: clampedSeconds,
        },
        msg_id: msgId,
        msg_seq: msgSeq,
      },
      { skipAutoRecord: true }
    );
  }

  /**
   * 撤回单聊出站消息 (`DELETE /v2/users/{openid}/messages/{message_id}`)。
   * 实测严格 120s 时限（超时 `40064004`，入站 ID `40061002`，幂等返回 `200 {}`）。
   */
  async deleteC2CMessage(
    openid: string,
    messageId: string,
    hidetip?: boolean
  ): Promise<QQApiResult<Record<string, unknown>>> {
    if (!openid || typeof openid !== 'string' || !isValidOpenid(openid)) {
      return { ok: false, status: 400, message: '无效的目标 openid', body: null as any };
    }
    if (!messageId || typeof messageId !== 'string' || messageId.trim() === '') {
      return { ok: false, status: 400, message: '无效的撤回 message_id', body: null as any };
    }
    const suffix = hidetip ? '?hidetip=true' : '';
    const url = `${this.apiBase}/v2/users/${encodeURIComponent(openid)}/messages/${encodeURIComponent(messageId)}${suffix}`;
    return this.authedJsonRequest<Record<string, unknown>>('DELETE', url);
  }

  /**
   * 单聊富媒体四步分片上传 (`upload_prepare` -> 裸 `PUT` -> `upload_part_finish` -> `/files`)。
   * 严格对齐实测报告 #4：
   * - `parts[].index` 1-based 升序排序；
   * - 累积 `offset` 切片；
   * - 每片使用自身 `block_size` 并向 `upload_part_finish` 上报该片真实 `block_size`；
   * - 裸 `PUT` 预签名 URL（不附鉴权头）；
   * - 结合 `(openid, md5, fileType)` 读写本地 `media_upload_cache` 24h 缓存，绝不假设服务端 MD5 秒传。
   */
  async uploadC2CMedia(
    openid: string,
    buffer: Buffer | Uint8Array,
    options: UploadC2CMediaOptions
  ): Promise<QQApiResult<QQFilesMergeResponse>> {
    try {
      if (!openid || typeof openid !== 'string' || !isValidOpenid(openid)) {
        return { ok: false, status: 400, message: '无效的目标 openid', body: null as any };
      }

      const bytes = buffer instanceof Uint8Array
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);

      if (bytes.length === 0) {
        return { ok: false, status: 400, message: '媒体文件为空，无法上传', body: null as any };
      }
      if (bytes.length > QQ_MEDIA_HARD_LIMIT) {
        return {
          ok: false,
          status: 400,
          message: `媒体文件大小 (${(bytes.length / 1024 / 1024).toFixed(2)}MB) 超过 200MB 硬上限`,
          body: null as any,
        };
      }

      const effectiveFileType = resolveEffectiveMediaFileType(options.fileType, bytes.length);
      const md5 = md5Hex(bytes);
      const sha1 = sha1Hex(bytes);
      const md510m = md5Hex(bytes.subarray(0, QQ_UPLOAD_MD5_10M_BYTES));

      // 1. 本地缓存检查（仅复用此前由服务端完整上传合并得到的 file_info，绝不假设服务端秒传）
      if (!options.bypassCache) {
        const cached = this.readMediaCache(openid, md5, effectiveFileType, options.db);
        if (cached) {
          this.log.debug?.(`[KujiraGateway] 命中本地 media_upload_cache (fileType=${effectiveFileType})`);
          return {
            ok: true,
            status: 200,
            body: {
              ...(cached.file_uuid ? { file_uuid: cached.file_uuid } : {}),
              file_info: cached.file_info,
              ttl: Math.max(1, Math.floor((cached.expires_at - Date.now()) / 1000)),
            },
          };
        }
      }

      const base = `${this.apiBase}/v2/users/${encodeURIComponent(openid)}`;

      // 2. Step 1: upload_prepare
      const prepareRes = await this.authedJsonRequest<QQUploadPrepareResponse>('POST', `${base}/upload_prepare`, {
        file_type: effectiveFileType,
        file_size: String(bytes.length),
        file_name: options.fileName,
        md5,
        sha1,
        md5_10m: md510m,
      });
      if (!prepareRes.ok) {
        return {
          ok: false,
          status: prepareRes.status,
          ...(prepareRes.code !== undefined ? { code: prepareRes.code } : {}),
          message: `upload_prepare 失败: ${this.sanitize(prepareRes.message ?? '')}`,
          body: prepareRes.body as any,
        };
      }

      const uploadId = prepareRes.body?.upload_id;
      const rawParts = Array.isArray(prepareRes.body?.parts) ? prepareRes.body.parts : [];
      if (typeof uploadId !== 'string' || uploadId === '' || rawParts.length === 0) {
        return {
          ok: false,
          status: 500,
          message: 'upload_prepare 响应缺少 upload_id 或 parts',
          body: prepareRes.body as any,
        };
      }

      const globalBlockSize = Number(prepareRes.body?.block_size ?? 0);
      // 实测硬规则：parts[].index 为 1-based，按 index 升序排序并累积 offset 切片
      const sortedParts = [...rawParts].sort((a, b) => Number(a.index) - Number(b.index));

      let offset = 0;
      for (const part of sortedParts) {
        if (offset >= bytes.length) break;
        const remaining = bytes.length - offset;
        const declaredSize = Number(part.block_size ?? globalBlockSize) || remaining;
        const take = Math.min(declaredSize, remaining);
        const chunk = bytes.subarray(offset, offset + take);
        offset += chunk.length;

        // 3. Step 2: 裸 PUT 分片二进制数据（不带 Authorization 或自定义头）
        const putRes = await this.rawRequest(
          part.presigned_url,
          { method: 'PUT', body: chunk },
          this.uploadPutTimeoutMs
        );
        if (!putRes.ok) {
          return {
            ok: false,
            status: putRes.status,
            message: `分片 #${part.index} PUT 上传失败 (status=${putRes.status})`,
            body: null as any,
          };
        }

        // 4. Step 3: upload_part_finish（必须上报该分片自身的实际 block_size）
        const finishRes = await this.authedJsonRequest('POST', `${base}/upload_part_finish`, {
          upload_id: uploadId,
          part_index: part.index,
          block_size: String(chunk.length),
          md5: md5Hex(chunk),
        });
        if (!finishRes.ok) {
          return {
            ok: false,
            status: finishRes.status,
            ...(finishRes.code !== undefined ? { code: finishRes.code } : {}),
            message: `upload_part_finish 分片 #${part.index} 失败: ${this.sanitize(finishRes.message ?? '')}`,
            body: finishRes.body as any,
          };
        }
      }

      if (offset !== bytes.length) {
        return {
          ok: false,
          status: 500,
          message: `分片上传覆盖不完整：已上传 ${offset}/${bytes.length} 字节`,
          body: null as any,
        };
      }

      // 5. Step 4: POST /files 合并获取 file_info
      const mergeRes = await this.authedJsonRequest<QQFilesMergeResponse>('POST', `${base}/files`, {
        upload_id: uploadId,
      });
      if (!mergeRes.ok) {
        return {
          ok: false,
          status: mergeRes.status,
          ...(mergeRes.code !== undefined ? { code: mergeRes.code } : {}),
          message: `文件合并失败: ${this.sanitize(mergeRes.message ?? '')}`,
          body: mergeRes.body as any,
        };
      }

      const fileInfo = mergeRes.body?.file_info;
      if (typeof fileInfo !== 'string' || fileInfo === '') {
        return {
          ok: false,
          status: 500,
          message: '文件合并响应缺少 file_info',
          body: mergeRes.body as any,
        };
      }

      const rawTtl = mergeRes.body?.ttl;
      if (rawTtl === undefined || (typeof rawTtl === 'number' && rawTtl > 0)) {
        const ttlSec = typeof rawTtl === 'number' && rawTtl > 0 ? rawTtl : DEFAULT_MEDIA_CACHE_TTL_SEC;
        const safetyMs = ttlSec > 120 ? QQ_TOKEN_REFRESH_MARGIN_MS : 0;
        const expiresAt = Date.now() + ttlSec * 1000 - safetyMs;
        this.writeMediaCache(
          {
            openid,
            md5,
            file_type: effectiveFileType,
            file_info: fileInfo,
            ...(mergeRes.body?.file_uuid ? { file_uuid: mergeRes.body.file_uuid } : {}),
            expires_at: expiresAt,
          },
          options.db
        );
      }

      return mergeRes;
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: this.sanitize(errorMessage(err)),
        body: null as any,
      };
    }
  }

  /** 下载入站附件（实测裸 GET 即可，无需鉴权头，错误与日志均脱敏去 query） */
  async fetchAttachment(
    url: string
  ): Promise<{ ok: boolean; status: number; bytes: Uint8Array; contentType: string | null; message?: string }> {
    const res = await this.rawRequest(url, { method: 'GET' }, this.requestTimeoutMs);
    return {
      ok: res.ok,
      status: res.status,
      bytes: res.bytes,
      contentType: res.contentType,
      ...(!res.ok ? { message: this.sanitize(res.text || `HTTP ${res.status}`) } : {}),
    };
  }

  private readMediaCache(
    openid: string,
    md5: string,
    fileType: number,
    db?: MediaUploadCacheStore
  ): MediaUploadCacheRecord | null {
    const now = Date.now();
    if (db?.getCachedMediaUpload) {
      try {
        const hit = db.getCachedMediaUpload(openid, md5, fileType);
        if (hit && hit.file_info && hit.expires_at > now) {
          return hit;
        }
      } catch (err) {
        this.log.warn?.(`[KujiraGateway] 读取 media_upload_cache 失败: ${this.sanitize(errorMessage(err))}`);
      }
      return null;
    }
    const key = `${openid}:${md5}:${fileType}`;
    const mem = this.memoryMediaCache.get(key);
    if (mem && mem.expires_at > now) {
      return mem;
    }
    if (mem) {
      this.memoryMediaCache.delete(key);
    }
    return null;
  }

  private writeMediaCache(record: MediaUploadCacheRecord, db?: MediaUploadCacheStore): void {
    if (db?.saveCachedMediaUpload) {
      try {
        db.saveCachedMediaUpload(record);
      } catch (err) {
        this.log.warn?.(`[KujiraGateway] 写入 media_upload_cache 失败: ${this.sanitize(errorMessage(err))}`);
      }
      return;
    }
    const key = `${record.openid}:${record.md5}:${record.file_type}`;
    this.memoryMediaCache.set(key, record);
  }
}
