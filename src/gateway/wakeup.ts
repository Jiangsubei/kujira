/**
 * kujira: QQ 官方 Bot 单聊唤醒门控模块
 *
 * 面向 `C2C_MESSAGE_CREATE` (`QQC2CMessageCreateEvent`) 事件的唤醒判定与 `WakeupPayload` 组装：
 * - 方案 A 身份映射：`openidToPeer(author.user_openid)` 生成 `user_<hash16>`，`from_user` 保留 `openid`；
 * - 三 ID 严格隔离：提取入站 `msg_id = event.id`、`ref_idx` (`msg_idx=REFIDX_...`) 与被引用 `ref_msg_idx`；
 * - 入站引用精确还原：优先凭 `REFIDX_...` 查本地 SQLite；未命中或遇 `TMP_...` 时由 `msg_elements[]` 回退还原；
 * - ISO-8601 `timestamp` 解析为毫秒时间戳；过滤空内容且无附件/引用/卡片的无效事件。
 */

import type {
  FaceRecord,
  QQC2CMessageCreateEvent,
  WakeupPayload,
  WakeupQuotedInfo,
  WakeupTriggerType,
} from '../types/index.js';
import type { AttachmentDescriptor } from '../attachment/types.js';
import { describeInboundAttachments, isImageFileExt } from '../attachment/classify.js';
import { isValidOpenid, openidToPeer } from '../utils/peer.js';
import {
  extractMessageRefIdx,
  extractMsgElementsText,
  extractQuotedRefIdx,
  isPermanentRefIdx,
  parseNormalizedContent,
} from './segment-normalizer.js';

// Re-export 子模块导出
export * from './card-parser.js';
export * from './segment-normalizer.js';

export interface QuotedMessageRecord {
  msg_id?: string;
  short_id?: string | null;
  ref_idx?: string | null;
  user_id?: string;
  sender_name?: string;
  time?: number;
  content: string;
  self?: number;
  images?: string[];
  local_path?: string | null;
  type?: string;
}

export interface WakeupOptions {
  /** 已落盘的入站附件描述符（由 resolveInboundAttachments 产出；缺省时由 event.attachments 推导） */
  descriptors?: AttachmentDescriptor[];
  /** 当前入站消息分配到的单聊短消息 ID（如 `msg_<n>`），可选注入到 WakeupPayload */
  shortId?: string;
  /** 从 message_type=102 合并转发内嵌图片下载落盘得到的本地路径 */
  forwardImages?: string[];
  /** 合并转发文本 URL 脱敏替换回调 */
  sanitizeForwardContent?: (content: string) => string;
  /** 机器人展示名（引用自身消息时用于填充 quoted.from_name） */
  botName?: string;
  /** 发送者本地备注/展示名覆盖 */
  senderRemark?: string;
  /** 根据永久引用索引 REFIDX_... 反查本地数据库消息 */
  getMessageByRefIdx?: (
    refIdx: string
  ) => Promise<QuotedMessageRecord | null | undefined> | QuotedMessageRecord | null | undefined;
  /** 入站图片匹配本地表情库查询器 */
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
}

export interface WakeupDecision {
  wakeup: boolean;
  trigger?: WakeupTriggerType;
  payload?: WakeupPayload;
}

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function parseIsoTimestamp(timestamp?: string): number {
  if (typeof timestamp === 'string' && timestamp.trim()) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function collectDescriptorImagePaths(descriptors: ReadonlyArray<AttachmentDescriptor>): string[] {
  const out: string[] = [];
  for (const d of descriptors) {
    const localPath = d.local?.path;
    if (!localPath) continue;
    const isImage =
      d.kind === 'image' ||
      d.kind === 'sticker' ||
      (d.kind === 'file' &&
        (isImageFileExt(localPath) ||
          (typeof d.local?.format === 'string' && IMAGE_FORMATS.has(d.local.format.toLowerCase()))));
    if (isImage && !out.includes(localPath)) {
      out.push(localPath);
    }
  }
  return out;
}

function resolveQuotedImages(record: QuotedMessageRecord): string[] | undefined {
  if (Array.isArray(record.images) && record.images.length > 0) {
    const valid = record.images.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    if (valid.length > 0) return valid;
  }
  if (
    typeof record.local_path === 'string' &&
    record.local_path.trim() !== '' &&
    (record.type === 'image' || record.type === 'sticker' || isImageFileExt(record.local_path))
  ) {
    return [record.local_path.trim()];
  }
  return undefined;
}

async function resolveQuotedInfo(
  event: QQC2CMessageCreateEvent,
  options: WakeupOptions
): Promise<WakeupQuotedInfo | undefined> {
  const refMsgIdx = extractQuotedRefIdx(event);
  const hasElements = Array.isArray(event.msg_elements) && event.msg_elements.length > 0;
  const isQuoteEvent = event.message_type === 103 || Boolean(refMsgIdx) || hasElements;

  if (!isQuoteEvent) {
    return undefined;
  }

  // 1. 若 ref_msg_idx 为永久索引 REFIDX_...，优先查询本地 SQLite
  if (isPermanentRefIdx(refMsgIdx) && options.getMessageByRefIdx) {
    try {
      const hit = await options.getMessageByRefIdx(refMsgIdx);
      if (hit) {
        const quotedImages = resolveQuotedImages(hit);
        const shortId =
          typeof hit.short_id === 'string' && hit.short_id.trim() !== ''
            ? hit.short_id.trim()
            : undefined;
        return {
          ...(shortId ? { short_id: shortId } : {}),
          ...(typeof hit.time === 'number' && Number.isFinite(hit.time) ? { time: hit.time } : {}),
          text: hit.content || '',
          ...(quotedImages ? { images: quotedImages } : {}),
        };
      }
    } catch {
      // 查询失败自动回退 msg_elements 兜底
    }
  }

  // 2. TMP_... 临时索引、无 ref_msg_idx 或本地库未命中：从 msg_elements[] 提取被引用原文
  const fallbackText = extractMsgElementsText(event);
  if (fallbackText) {
    return {
      text: fallbackText,
    };
  }

  // 3. 二者皆不可得时优雅降级占位
  return {
    text: '〔历史引用消息：内容已过期或无法获取〕',
  };
}

/**
 * 面向 QQ 官方 Bot `C2C_MESSAGE_CREATE` 事件的唤醒门控与唤醒包组装。
 */
export async function shouldWakeup(
  event: QQC2CMessageCreateEvent,
  options: WakeupOptions = {}
): Promise<WakeupDecision> {
  if (!event || typeof event !== 'object') {
    return { wakeup: false };
  }

  // 1. 自循环防护与发送者 openid 校验
  if (event.author?.bot === true) {
    return { wakeup: false };
  }
  const openid = typeof event.author?.user_openid === 'string' ? event.author.user_openid.trim() : '';
  if (!isValidOpenid(openid)) {
    return { wakeup: false };
  }

  const peer = openidToPeer(openid);
  const fromName =
    options.senderRemark?.trim() ||
    (typeof event.author?.username === 'string' ? event.author.username.trim() : '');
  const timestamp = parseIsoTimestamp(event.timestamp);
  const msgId = typeof event.id === 'string' && event.id.trim() ? event.id.trim() : undefined;
  const shortId =
    typeof options.shortId === 'string' && options.shortId.trim() ? options.shortId.trim() : undefined;
  const refIdx = extractMessageRefIdx(event);

  // 2. 附件描述符与正文归一化
  const descriptors = options.descriptors
    ? options.descriptors
    : describeInboundAttachments(event).attachments;

  const content = parseNormalizedContent(event, descriptors, {
    getFaceByMd5: options.getFaceByMd5,
    sanitizeForwardContent: options.sanitizeForwardContent,
  });

  // 3. 入站引用解析（REFIDX_ 查库 -> msg_elements 兜底）
  const quoted = await resolveQuotedInfo(event, options);

  // 4. 收集图片本地路径（入站附件 + 合并转发落盘图片 + 引用消息图片）
  const combinedImages = collectDescriptorImagePaths(descriptors);
  if (Array.isArray(options.forwardImages)) {
    for (const img of options.forwardImages) {
      if (typeof img === 'string' && img.trim() && !combinedImages.includes(img.trim())) {
        combinedImages.push(img.trim());
      }
    }
  }
  if (quoted?.images) {
    for (const img of quoted.images) {
      if (typeof img === 'string' && img.trim() && !combinedImages.includes(img.trim())) {
        combinedImages.push(img.trim());
      }
    }
  }

  // 5. 过滤完全空内容且无附件/无引用/无卡片的无效事件
  const hasCard = event.message_type === 3 || Boolean(event.ark_data);
  if (
    content.length === 0 &&
    descriptors.length === 0 &&
    !quoted &&
    !hasCard &&
    combinedImages.length === 0
  ) {
    return { wakeup: false };
  }

  const trigger: WakeupTriggerType = quoted ? 'quote' : 'direct';
  const payload: WakeupPayload = {
    ...(msgId ? { msg_id: msgId } : {}),
    ...(shortId ? { short_id: shortId } : {}),
    ...(refIdx ? { ref_idx: refIdx } : {}),
    trigger,
    peer,
    from_user: openid,
    from_name: fromName,
    content,
    ...(quoted ? { quoted } : {}),
    ...(combinedImages.length > 0 ? { images: combinedImages } : {}),
    timestamp,
  };

  return {
    wakeup: true,
    trigger,
    payload,
  };
}
