/**
 * kujira: 出站消息自记录 (Outbound Self Record)
 *
 * QQ 官方 Bot REST 发送成功并拿到响应体 `body.id` (`ROBOT1.0_...`) 与可选 `ext_info.ref_idx` (`REFIDX_...`) 后，
 * 立即将自身消息写入本地 SQLite `messages` 表（`self = 1`）。
 *
 * 严格红线：
 * - 失败或缺失有效字符串 `msgId` 时绝不落库，避免写入无法寻址的幽灵记录；
 * - 严禁将出站 `body.id` 写入 `inbound_reply_slots`（严格三 ID 隔离，防 `40034024`）；
 * - 零 OneBot 段伪装、零 `busid`、零 `isGroup`、零 `get_msg` 回查。
 */

import type { AttachmentDescriptor } from '../attachment/types.js';
import type { OutboundSentEvent } from '../gateway/server.js';
import type { MessageRecord } from '../types/index.js';

export interface SelfRecordDb {
  saveMessageIfNotExists(record: MessageRecord): boolean;
}

export interface SelfRecordDeps {
  db: SelfRecordDb;
  /** 机器人自身标识（来自 READY d.user.id，过渡期兼容 botQQ 键名） */
  botId?: string;
  botQQ?: string;
  senderName: string;
  logger?: {
    debug?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  };
}

export interface BuildSelfRecordOptions {
  botId?: string;
  botQQ?: string;
  senderName: string;
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : compactValue(item)));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = compactValue(v);
    }
    return out;
  }
  return value;
}

function serializeAttachmentDescriptors(descriptors: ReadonlyArray<AttachmentDescriptor>): string | null {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return null;
  return JSON.stringify(compactValue(descriptors));
}

function formatFaceText(face: { id: string; mood?: string | null }, localPath?: string | null): string {
  const moodPart = face.mood && face.mood.trim() ? ` (情绪: ${face.mood.trim()})` : '';
  const pathPart = localPath && localPath.trim() ? ` 路径: ${localPath.trim()}` : '';
  return `[表情包: ${face.id}${moodPart}${pathPart}]`;
}

function renderOutboundAttachment(descriptor: AttachmentDescriptor): string | null {
  if (!descriptor) return null;
  switch (descriptor.kind) {
    case 'sticker': {
      if (descriptor.face?.id) {
        return formatFaceText(descriptor.face, descriptor.local?.path);
      }
      const summary = (descriptor.summary || '表情').replace(/^\[+|\]+$/g, '').trim() || '表情';
      return descriptor.local?.path
        ? `[表情包: ${summary} 路径: ${descriptor.local.path}]`
        : `[表情包: ${summary}]`;
    }
    case 'image': {
      if (descriptor.face?.id) {
        return formatFaceText(descriptor.face, descriptor.local?.path);
      }
      const target =
        descriptor.local?.path || descriptor.remote?.url || descriptor.remote?.fileUuid || descriptor.remote?.fileId || '';
      return target ? `[图片:${target}]` : '[图片]';
    }
    case 'file': {
      const name = descriptor.fileName || '未知文件';
      return descriptor.local?.path ? `[文件:${name} 已保存: ${descriptor.local.path}]` : `[文件:${name}]`;
    }
    case 'record':
      return '[语音]';
    case 'video': {
      const name = descriptor.fileName?.trim() || '';
      const fileId = (descriptor.remote?.fileUuid || descriptor.remote?.fileId || '').trim();
      const namePart = name && name !== fileId ? `:${name}` : '';
      return descriptor.local?.path ? `[视频${namePart} 已保存: ${descriptor.local.path}]` : `[视频${namePart}]`;
    }
    default:
      return null;
  }
}

/**
 * 由 QQ 官方 Bot 出站发送事件构造 `self = 1` 的消息记录。
 * 缺有效字符串 `msgId`、缺 `peer` 或正文为空时返回 `null`（不落库）。
 */
export function buildSelfMessageRecord(
  event: OutboundSentEvent,
  options: BuildSelfRecordOptions
): MessageRecord | null {
  const msgId = typeof event.msgId === 'string' ? event.msgId.trim() : '';
  const peer = typeof event.peer === 'string' ? event.peer.trim() : '';
  if (!msgId || !peer) return null;

  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  const rawText = typeof event.text === 'string' ? event.text : '';
  const hasText = rawText.trim() !== '';

  const attachmentLines = attachments
    .map(renderOutboundAttachment)
    .filter((line): line is string => Boolean(line));

  let content = '';
  if (hasText && attachmentLines.length > 0) {
    content = `${rawText}\n${attachmentLines.join('\n')}`;
  } else if (hasText) {
    content = rawText;
  } else if (attachmentLines.length > 0) {
    content = attachmentLines.join('\n');
  }

  if (content.trim() === '') return null;

  const firstAttachment = attachments[0];
  const dominantType = firstAttachment ? firstAttachment.kind : event.replyTo ? 'reply' : 'text';

  const remoteHolder = attachments.find((a) => a.remote?.fileUuid || a.remote?.fileId)?.remote;
  const fileId = remoteHolder?.fileUuid ?? remoteHolder?.fileId ?? null;
  const localPath = attachments.find((a) => a.local?.path)?.local?.path ?? null;
  const fingerprint = attachments.find((a) => a.local?.fingerprint)?.local?.fingerprint ?? null;

  const replyTo = typeof event.replyTo === 'string' && event.replyTo.trim() !== '' ? event.replyTo.trim() : null;
  const refIdx = typeof event.refIdx === 'string' && event.refIdx.trim() !== '' ? event.refIdx.trim() : null;
  const botUserId = (options.botId || options.botQQ || 'bot').trim() || 'bot';
  const raw =
    typeof event.payload === 'string'
      ? event.payload
      : JSON.stringify(
          event.payload ?? {
            msg_type: event.msgType,
            text: content,
            ...(attachments.length > 0 ? { attachments } : {}),
          }
        );

  return {
    msg_id: msgId,
    peer,
    user_id: botUserId,
    sender_name: options.senderName || '',
    time: Number.isFinite(event.time) ? event.time : Date.now(),
    type: dominantType,
    content,
    raw,
    file_id: fileId,
    local_path: localPath,
    fingerprint,
    recalled: 0,
    self: 1,
    reply_to: replyTo,
    ref_idx: refIdx,
    source: 'qq',
    attachments: serializeAttachmentDescriptors(attachments),
  };
}

/**
 * 出站发送成功后的落库入口。
 * 仅写入 `messages` 表，绝不写入 `inbound_reply_slots`。
 */
export function recordOutboundSelfMessage(
  event: OutboundSentEvent,
  deps: SelfRecordDeps
): MessageRecord | null {
  const record = buildSelfMessageRecord(event, {
    botId: deps.botId,
    botQQ: deps.botQQ,
    senderName: deps.senderName,
  });

  if (!record) return null;

  try {
    const inserted = deps.db.saveMessageIfNotExists(record);
    if (inserted) {
      deps.logger?.debug?.(
        `[Kujira] 出站消息已落库 (peer: ${record.peer}, msg_id: ${record.msg_id}${record.ref_idx ? `, ref_idx: ${record.ref_idx}` : ''})`
      );
    }
    return record;
  } catch (err) {
    deps.logger?.warn?.('[Kujira] 出站消息落库失败:', err);
    return null;
  }
}
