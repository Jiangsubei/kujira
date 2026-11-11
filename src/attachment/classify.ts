/**
 * kujira: 附件分类与入站事实提取（唯一判定入口）。
 *
 * 严格遵循 QQ 官方 Bot API v2 实测行为：
 * - 基于 `QQC2CMessageCreateEvent.attachments[]` 的 `content_type` 判定类型；
 * - 语音严格以 `content_type === 'voice'` 为准，提取 `voice_wav_url` 与 `asr_refer_text`；
 * - 注意实测存在 `.png` 文件以 `content_type === 'file'` 下发，保持 `'file'` 分类并保留真实扩展名。
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QQAttachment, QQC2CMessageCreateEvent } from '../types/index.js';
import type {
  AttachmentDescriptor,
  AttachmentKind,
  AttachmentOrigin,
  AttachmentRemoteMeta,
} from './types.js';

export interface MessageDescription {
  /** 主导消息类型（'text' | 'image' | 'sticker' | 'file' | 'record' | 'video' | 'forward' | 'card' | 'reply'） */
  type: string;
  /** 按附件顺序排列的附件描述符 */
  attachments: AttachmentDescriptor[];
}

export interface MessageMediaFields {
  type: string;
  file_id: string | null;
  local_path: string | null;
  fingerprint: string | null;
}

const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 把 `file://` URI 或本地绝对路径解析为可读 OS 路径。
 * HTTP URL / base64 / 相对路径一律返回 null，绝不伪造本地路径。
 */
export function resolveLocalMediaPath(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;

  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      try {
        const pathname = decodeURIComponent(new URL(raw).pathname);
        return pathname.startsWith('/') ? pathname : null;
      } catch {
        return null;
      }
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) {
    return raw;
  }
  return null;
}

/**
 * 对外部传入的附件文件名执行跨平台 `basename` 与危险字符净化，防止路径穿越。
 */
export function sanitizeAttachmentFileName(value: unknown): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;

  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (!base || base === '.' || base === '..') return undefined;

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') return undefined;
  return cleaned;
}

/** 判断路径或文件名扩展名是否为常见位图图片格式。 */
export function isImageFileExt(fileNameOrPath?: string | null): boolean {
  if (!fileNameOrPath || typeof fileNameOrPath !== 'string') return false;
  const ext = path.extname(fileNameOrPath).replace(/^\./, '').toLowerCase();
  return IMAGE_FILE_EXTENSIONS.has(ext);
}

/** 根据官方 `QQAttachment.content_type` 判定统一附件类别。 */
export function classifyAttachment(attachment: QQAttachment | null | undefined): AttachmentKind {
  if (!attachment || typeof attachment !== 'object') return 'file';
  const ct = nonEmptyString(attachment.content_type)?.toLowerCase() ?? '';

  if (ct.includes('image/') || ct === 'image') {
    return 'image';
  }
  if (ct === 'voice' || ct.startsWith('audio/')) {
    return 'record';
  }
  if (ct.includes('video/') || ct === 'video') {
    return 'video';
  }
  if (ct === 'file') {
    return 'file';
  }

  if (nonEmptyString(attachment.voice_wav_url) || nonEmptyString(attachment.asr_refer_text)) {
    return 'record';
  }
  return 'file';
}

function buildInboundRemoteMeta(attachment: QQAttachment): AttachmentRemoteMeta | undefined {
  const contentType = nonEmptyString(attachment.content_type);
  const url = nonEmptyString(attachment.url);
  const voiceWavUrl = nonEmptyString(attachment.voice_wav_url);
  const asrReferText = nonEmptyString(attachment.asr_refer_text);

  if (!contentType && !url && !voiceWavUrl && !asrReferText) {
    return undefined;
  }

  return {
    ...(contentType ? { contentType } : {}),
    ...(url ? { url } : {}),
    ...(voiceWavUrl ? { voiceWavUrl } : {}),
    ...(asrReferText ? { asrReferText } : {}),
  };
}

/** 从单个官方入站 `QQAttachment` 提取附件描述符。 */
export function describeAttachment(
  attachment: QQAttachment,
  origin: AttachmentOrigin = 'inbound'
): AttachmentDescriptor {
  const kind = classifyAttachment(attachment);
  const remote = buildInboundRemoteMeta(attachment);
  const fileName = sanitizeAttachmentFileName(attachment.filename);

  return {
    kind,
    origin,
    ...(remote ? { remote } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

/**
 * 推导官方 C2C 入站事件主导消息类型。
 */
export function inferInboundMessageType(
  event: QQC2CMessageCreateEvent,
  descriptors: ReadonlyArray<AttachmentDescriptor> = []
): string {
  if (event.message_type === 102) return 'forward';
  if (event.message_type === 3 || event.ark_data) return 'card';

  if (descriptors.length > 0) {
    if (descriptors.some((d) => d.kind === 'file')) return 'file';
    if (descriptors.some((d) => d.kind === 'forward')) return 'forward';
    if (descriptors.some((d) => d.kind === 'record')) return 'record';
    if (descriptors.some((d) => d.kind === 'video')) return 'video';
    if (descriptors.some((d) => d.kind === 'sticker' || Boolean(d.face?.id))) return 'sticker';
    return 'image';
  }

  if (event.message_type === 103) return 'reply';
  return 'text';
}

/**
 * 从官方 `QQC2CMessageCreateEvent` 提取主导消息类型与附件描述符列表。
 * 若外部已通过 `resolveInboundAttachments` 完成落盘与表情匹配，可传入 `resolvedDescriptors` 直接复用本地事实。
 */
export function describeInboundAttachments(
  event: QQC2CMessageCreateEvent,
  resolvedDescriptors?: AttachmentDescriptor[]
): MessageDescription {
  const attachments: AttachmentDescriptor[] = Array.isArray(resolvedDescriptors)
    ? resolvedDescriptors
    : Array.isArray(event?.attachments)
      ? event.attachments
          .filter((att): att is QQAttachment => Boolean(att) && typeof att === 'object')
          .map((att) => describeAttachment(att, 'inbound'))
      : [];

  return {
    type: inferInboundMessageType(event, attachments),
    attachments,
  };
}

/** 描述符 → `messages` 表的媒体字段（无 `busid`）。 */
export function toMessageMediaFields(description: MessageDescription): MessageMediaFields {
  const firstRemote = description.attachments.find(
    (item) => item.remote?.fileUuid || item.remote?.fileInfo || item.remote?.fileId
  )?.remote;
  const firstLocal = description.attachments.find((item) => item.local?.path)?.local;

  return {
    type: description.type,
    file_id: firstRemote?.fileUuid ?? firstRemote?.fileInfo ?? firstRemote?.fileId ?? null,
    local_path: firstLocal?.path ?? null,
    fingerprint: firstLocal?.fingerprint ?? null,
  };
}
