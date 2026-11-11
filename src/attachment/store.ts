/**
 * kujira: 附件描述符的序列化、反序列化与原始事件解析。
 *
 * - `messages.attachments` 存精简描述符 JSON（Guaranteed Lossless JSON）；
 * - `descriptorsFromRaw` 直接从持久化的官方 `QQC2CMessageCreateEvent` JSON（`attachments`）解析描述符，
 *   不兼容旧版 OneBot / NapCat 消息段结构；
 * - 任意非法 JSON 一律回退空数组，绝不抛错阻断历史读取。
 */

import type { QQC2CMessageCreateEvent } from '../types/index.js';
import { describeInboundAttachments } from './classify.js';
import type { AttachmentDescriptor, AttachmentKind, AttachmentOrigin } from './types.js';

const VALID_KINDS = new Set<AttachmentKind>([
  'image',
  'sticker',
  'file',
  'record',
  'video',
  'forward',
]);

const VALID_ORIGINS = new Set<AttachmentOrigin>(['inbound', 'outbound']);

/** 校验是否为合法的附件类别。 */
export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === 'string' && VALID_KINDS.has(value as AttachmentKind);
}

/** 递归剥离 `undefined` 键；数组中的 `undefined` 置为 `null` 以保持下标，确保符合 Lossless JSON。 */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : compact(item))) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = compact(item);
    }
    return out as T;
  }
  return value;
}

/** 序列化描述符数组；空数组返回 null（DB 列保持 NULL）。 */
export function serializeAttachments(
  descriptors: ReadonlyArray<AttachmentDescriptor>
): string | null {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return null;
  return JSON.stringify(compact(descriptors));
}

/** 反序列化描述符数组；非法输入返回空数组。 */
export function deserializeAttachments(
  value: string | null | undefined
): AttachmentDescriptor[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AttachmentDescriptor =>
        Boolean(item) &&
        typeof item === 'object' &&
        VALID_KINDS.has(item.kind) &&
        VALID_ORIGINS.has(item.origin)
    );
  } catch {
    return [];
  }
}

/**
 * 从持久化的 `QQC2CMessageCreateEvent` JSON 字符串解析附件描述符（`attachments` 数组）。
 * 非法 JSON、非事件对象或不含 `attachments` 数组时安全返回空数组。
 */
export function descriptorsFromRaw(
  raw: string | null | undefined,
  options?: { origin?: AttachmentOrigin }
): AttachmentDescriptor[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    if (!Array.isArray(parsed.attachments)) return [];

    const description = describeInboundAttachments(parsed as QQC2CMessageCreateEvent);
    if (options?.origin === 'outbound') {
      return description.attachments.map((d) => ({ ...d, origin: 'outbound' }));
    }
    return description.attachments;
  } catch {
    return [];
  }
}
