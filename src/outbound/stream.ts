/**
 * kujira: QQ 官方 Bot 单聊出站调度中枢
 *
 * 核心原则与能力：
 * 1. 用户侧静默原则：`start()` 与 `handleSessionEvent()` 绝对静默空转，不自动监听 `session/event` 偷发文本；
 * 2. 内存 + DB 兜底入站 `msg_id` 锚点：优先内存活跃回合真实入站 `d.id`，次查 `db.getLatestValidInboundSlot(peer)`；
 *    `is_synthetic: true` 的系统唤醒绝不清除历史有效入站 `msg_id`；出站 `body.id` 绝不污染入站锚点；
 * 3. 共享 per-`msg_id` `msg_seq` 槽位分配器：优先持久化 `db.allocateNextMsgSeq` 防跨重启撞槽；
 *    遇 `40054005` 自动递进重试；遇 `40034128` / `40034024` 标记旧锚点失效并自动降级为无 `msg_id` 主动消息；
 * 4. 统一出站原语（固定原生 Markdown / 固定输入提示 / 短消息 ID 隔离）：
 *    - `sendTextReply`（固定走 `msg_type=2` + `normalizeQqMarkdown`，按 `QQ_MESSAGE_MAX_BYTES` UTF-8 字节切分，
 *      `replyTo` 仅认短消息 ID 并查库换取 `REFIDX_...`，仅首片附 `message_reference`）；
 *    - `sendMediaReply`（四步分片上传 + `msg_type=7`）；
 *    - `sendInputNotifyIfEnabled` / `sendInputNotify`（固定发送 `msg_type=6` 占用 1 个 `msg_seq` 槽位，容错不阻断主流程）；
 *    - `recallMessage`（仅接收出站短 ID `msg_self_<n>`，本地拒绝入站 `msg_<n>` 与非短 ID，查库换真实 `msg_id` 调 `deleteC2CMessage` 并 `markRecalled`）；
 *    - `resolveShortId`（按原始 `msg_id` 查回分配的 `msg_self_<n>`）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { AttachmentDescriptor, AttachmentKind } from '../attachment/types.js';
import {
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_MESSAGE_MAX_BYTES,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_MSG_TYPE_MEDIA,
} from '../constants/index.js';
import type {
  MediaUploadCacheStore,
  OutboundSendMeta,
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
  WakeupPayload,
} from '../types/index.js';
import { parseShortMessageId } from '../utils/short-id.js';
import { PerPeerSerialSender } from './queue.js';
import { normalizeQqMarkdown, splitByUtf8Bytes } from './render.js';

const ERR_DEDUPED_MSG_SEQ = '40054005';
const ERR_PASSIVE_EXPIRED_OR_LIMIT = '40034128';
const ERR_INVALID_MSG_ID = '40034024';
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

/** 持久化存储抽象：与 Batch 2A 升级后的 MessageDatabase 对齐 */
export interface OutboundSlotDb extends MediaUploadCacheStore {
  getOpenidByPeer?(peer: string): string | null;
  getLatestValidInboundSlot?(peer: string): InboundReplySlot | null;
  allocateNextMsgSeq?(msgId: string, seed?: { peer: string; openid: string }): number;
  advanceMsgSeq?(msgId: string, minNextSeq: number): number | void;
  markInboundSlotInvalidated?(msgId: string): void;
  getMessage?(msgId: string): MessageRecord | null;
  getMessageByShortId?(peer: string, shortId: string): MessageRecord | null;
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
  /** 引用目标的短消息 ID（如 `msg_12` 或 `msg_self_8`） */
  replyTo?: string;
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

export interface OutboundStreamBridgeOptions {
  gateway?: KujiraGatewayClientLike;
  sessionManager?: SessionManagerLike;
  db?: OutboundSlotDb;
  getConfig?: () => BridgePluginConfig;
  maxDedupeRetries?: number;
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
  private readonly maxDedupeRetries: number;
  private unlisten: (() => void) | null = null;

  constructor(
    _ctx: Context,
    private readonly options: OutboundStreamBridgeOptions = {}
  ) {
    this.sender = new PerPeerSerialSender();
    this.slots = new MsgSeqSlotAllocator(options.db);
    this.maxDedupeRetries = options.maxDedupeRetries ?? DEFAULT_MAX_DEDUPE_RETRIES;
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

  /**
   * 仅接收合法短消息 ID (`msg_<n>` 或 `msg_self_<n>`)，查本地数据库换取目标消息的 `ref_idx` (`REFIDX_...`) 与真实 `msg_id`。
   * 若传入非短 ID（如旧 `REFIDX_...` / `ROBOT1.0_...`）或库中未命中，则不发送 `message_reference`。
   */
  private resolveQuoteRefIdx(peer: string, replyTo?: string): { refIdx?: string; replyMsgId?: string } {
    const parsed = parseShortMessageId(replyTo);
    if (!parsed) return {};
    const key = this.normalizePeerKey(peer);
    if (!key) return {};

    const row = this.options.db?.getMessageByShortId?.(key, parsed.shortId);
    if (!row) return {};

    const refIdx =
      typeof row.ref_idx === 'string' && row.ref_idx.trim().startsWith('REFIDX_')
        ? row.ref_idx.trim()
        : undefined;
    const replyMsgId =
      typeof row.msg_id === 'string' && row.msg_id.trim() !== '' ? row.msg_id.trim() : undefined;

    if (!refIdx) {
      return {};
    }
    return {
      refIdx,
      ...(replyMsgId ? { replyMsgId } : {}),
    };
  }

  /**
   * 辅助查询：根据原始 `msg_id` (`ROBOT1.0_...`) 反查数据库为其分配的短出站 ID (`msg_self_<n>`)。
   */
  resolveShortId(peer: string, rawMsgId: string): string | undefined {
    const cleanId = typeof rawMsgId === 'string' ? rawMsgId.trim() : '';
    if (!cleanId) return undefined;
    const row = this.options.db?.getMessage?.(cleanId);
    if (row?.short_id && typeof row.short_id === 'string' && row.short_id.trim() !== '') {
      const key = this.normalizePeerKey(peer);
      if (!key || !row.peer || row.peer === key) {
        return row.short_id.trim();
      }
    }
    return undefined;
  }

  /**
   * 向单聊发送原生 Markdown 消息（经由 per-peer 串行队列）：
   * - 固定使用 `msg_type=2` + `normalizeQqMarkdown`
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

      const openid = options.openid ?? this.resolveOpenid(key);
      if (!openid) {
        return { ok: false, status: 400, message: `无法解析会话 ${key} 的 QQ openid`, body: null as any };
      }

      const formatted = normalizeQqMarkdown(text);
      if (formatted.trim() === '') {
        return { ok: false, status: 400, message: '发送内容不能为空', body: null as any };
      }

      const chunks = splitByUtf8Bytes(formatted, QQ_MESSAGE_MAX_BYTES);
      const { refIdx, replyMsgId } = this.resolveQuoteRefIdx(key, options.replyTo);
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
            msg_type: QQ_MSG_TYPE_MARKDOWN,
            markdown: { content: chunk },
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

      const { refIdx, replyMsgId } = this.resolveQuoteRefIdx(key, options.replyTo);
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
   * 固定下发 `msg_type=6` 输入中提示（别名导出，等价于 `sendInputNotifyIfEnabled`）。
   */
  sendInputNotify(
    peer: string,
    options: { openid?: string; msgId?: string } = {}
  ): Promise<QQApiResult<QQSendMessageResponse> | null> {
    return this.sendInputNotifyIfEnabled(peer, options);
  }

  /**
   * 固定开启输入中提示：只要 `gateway`、`openid` 与有效入站 `msg_id` 存在即发送 `msg_type=6`（占用 1 个 `msg_seq`）。
   * 底层报错仅记录日志容错，绝不阻断主流程。
   */
  sendInputNotifyIfEnabled(
    peer: string,
    options: { openid?: string; msgId?: string } = {}
  ): Promise<QQApiResult<QQSendMessageResponse> | null> {
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
        try {
          const res = await gateway.sendInputNotify(openid, msgId, seq);
          if (res.ok) return res;

          if (isDedupeError(res) && attempt < this.maxDedupeRetries) {
            seq = this.slots.advance(msgId, seq, seed);
            continue;
          }
          if (isPassiveAnchorError(res)) {
            this.invalidateInboundAnchor(key, msgId);
          }
          this.options.logger?.debug?.(
            `[KujiraOutbound] sendInputNotify 未成功 (peer=${key}, code=${String(res.code ?? 'n/a')}, status=${res.status})`
          );
          return res;
        } catch (err) {
          this.options.logger?.warn?.('[KujiraOutbound] sendInputNotify 异常 (忽略容错):', err);
          return null;
        }
      }
      return null;
    });
  }

  /**
   * 撤回单聊出站消息（严格仅认短出站 ID `msg_self_<n>`）：
   * - 非法短 ID / 长 ID -> `INVALID_SHORT_ID`（本地拦截，不打 API）；
   * - 入站短 ID (`msg_<n>`) -> `INBOUND_NOT_RECALLABLE`（本地拦截，不打 API）；
   * - 未查到 -> `NOT_FOUND`；
   * - 查得真实 `record.msg_id` 后调 `deleteC2CMessage`，成功则 `markRecalled(record.msg_id)`。
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

    const parsed = parseShortMessageId(messageId);
    if (!parsed) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_SHORT_ID',
        message: '请传入有效的短出站消息 ID（如 msg_self_8）',
        body: null as any,
      };
    }

    if (parsed.direction !== 'outbound') {
      return {
        ok: false,
        status: 400,
        code: 'INBOUND_NOT_RECALLABLE',
        message: '只能撤回机器人自身发出的出站消息（msg_self_*），不能撤回用户发来的消息（msg_*）',
        body: null as any,
      };
    }

    const key = this.normalizePeerKey(peer);
    const openid = options.openid ?? this.resolveOpenid(key);
    if (!openid) {
      return { ok: false, status: 400, message: `无法解析会话 ${key} 的 QQ openid`, body: null as any };
    }

    const record = this.options.db?.getMessageByShortId?.(key, parsed.shortId);
    if (!record || !record.msg_id) {
      return {
        ok: false,
        status: 404,
        code: 'NOT_FOUND',
        message: `未找到出站消息 ${parsed.shortId}`,
        body: null as any,
      };
    }

    const res = await gateway.deleteC2CMessage(openid, record.msg_id, options.hidetip);
    if (res.ok) {
      try {
        this.options.db?.markRecalled?.(record.msg_id);
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
  }
}
