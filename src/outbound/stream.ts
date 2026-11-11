/**
 * kujira: QQ 官方 Bot 单聊出站调度中枢与安全流式管理器
 *
 * 核心原则与能力：
 * 1. 用户侧静默原则：`start()` 与 `handleSessionEvent()` 绝对静默空转，不自动监听 `session/event` 偷发文本；
 * 2. 内存 + DB 兜底入站 `msg_id` 锚点：优先内存活跃回合真实入站 `d.id`，次查 `db.getLatestValidInboundSlot(peer)`；
 *    `is_synthetic: true` 的系统唤醒绝不清除历史有效入站 `msg_id`；出站 `body.id` 绝不污染入站锚点；
 * 3. 共享 per-`msg_id` `msg_seq` 槽位分配器：优先持久化 `db.allocateNextMsgSeq` 防跨重启撞槽；
 *    遇 `40054005` 自动递进重试；遇 `40034128` / `40034024` 标记旧锚点失效并自动降级为无 `msg_id` 主动消息；
 * 4. 统一出站原语：
 *    - `sendTextReply`（按 `markdown_enabled` 走 `msg_type=2`+`normalizeQqMarkdown` 或 `msg_type=0`+`stripMarkdown`，
 *      按 `QQ_MESSAGE_MAX_BYTES` UTF-8 字节切分，仅首片附 `message_reference` `REFIDX_...`）；
 *    - `sendMediaReply`（四步分片上传 + `msg_type=7`）；
 *    - `sendInputNotifyIfEnabled`（`msg_type=6` 占用 1 个 `msg_seq` 槽位）；
 *    - `recallMessage`（调 `deleteC2CMessage` 并在成功后 `markRecalled`）；
 *    - `openStreamSession` 安全流式护栏（必须有入站 `msg_id` 否则拒绝调流式避开 `50015001`、仅 `append`、
 *      按 `QQ_STREAM_REQUEST_MAX_BYTES` 8 KiB UTF-8 字节分片，失败时余量回退普通消息绝不丢字）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { AttachmentDescriptor, AttachmentKind } from '../attachment/types.js';
import {
  DEFAULT_INPUT_NOTIFY_ENABLED,
  DEFAULT_MARKDOWN_ENABLED,
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_MESSAGE_MAX_BYTES,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_MSG_TYPE_MEDIA,
  QQ_MSG_TYPE_TEXT,
  QQ_STREAM_REQUEST_MAX_BYTES,
  QQ_STREAM_THROTTLE_MS,
} from '../constants/index.js';
import type {
  MediaUploadCacheStore,
  OutboundSendMeta,
  OutboundSentEvent,
  UploadC2CMediaOptions,
} from '../gateway/server.js';
import type { OutboundBridgeLike } from '../gateway/session/types.js';
import type {
  BridgePluginConfig,
  InboundReplyContext,
  InboundReplySlot,
  MessageRecord,
  QQApiResult,
  QQFilesMergeResponse,
  QQMediaFileType,
  QQSendMessagePayload,
  QQSendMessageResponse,
  QQStreamMessagePayload,
  QQStreamMessageResponse,
  WakeupPayload,
} from '../types/index.js';
import { PerPeerSerialSender } from './queue.js';
import { normalizeQqMarkdown, splitByUtf8Bytes, stripMarkdown } from './render.js';

export const QQ_STREAM_INPUT_STATE_GENERATING = 1 as const;
export const QQ_STREAM_INPUT_STATE_FINISHED = 10 as const;

const ERR_DEDUPED_MSG_SEQ = '40054005';
const ERR_PASSIVE_EXPIRED_OR_LIMIT = '40034128';
const ERR_INVALID_MSG_ID = '40034024';
const ERR_STREAM_NO_MSG_ID = 50015001;
const DEFAULT_MAX_DEDUPE_RETRIES = 10;

export interface OutboundLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
}

export interface KujiraGatewayClientLike {
  sendC2CMessage(
    openid: string,
    payload: QQSendMessagePayload,
    meta?: OutboundSendMeta
  ): Promise<QQApiResult<QQSendMessageResponse>>;
  sendC2CStreamMessage(
    openid: string,
    payload: QQStreamMessagePayload
  ): Promise<QQApiResult<QQStreamMessageResponse>>;
  sendInputNotify(
    openid: string,
    msgId: string,
    msgSeq: number,
    inputSecond?: number
  ): Promise<QQApiResult<QQSendMessageResponse>>;
  deleteC2CMessage(
    openid: string,
    messageId: string,
    hidetip?: boolean
  ): Promise<QQApiResult<Record<string, unknown>>>;
  uploadC2CMedia(
    openid: string,
    buffer: Buffer | Uint8Array,
    options: UploadC2CMediaOptions
  ): Promise<QQApiResult<QQFilesMergeResponse>>;
  emitMessageSent?(event: OutboundSentEvent): void;
}

export interface SessionManagerLike {
  dispatchWakeup?(
    payload: WakeupPayload,
    options?: { onMessageCreated?: (userMsg: any) => void }
  ): Promise<any>;
  getOutboundBridge?(): OutboundBridgeLike | undefined;
  setOutboundBridge?(bridge: OutboundBridgeLike): void;
  sessionIdToPeer?(sessionId: string): string;
}

/** 持久化存储抽象：与 Batch 2A 升级后的 MessageDatabase 完全对齐 */
export interface OutboundSlotDb extends MediaUploadCacheStore {
  getOpenidByPeer?(peer: string): string | null;
  getLatestValidInboundSlot?(peer: string): InboundReplySlot | null;
  allocateNextMsgSeq?(msgId: string, seed?: { peer: string; openid: string }): number;
  advanceMsgSeq?(msgId: string, minNextSeq: number): number | void;
  markInboundSlotInvalidated?(msgId: string): void;
  getMessage?(msgId: string): MessageRecord | null;
  getMessageByRefIdx?(refIdx: string): MessageRecord | null;
  markRecalled?(msgId: string): void;
}

export type InboundReplyContextInput =
  | InboundReplyContext
  | {
      msg_id?: string | undefined;
      ref_idx?: string | undefined;
      openid?: string | undefined;
      from_user?: string;
      trigger?: string;
      is_synthetic?: boolean;
      synthetic?: boolean;
    };

export interface SendTextReplyOptions {
  /** 引用目标（REFIDX_... 或本地库中的 msg_id） */
  replyTo?: string;
  /** 是否以原生 Markdown (`msg_type=2`) 发送，缺省取配置 `markdown_enabled` */
  markdown?: boolean;
  /** 显式覆盖目标 openid */
  openid?: string;
  /** 显式覆盖入站被动锚点 msg_id */
  msgId?: string;
}

export interface SendMediaReplyInput {
  buffer?: Buffer | Uint8Array;
  filePath?: string;
  fileType: QQMediaFileType;
  fileName: string;
  attachments?: AttachmentDescriptor[];
  textSummary?: string;
}

export interface SendMediaReplyOptions {
  openid?: string;
  msgId?: string;
  replyTo?: string;
}

export interface OpenStreamOptions {
  openid?: string;
  msgId?: string;
  throttleMs?: number;
}

export interface OutboundStreamBridgeOptions {
  gateway?: KujiraGatewayClientLike;
  sessionManager?: SessionManagerLike;
  db?: OutboundSlotDb;
  getConfig?: () => BridgePluginConfig;
  maxDedupeRetries?: number;
  streamThrottleMs?: number;
  logger?: OutboundLogger;
}

/**
 * 从模型输出的 ContentBlock 数组中提取正式回复 TextBlock，
 * 坚决过滤思考过程 (reasoning)、工具调用 (tool-call)、工具结果 (tool-result) 等非正文块。
 */
export function filterAndExtractOutboundBlocks(
  blocks: ContentBlock[]
): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(blocks)) {
    return [];
  }

  const results: Array<{ type: 'text'; text: string }> = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text' && typeof (block as any).text === 'string') {
      const text = (block as any).text;
      if (text.length > 0) {
        results.push({ type: 'text', text });
      }
    }
  }
  return results;
}

/**
 * 共享 per-`msg_id` `msg_seq` 槽位分配器。
 * 优先委托 SQLite `allocateNextMsgSeq` 持久化单调递增（防止进程重启后撞上跨天残留去重）；
 * 无 DB 时回退内存单调计数器。遇 `40054005` 时调用 `advance` 递增跳过已占用槽位。
 */
export class MsgSeqSlotAllocator {
  private readonly counters = new Map<string, number>();

  constructor(private readonly db?: OutboundSlotDb) {}

  allocate(msgId: string, seed?: { peer: string; openid: string }): number {
    if (this.db?.allocateNextMsgSeq) {
      const dbSeq = this.db.allocateNextMsgSeq(msgId, seed);
      const prev = this.counters.get(msgId) ?? 0;
      const effective = Math.max(prev + 1, dbSeq);
      this.counters.set(msgId, effective);
      return dbSeq > 0 ? dbSeq : effective;
    }
    const next = (this.counters.get(msgId) ?? 0) + 1;
    this.counters.set(msgId, next);
    return next;
  }

  advance(msgId: string, failedSeq: number, seed?: { peer: string; openid: string }): number {
    const targetFloor = Math.max(this.counters.get(msgId) ?? 0, failedSeq) + 1;
    if (this.db?.advanceMsgSeq) {
      const res = this.db.advanceMsgSeq(msgId, targetFloor);
      if (typeof res === 'number' && Number.isFinite(res) && res > failedSeq) {
        this.counters.set(msgId, Math.max(targetFloor, res));
        return res;
      }
    }
    if (this.db?.allocateNextMsgSeq) {
      let candidate = this.db.allocateNextMsgSeq(msgId, seed);
      let guard = 0;
      while (candidate <= failedSeq && guard < 32) {
        candidate = this.db.allocateNextMsgSeq(msgId, seed);
        guard += 1;
      }
      if (candidate > failedSeq) {
        this.counters.set(msgId, Math.max(targetFloor, candidate));
        return candidate;
      }
    }
    this.counters.set(msgId, targetFloor);
    return targetFloor;
  }

  clear(): void {
    this.counters.clear();
  }
}

function isPassiveAnchorError(res: QQApiResult): boolean {
  const code = res.code !== undefined ? String(res.code) : '';
  return code === ERR_PASSIVE_EXPIRED_OR_LIMIT || code === ERR_INVALID_MSG_ID;
}

function isDedupeError(res: QQApiResult): boolean {
  return res.code !== undefined && String(res.code) === ERR_DEDUPED_MSG_SEQ;
}

function fileTypeToAttachmentKind(fileType: QQMediaFileType): AttachmentKind {
  switch (fileType) {
    case QQ_FILE_TYPE_IMAGE:
      return 'image';
    case QQ_FILE_TYPE_VIDEO:
      return 'video';
    case QQ_FILE_TYPE_AUDIO:
      return 'record';
    case QQ_FILE_TYPE_FILE:
    default:
      return 'file';
  }
}

export interface KujiraStreamSessionOptions {
  gateway: KujiraGatewayClientLike;
  slots: MsgSeqSlotAllocator;
  peer: string;
  openid: string;
  msgId: string;
  msgSeq: number;
  markdownEnabled: boolean;
  throttleMs?: number;
  maxDedupeRetries?: number;
  onInvalidateAnchor?: (msgId: string) => void;
  onFinishEmit?: (event: OutboundSentEvent) => void;
  logger?: OutboundLogger;
}

/**
 * 单段单聊流式输出会话（安全护栏封装）：
 * - 强制要求入站 `msgId`（拒绝无 `msgId` 触发 `50015001`）；
 * - 固定 `input_mode: 'append'`（规避 `40007`）；
 * - 单片严格按 `QQ_STREAM_REQUEST_MAX_BYTES` (8 KiB) UTF-8 字节边界切分；
 * - 失败时在 `finish()` 自动将未送达余量回退为普通单聊消息，绝不静默丢内容。
 */
export class KujiraStreamSession {
  private readonly gateway: KujiraGatewayClientLike;
  private readonly slots: MsgSeqSlotAllocator;
  private readonly peer: string;
  private readonly openid: string;
  private readonly msgId: string;
  private msgSeq: number;
  private readonly markdownEnabled: boolean;
  private readonly throttleMs: number;
  private readonly maxDedupeRetries: number;
  private readonly onInvalidateAnchor?: (msgId: string) => void;
  private readonly onFinishEmit?: (event: OutboundSentEvent) => void;
  private readonly logger?: OutboundLogger;

  private buffer = '';
  private sentFormatted = '';
  private index = 0;
  private streamMsgId?: string;
  private lastFlushTime: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private failed = false;
  private anchorInvalidated = false;
  private finished = false;

  constructor(options: KujiraStreamSessionOptions) {
    this.gateway = options.gateway;
    this.slots = options.slots;
    this.peer = options.peer;
    this.openid = options.openid;
    this.msgId = options.msgId;
    this.msgSeq = options.msgSeq;
    this.markdownEnabled = options.markdownEnabled;
    this.throttleMs = options.throttleMs ?? QQ_STREAM_THROTTLE_MS;
    this.maxDedupeRetries = options.maxDedupeRetries ?? DEFAULT_MAX_DEDUPE_RETRIES;
    this.onInvalidateAnchor = options.onInvalidateAnchor;
    this.onFinishEmit = options.onFinishEmit;
    this.logger = options.logger;
  }

  get ended(): boolean {
    return this.finished;
  }

  get sentText(): string {
    return this.sentFormatted;
  }

  get currentMsgSeq(): number {
    return this.msgSeq;
  }

  async push(delta: string): Promise<void> {
    if (this.finished || !delta) return;
    // 即使流式失败也要继续累积正文，确保 finish() 完整回退不丢字
    this.buffer += delta;
    if (this.failed) return;

    const now = Date.now();
    const elapsed = this.lastFlushTime === null ? Number.POSITIVE_INFINITY : now - this.lastFlushTime;
    if (elapsed >= this.throttleMs) {
      await this.requestFlush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.requestFlush();
      }, Math.max(0, this.throttleMs - elapsed));
    }
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }

    if (finalText !== undefined) {
      this.buffer = finalText;
    }

    const formatted = this.formatText(this.buffer);
    if (formatted.trim().length === 0) {
      if (this.failed) {
        this.logger?.warn?.('[KujiraOutbound] 流式已失败且无非空正文可供回退');
      }
      return;
    }

    if (this.failed) {
      await this.sendFallbackRemainder(formatted.slice(this.sentFormatted.length));
      return;
    }

    const pending = formatted.slice(this.sentFormatted.length);
    const chunks = pending ? splitByUtf8Bytes(pending, QQ_STREAM_REQUEST_MAX_BYTES) : [];

    if (chunks.length === 0) {
      // 正文已全部流式发出，补发空结束帧 (input_state=10) 通知客户端结束气泡动画
      const ok = await this.sendStreamChunk('', QQ_STREAM_INPUT_STATE_FINISHED);
      if (ok && this.streamMsgId) {
        this.emitCompletedRecord(formatted);
      }
      return;
    }

    let delivered = this.sentFormatted;
    for (const [i, chunk] of chunks.entries()) {
      const state = i === chunks.length - 1 ? QQ_STREAM_INPUT_STATE_FINISHED : QQ_STREAM_INPUT_STATE_GENERATING;
      const ok = await this.sendStreamChunk(chunk, state);
      if (!ok) {
        await this.sendFallbackRemainder(formatted.slice(delivered.length));
        return;
      }
      delivered += chunk;
    }
    this.sentFormatted = formatted;
    if (this.streamMsgId) {
      this.emitCompletedRecord(formatted);
    }
  }

  private emitCompletedRecord(formatted: string): void {
    if (!this.streamMsgId || !this.onFinishEmit) return;
    this.onFinishEmit({
      peer: this.peer,
      openid: this.openid,
      msgId: this.streamMsgId,
      msgType: this.markdownEnabled ? QQ_MSG_TYPE_MARKDOWN : QQ_MSG_TYPE_TEXT,
      text: formatted,
      payload: { stream_msg_id: this.streamMsgId, text: formatted },
      time: Date.now(),
    });
  }

  private requestFlush(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = (async () => {
      do {
        this.rerun = false;
        try {
          await this.flushPending();
        } catch (err) {
          this.markFailed(err instanceof Error ? err.message : String(err));
        }
      } while (this.rerun && !this.finished && !this.failed);
    })();
    this.inFlight = run;
    const clear = () => {
      if (this.inFlight === run) this.inFlight = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private async flushPending(): Promise<void> {
    if (this.finished || this.failed) return;
    const formatted = this.formatText(this.buffer);
    if (formatted === this.sentFormatted) return;

    const pending = formatted.slice(this.sentFormatted.length);
    const chunks = splitByUtf8Bytes(pending, QQ_STREAM_REQUEST_MAX_BYTES);
    let delivered = this.sentFormatted;
    for (const chunk of chunks) {
      const ok = await this.sendStreamChunk(chunk, QQ_STREAM_INPUT_STATE_GENERATING);
      if (!ok) {
        this.sentFormatted = delivered;
        return;
      }
      delivered += chunk;
    }
    this.sentFormatted = delivered;
    this.lastFlushTime = Date.now();
  }

  private async sendStreamChunk(contentRaw: string, inputState: 1 | 10): Promise<boolean> {
    if (!this.msgId || this.msgId.trim() === '') {
      this.markFailed(`缺少入站 msg_id，拒绝调用 stream_messages (${ERR_STREAM_NO_MSG_ID})`);
      return false;
    }

    const chunkIndex = this.index;
    this.index += 1;

    const contentType = this.markdownEnabled ? 'markdown' : 'text';
    let attempt = 0;

    while (true) {
      const payload: QQStreamMessagePayload = {
        input_mode: 'append',
        input_state: inputState,
        index: chunkIndex,
        content_type: contentType,
        content_raw: contentRaw,
        msg_id: this.msgId,
        msg_seq: this.msgSeq,
        ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      };

      const res = await this.gateway.sendC2CStreamMessage(this.openid, payload);
      if (res.ok) {
        if (!this.streamMsgId && res.body?.id) {
          this.streamMsgId = res.body.id;
        }
        return true;
      }

      // 仅当首片尚无内容下发时遇到 40054005，可换新 msg_seq 重试
      if (isDedupeError(res) && !this.streamMsgId && attempt < this.maxDedupeRetries) {
        attempt += 1;
        this.msgSeq = this.slots.advance(this.msgId, this.msgSeq, { peer: this.peer, openid: this.openid });
        this.logger?.warn?.(
          `[KujiraOutbound] 流式首片遇 40054005 去重，切换 msg_seq=${this.msgSeq} 重试`
        );
        continue;
      }

      if (isPassiveAnchorError(res)) {
        this.anchorInvalidated = true;
        this.onInvalidateAnchor?.(this.msgId);
      }
      this.markFailed(`code=${String(res.code ?? 'n/a')} status=${res.status} ${res.message ?? ''}`);
      return false;
    }
  }

  private async sendFallbackRemainder(remainder: string): Promise<void> {
    if (!remainder || remainder.trim() === '') return;
    const parts = splitByUtf8Bytes(remainder, QQ_MESSAGE_MAX_BYTES);
    let usePassive = !this.anchorInvalidated && Boolean(this.msgId);
    const seed = { peer: this.peer, openid: this.openid };

    for (const part of parts) {
      let attempt = 0;
      while (true) {
        const seq = usePassive ? this.slots.allocate(this.msgId, seed) : undefined;
        const payload: QQSendMessagePayload = this.markdownEnabled
          ? {
              msg_type: QQ_MSG_TYPE_MARKDOWN,
              markdown: { content: part },
              ...(usePassive && seq !== undefined ? { msg_id: this.msgId, msg_seq: seq } : {}),
            }
          : {
              msg_type: QQ_MSG_TYPE_TEXT,
              content: part,
              ...(usePassive && seq !== undefined ? { msg_id: this.msgId, msg_seq: seq } : {}),
            };

        const res = await this.gateway.sendC2CMessage(this.openid, payload, {
          peer: this.peer,
          text: part,
        });
        if (res.ok) break;

        if (usePassive && isDedupeError(res) && attempt < this.maxDedupeRetries) {
          attempt += 1;
          // 下一轮循环 allocate 会取得更大 seq；此处额外 advance 防跳格不一致
          this.slots.advance(this.msgId, seq!, seed);
          continue;
        }
        if (usePassive && isPassiveAnchorError(res)) {
          usePassive = false;
          this.anchorInvalidated = true;
          this.onInvalidateAnchor?.(this.msgId);
          continue;
        }
        this.logger?.error?.(
          `[KujiraOutbound] 流式回退普通消息失败: code=${String(res.code ?? 'n/a')} status=${res.status}`
        );
        break;
      }
    }
  }

  private formatText(raw: string): string {
    return this.markdownEnabled ? normalizeQqMarkdown(raw) : stripMarkdown(raw);
  }

  private markFailed(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.logger?.warn?.(`[KujiraOutbound] 流式输出终止，余量将回退普通消息: ${reason}`);
  }
}

interface InboundAnchorRecord {
  msg_id: string;
  ref_idx?: string;
  from_user?: string;
  openid?: string;
}

/**
 * Kujira 单聊出站调度中枢（同时保持与 SessionManager OutboundBridgeLike 契约兼容）。
 */
export class OutboundStreamBridge implements OutboundBridgeLike {
  private readonly sender: PerPeerSerialSender;
  private readonly slots: MsgSeqSlotAllocator;
  private readonly inboundContexts = new Map<string, InboundReplyContextInput>();
  private readonly latestInboundAnchors = new Map<string, InboundAnchorRecord>();
  private readonly peerToOpenid = new Map<string, string>();
  private readonly activeStreams = new Map<string, KujiraStreamSession>();
  private readonly maxDedupeRetries: number;
  private readonly streamThrottleMs: number;
  private unlisten: (() => void) | null = null;

  constructor(
    _ctx: Context,
    private readonly options: OutboundStreamBridgeOptions = {}
  ) {
    this.sender = new PerPeerSerialSender();
    this.slots = new MsgSeqSlotAllocator(options.db);
    this.maxDedupeRetries = options.maxDedupeRetries ?? DEFAULT_MAX_DEDUPE_RETRIES;
    this.streamThrottleMs = options.streamThrottleMs ?? QQ_STREAM_THROTTLE_MS;
    if (typeof this.options.sessionManager?.setOutboundBridge === 'function') {
      this.options.sessionManager.setOutboundBridge(this);
    }
  }

  getSender(): PerPeerSerialSender {
    return this.sender;
  }

  getActiveTurn(_peer: string): number | undefined {
    return undefined;
  }

  private normalizePeerKey(peer: string): string {
    if (!peer) return '';
    return this.options.sessionManager?.sessionIdToPeer
      ? this.options.sessionManager.sessionIdToPeer(peer)
      : peer;
  }

  /** 注册 peer <-> openid 内存缓存（优先数据库 peer_openid_map） */
  registerPeerOpenid(peer: string, openid: string): void {
    const key = this.normalizePeerKey(peer);
    if (key && openid) {
      this.peerToOpenid.set(key, openid);
    }
  }

  resolveOpenid(peer: string): string | undefined {
    const key = this.normalizePeerKey(peer);
    if (!key) return undefined;
    const fromDb = this.options.db?.getOpenidByPeer?.(key);
    if (fromDb && fromDb.trim() !== '') {
      return fromDb.trim();
    }
    return this.peerToOpenid.get(key) ?? this.peerToOpenid.get(peer);
  }

  /**
   * 登记入站回复上下文：
   * - 真实用户入站事件（`!is_synthetic` 且带有字符串 `msg_id`）会更新内存锚点；
   * - 系统合成事件（`is_synthetic: true`，如 scheduled_task）绝不得清除或覆盖历史有效入站 `msg_id`。
   */
  trackInboundContext(peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    const key = this.normalizePeerKey(peer);
    const isSynthetic = Boolean((context as any).is_synthetic || (context as any).synthetic);

    if ((context as any).openid && typeof (context as any).openid === 'string') {
      this.peerToOpenid.set(key, (context as any).openid);
    }

    if (isSynthetic) {
      const existingCtx = this.inboundContexts.get(key);
      const preservedAnchor = this.latestInboundAnchors.get(key);
      const preservedMsgId =
        (typeof existingCtx?.msg_id === 'string' && existingCtx.msg_id.trim() !== ''
          ? existingCtx.msg_id
          : undefined) ?? preservedAnchor?.msg_id;
      const preservedRefIdx =
        (typeof (existingCtx as any)?.ref_idx === 'string'
          ? (existingCtx as any).ref_idx
          : undefined) ?? preservedAnchor?.ref_idx;

      this.inboundContexts.set(key, {
        ...context,
        ...(preservedMsgId ? { msg_id: preservedMsgId } : {}),
        ...(preservedRefIdx ? { ref_idx: preservedRefIdx } : {}),
      });
      return;
    }

    this.inboundContexts.set(key, context);
    const msgId = typeof context.msg_id === 'string' ? context.msg_id.trim() : '';
    if (msgId) {
      const refIdx = typeof (context as any).ref_idx === 'string' ? (context as any).ref_idx.trim() : undefined;
      const openid = typeof (context as any).openid === 'string' ? (context as any).openid.trim() : undefined;
      this.latestInboundAnchors.set(key, {
        msg_id: msgId,
        ...(refIdx ? { ref_idx: refIdx } : {}),
        ...(context.from_user ? { from_user: context.from_user } : {}),
        ...(openid ? { openid } : {}),
      });
    }
  }

  trackPendingMessage(_messageId: string, peer: string, context: InboundReplyContextInput): void {
    this.trackInboundContext(peer, context);
  }

  updateActiveTurnContext(peer: string, context: InboundReplyContextInput): void {
    if (!peer || !context) return;
    if ((context as any).is_synthetic || (context as any).synthetic) {
      return;
    }
    this.trackInboundContext(peer, context);
  }

  getActiveTurnContext(peer: string): InboundReplyContextInput | undefined {
    if (!peer) return undefined;
    const key = this.normalizePeerKey(peer);
    return this.inboundContexts.get(peer) ?? this.inboundContexts.get(key);
  }

  getInboundContext(peer: string): InboundReplyContextInput | undefined {
    return this.getActiveTurnContext(peer);
  }

  /**
   * 获取指定 peer 当前可用的入站被动回复锚点 `msg_id`：
   * 1. 优先取内存活跃回合/最新有效真实入站 `d.id`；
   * 2. 次取 SQLite `inbound_reply_slots` 最新未失效记录 (`getLatestValidInboundSlot`)。
   */
  resolvePassiveMsgId(peer: string): string | undefined {
    const key = this.normalizePeerKey(peer);
    if (!key) return undefined;

    const fromMem = this.latestInboundAnchors.get(key)?.msg_id;
    if (fromMem && fromMem.trim() !== '') {
      return fromMem.trim();
    }

    const fromDb = this.options.db?.getLatestValidInboundSlot?.(key);
    if (fromDb && !fromDb.invalidated && typeof fromDb.msg_id === 'string' && fromDb.msg_id.trim() !== '') {
      this.latestInboundAnchors.set(key, {
        msg_id: fromDb.msg_id.trim(),
        openid: fromDb.openid,
      });
      if (fromDb.openid) {
        this.peerToOpenid.set(key, fromDb.openid);
      }
      return fromDb.msg_id.trim();
    }

    return undefined;
  }

  private invalidateInboundAnchor(peer: string, msgId: string): void {
    const key = this.normalizePeerKey(peer);
    const mem = this.latestInboundAnchors.get(key);
    if (mem && mem.msg_id === msgId) {
      this.latestInboundAnchors.delete(key);
    }
    const ctx = this.inboundContexts.get(key);
    if (ctx && ctx.msg_id === msgId) {
      const { msg_id: _dropped, ...rest } = ctx;
      this.inboundContexts.set(key, rest);
    }
    try {
      this.options.db?.markInboundSlotInvalidated?.(msgId);
    } catch (err) {
      this.options.logger?.warn?.('[KujiraOutbound] markInboundSlotInvalidated 失败:', err);
    }
  }

  private resolveQuoteRefIdx(replyTo?: string): { refIdx?: string; replyMsgId?: string } {
    if (!replyTo || typeof replyTo !== 'string') return {};
    const trimmed = replyTo.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith('REFIDX_')) {
      const matched = this.options.db?.getMessageByRefIdx?.(trimmed);
      return {
        refIdx: trimmed,
        replyMsgId: matched?.msg_id ?? trimmed,
      };
    }
    const row = this.options.db?.getMessage?.(trimmed);
    const refIdx =
      row?.ref_idx && typeof row.ref_idx === 'string' && row.ref_idx.startsWith('REFIDX_')
        ? row.ref_idx
        : undefined;
    return {
      ...(refIdx ? { refIdx } : {}),
      replyMsgId: trimmed,
    };
  }

  private async endActiveStream(peerKey: string): Promise<void> {
    const session = this.activeStreams.get(peerKey);
    if (!session) return;
    if (!session.ended) {
      await session.finish();
    }
    if (this.activeStreams.get(peerKey) === session) {
      this.activeStreams.delete(peerKey);
    }
  }

  isStreaming(peer: string): boolean {
    const key = this.normalizePeerKey(peer);
    const session = this.activeStreams.get(key);
    return session !== undefined && !session.ended;
  }

  /**
   * 为指定单聊开启流式会话（安全护栏）：
   * - 必须存在有效入站 `msg_id` 且已装配 `gateway` 与 `openid`；无 `msg_id` 时返回 `null` 彻底避免 `50015001`；
   * - 共享 per-`msg_id` `msg_seq` 槽位分配器。
   */
  openStreamSession(peer: string, options: OpenStreamOptions = {}): KujiraStreamSession | null {
    const gateway = this.options.gateway;
    if (!gateway) return null;

    const key = this.normalizePeerKey(peer);
    const existing = this.activeStreams.get(key);
    if (existing && !existing.ended) return null;

    const openid = options.openid ?? this.resolveOpenid(key);
    const msgId = options.msgId ?? this.resolvePassiveMsgId(key);
    if (!openid || !msgId) {
      return null;
    }

    const msgSeq = this.slots.allocate(msgId, { peer: key, openid });
    const markdownEnabled = this.options.getConfig?.().markdown_enabled ?? DEFAULT_MARKDOWN_ENABLED;
    const session = new KujiraStreamSession({
      gateway,
      slots: this.slots,
      peer: key,
      openid,
      msgId,
      msgSeq,
      markdownEnabled,
      throttleMs: options.throttleMs ?? this.streamThrottleMs,
      maxDedupeRetries: this.maxDedupeRetries,
      onInvalidateAnchor: (badMsgId) => this.invalidateInboundAnchor(key, badMsgId),
      onFinishEmit: (event) => gateway.emitMessageSent?.(event),
      logger: this.options.logger,
    });
    this.activeStreams.set(key, session);
    return session;
  }

  /**
   * 向单聊发送文本/Markdown 回复（经由 per-peer 串行队列）：
   * - `markdown_enabled=true` -> `msg_type=2` + `normalizeQqMarkdown`
   * - `markdown_enabled=false` -> `msg_type=0` + `stripMarkdown`
   * - 严格按 `QQ_MESSAGE_MAX_BYTES` (16 KiB) UTF-8 字节边界分片发送，仅首片附 `message_reference`
   * - 自动处理 `40054005`（换新 `msg_seq` 重试）与 `40034128`/`40034024`（失效锚点并降级主动消息）
   */
  sendTextReply(
    peer: string,
    text: string,
    options: SendTextReplyOptions = {}
  ): Promise<QQApiResult<QQSendMessageResponse>> {
    const key = this.normalizePeerKey(peer);
    return this.sender.enqueue(key, async () => {
      const gateway = this.options.gateway;
      if (!gateway) {
        return { ok: false, status: 503, message: 'QQ Gateway 未连接', body: null as any };
      }

      await this.endActiveStream(key);

      const openid = options.openid ?? this.resolveOpenid(key);
      if (!openid) {
        return { ok: false, status: 400, message: `无法解析会话 ${key} 的 QQ openid`, body: null as any };
      }

      const useMarkdown =
        options.markdown ?? this.options.getConfig?.().markdown_enabled ?? DEFAULT_MARKDOWN_ENABLED;
      const formatted = useMarkdown ? normalizeQqMarkdown(text) : stripMarkdown(text);
      if (formatted.trim() === '') {
        return { ok: false, status: 400, message: '发送内容不能为空', body: null as any };
      }

      const chunks = splitByUtf8Bytes(formatted, QQ_MESSAGE_MAX_BYTES);
      const { refIdx, replyMsgId } = this.resolveQuoteRefIdx(options.replyTo);
      let passiveMsgId: string | undefined = options.msgId ?? this.resolvePassiveMsgId(key);
      let lastResult: QQApiResult<QQSendMessageResponse> = {
        ok: false,
        status: 500,
        message: '未执行发送',
        body: null as any,
      };

      for (const [i, chunk] of chunks.entries()) {
        const isFirst = i === 0;
        const sendOutcome = await this.sendSingleWithSlotAndFallback(
          key,
          openid,
          passiveMsgId,
          (msgId, msgSeq) => ({
            msg_type: useMarkdown ? QQ_MSG_TYPE_MARKDOWN : QQ_MSG_TYPE_TEXT,
            ...(useMarkdown ? { markdown: { content: chunk } } : { content: chunk }),
            ...(isFirst && refIdx ? { message_reference: { message_id: refIdx } } : {}),
            ...(msgId && msgSeq !== undefined ? { msg_id: msgId, msg_seq: msgSeq } : {}),
          }),
          {
            peer: key,
            replyTo: isFirst ? (replyMsgId ?? null) : null,
            text: chunk,
          }
        );

        passiveMsgId = sendOutcome.nextPassiveMsgId;
        lastResult = sendOutcome.result;
        if (!lastResult.ok) {
          return lastResult;
        }
      }

      return lastResult;
    });
  }

  /**
   * 向单聊发送富媒体（四步分片上传 + `msg_type=7`），共享 `MsgSeqSlotAllocator` 与主动降级能力。
   */
  sendMediaReply(
    peer: string,
    media: SendMediaReplyInput,
    options: SendMediaReplyOptions = {}
  ): Promise<QQApiResult<QQSendMessageResponse>> {
    const key = this.normalizePeerKey(peer);
    return this.sender.enqueue(key, async () => {
      const gateway = this.options.gateway;
      if (!gateway) {
        return { ok: false, status: 503, message: 'QQ Gateway 未连接', body: null as any };
      }

      await this.endActiveStream(key);

      const openid = options.openid ?? this.resolveOpenid(key);
      if (!openid) {
        return { ok: false, status: 400, message: `无法解析会话 ${key} 的 QQ openid`, body: null as any };
      }

      let bytes: Buffer | Uint8Array | undefined = media.buffer;
      if (!bytes && media.filePath) {
        try {
          bytes = fs.readFileSync(path.resolve(media.filePath));
        } catch (err) {
          return {
            ok: false,
            status: 400,
            message: `读取本地媒体文件失败: ${err instanceof Error ? err.message : String(err)}`,
            body: null as any,
          };
        }
      }
      if (!bytes || bytes.length === 0) {
        return { ok: false, status: 400, message: '媒体文件为空或未提供 buffer/filePath', body: null as any };
      }

      const uploadRes = await gateway.uploadC2CMedia(openid, bytes, {
        fileType: media.fileType,
        fileName: media.fileName,
        db: this.options.db,
      });
      if (!uploadRes.ok || !uploadRes.body?.file_info) {
        return {
          ok: false,
          status: uploadRes.status,
          ...(uploadRes.code !== undefined ? { code: uploadRes.code } : {}),
          message: uploadRes.message ?? '富媒体上传失败',
          body: uploadRes.body as any,
        };
      }

      const fileInfo = uploadRes.body.file_info;
      const fileUuid = uploadRes.body.file_uuid;
      const attachments: AttachmentDescriptor[] =
        media.attachments && media.attachments.length > 0
          ? media.attachments
          : [
              {
                kind: fileTypeToAttachmentKind(media.fileType),
                origin: 'outbound',
                ...(media.filePath ? { local: { path: media.filePath } } : {}),
                remote: {
                  ...(fileUuid ? { fileUuid, fileId: fileUuid } : {}),
                  fileInfo,
                },
                fileName: media.fileName,
              },
            ];

      const { refIdx, replyMsgId } = this.resolveQuoteRefIdx(options.replyTo);
      const passiveMsgId = options.msgId ?? this.resolvePassiveMsgId(key);
      const sendOutcome = await this.sendSingleWithSlotAndFallback(
        key,
        openid,
        passiveMsgId,
        (msgId, msgSeq) => ({
          msg_type: QQ_MSG_TYPE_MEDIA,
          media: { file_info: fileInfo },
          ...(refIdx ? { message_reference: { message_id: refIdx } } : {}),
          ...(msgId && msgSeq !== undefined ? { msg_id: msgId, msg_seq: msgSeq } : {}),
        }),
        {
          peer: key,
          replyTo: replyMsgId ?? null,
          ...(media.textSummary ? { text: media.textSummary } : {}),
          attachments,
        }
      );

      return sendOutcome.result;
    });
  }

  /**
   * 若配置开启 `input_notify_enabled` 且存在有效入站 `msg_id`，下发 `msg_type=6` 输入中提示（占用 1 个 `msg_seq`）。
   */
  sendInputNotifyIfEnabled(
    peer: string,
    options: { openid?: string; msgId?: string } = {}
  ): Promise<QQApiResult<QQSendMessageResponse> | null> {
    const enabled = this.options.getConfig?.().input_notify_enabled ?? DEFAULT_INPUT_NOTIFY_ENABLED;
    if (!enabled) {
      return Promise.resolve(null);
    }

    const key = this.normalizePeerKey(peer);
    return this.sender.enqueue(key, async () => {
      const gateway = this.options.gateway;
      if (!gateway) return null;

      const openid = options.openid ?? this.resolveOpenid(key);
      const msgId = options.msgId ?? this.resolvePassiveMsgId(key);
      if (!openid || !msgId) {
        return null;
      }

      const seed = { peer: key, openid };
      let seq = this.slots.allocate(msgId, seed);
      for (let attempt = 0; attempt <= this.maxDedupeRetries; attempt += 1) {
        const res = await gateway.sendInputNotify(openid, msgId, seq);
        if (res.ok) return res;

        if (isDedupeError(res) && attempt < this.maxDedupeRetries) {
          seq = this.slots.advance(msgId, seq, seed);
          continue;
        }
        if (isPassiveAnchorError(res)) {
          this.invalidateInboundAnchor(key, msgId);
        }
        return res;
      }
      return null;
    });
  }

  /**
   * 撤回单聊出站消息并更新本地数据库 `recalled = 1`（严格 120s 硬时限，超时 `40064004` 原样返回）。
   */
  async recallMessage(
    peer: string,
    messageId: string,
    options: { openid?: string; hidetip?: boolean } = {}
  ): Promise<QQApiResult<Record<string, unknown>>> {
    const gateway = this.options.gateway;
    if (!gateway) {
      return { ok: false, status: 503, message: 'QQ Gateway 未连接', body: null as any };
    }
    if (!messageId || typeof messageId !== 'string' || messageId.trim() === '') {
      return { ok: false, status: 400, message: '撤回失败：message_id 不能为空', body: null as any };
    }

    const key = this.normalizePeerKey(peer);
    const openid = options.openid ?? this.resolveOpenid(key);
    if (!openid) {
      return { ok: false, status: 400, message: `无法解析会话 ${key} 的 QQ openid`, body: null as any };
    }

    const res = await gateway.deleteC2CMessage(openid, messageId.trim(), options.hidetip);
    if (res.ok) {
      try {
        this.options.db?.markRecalled?.(messageId.trim());
      } catch (err) {
        this.options.logger?.warn?.('[KujiraOutbound] markRecalled 失败:', err);
      }
    }
    return res;
  }

  private async sendSingleWithSlotAndFallback(
    peerKey: string,
    openid: string,
    initialMsgId: string | undefined,
    buildPayload: (msgId?: string, msgSeq?: number) => QQSendMessagePayload,
    meta: OutboundSendMeta
  ): Promise<{ result: QQApiResult<QQSendMessageResponse>; nextPassiveMsgId?: string }> {
    const gateway = this.options.gateway!;
    let currentMsgId = initialMsgId;
    const seed = { peer: peerKey, openid };

    if (currentMsgId) {
      let seq = this.slots.allocate(currentMsgId, seed);
      for (let attempt = 0; attempt <= this.maxDedupeRetries; attempt += 1) {
        const res = await gateway.sendC2CMessage(openid, buildPayload(currentMsgId, seq), meta);
        if (res.ok) {
          return { result: res, nextPassiveMsgId: currentMsgId };
        }
        if (isDedupeError(res) && attempt < this.maxDedupeRetries) {
          seq = this.slots.advance(currentMsgId, seq, seed);
          this.options.logger?.warn?.(
            `[KujiraOutbound] 遇 40054005 去重 (msg_id=${currentMsgId})，切换 msg_seq=${seq} 重试`
          );
          continue;
        }
        if (isPassiveAnchorError(res)) {
          this.options.logger?.warn?.(
            `[KujiraOutbound] 入站锚点已失效 (code=${String(res.code)})，标记失效并降级主动消息`
          );
          this.invalidateInboundAnchor(peerKey, currentMsgId);
          currentMsgId = undefined;
          break;
        }
        return { result: res, nextPassiveMsgId: currentMsgId };
      }
    }

    // 无有效入站锚点或锚点失效后降级为普通主动消息（不传 msg_id / msg_seq）
    const proactiveRes = await gateway.sendC2CMessage(openid, buildPayload(undefined, undefined), meta);
    return { result: proactiveRes, nextPassiveMsgId: undefined };
  }

  /**
   * 启动出站事件流监听。
   * 严守用户侧静默原则：返回 no-op dispose，绝不注册 `session/event` 自动直发文本。
   */
  start(): () => void {
    return () => {};
  }

  /**
   * 处理单条 `session/event`。
   * 严守用户侧静默原则与 `send_qq_message` 唯一通道原则：绝不在监听或 `turn/end` 中偷发文本。
   */
  async handleSessionEvent(_session?: any, _event?: any): Promise<void> {
    return;
  }

  dispose(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.sender.clear();
    this.slots.clear();
    this.inboundContexts.clear();
    this.latestInboundAnchors.clear();
    this.peerToOpenid.clear();
    this.activeStreams.clear();
  }
}
