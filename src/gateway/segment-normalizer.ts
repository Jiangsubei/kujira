/**
 * kujira: QQ 官方 Bot 单聊消息内容归一化模块
 *
 * 彻底移除 OneBot 段 AST、`[CQ:*]` 与 `resolveAtNicknames`，专职：
 * - `message_type === 102`（合并转发）：结合内嵌媒体落盘与结构化重排安全呈现正文（未落盘/失败保留选项 A 真实直链）；
 * - `message_type === 3`（卡片）：优先通过 `extractArkDataContent` 渲染结构化 `ark_data`；
 * - 入站附件描述符：自动计算本地落盘图片 MD5 匹配已收藏表情库，升格为语义占位符 `[表情包: <id> ...]`；
 * - 引用索引与 `msg_elements` 要素提取，供 `wakeup.ts` 精确还原引用消息。
 */

import type { FaceRecord, QQC2CMessageCreateEvent } from '../types/index.js';
import type { AttachmentDescriptor } from '../attachment/types.js';
import { extractFaceXmlTexts, hasFaceXmlTag, stripFaceXmlTags } from '../attachment/classify.js';
import {
  formatFacePlaceholder as renderFacePlaceholder,
  renderAttachment,
  renderAttachments,
} from '../attachment/render.js';
import { computeFileMd5 } from '../storage/media.js';
import { extractArkDataContent } from './card-parser.js';
import { formatForwardMessageContent } from './inbound-media.js';

export { extractFaceXmlTexts, hasFaceXmlTag, stripFaceXmlTags };

export interface MatchedFaceInfo {
  id: string;
  mood?: string | null;
  tags?: string[] | null;
}

export interface ParseNormalizedContentOptions {
  /** 入站图片匹配本地表情库查询器 */
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
  /** 合并转发文本结构化排版与占位替换函数（通常由 `resolveEmbeddedForwardMedia` 提供） */
  formatForwardContent?: (content: string) => string;
}

/**
 * 格式化已收藏表情包在聊天上下文中的语义占位符。
 * 格式示例：`[表情包: face_12345678 (情绪: 嘲讽)]` 或 `[表情包: face_12345678 路径: /path]`
 */
export function formatFacePlaceholder(face: MatchedFaceInfo, localPath?: string | null): string {
  return renderFacePlaceholder(face, localPath);
}

/**
 * 从 `event.message_scene.ext` 数组提取指定 `key=value` 字段值。
 */
export function extractSceneExtValue(
  event: QQC2CMessageCreateEvent | null | undefined,
  key: string
): string | undefined {
  const extList = event?.message_scene?.ext;
  if (!Array.isArray(extList) || !key) return undefined;

  for (const entry of extList) {
    if (typeof entry !== 'string') continue;
    const eqIdx = entry.indexOf('=');
    if (eqIdx <= 0) continue;
    if (entry.slice(0, eqIdx).trim() !== key) continue;
    const val = entry.slice(eqIdx + 1).trim();
    if (val) return val;
  }
  return undefined;
}

/** 提取本条入站消息自身的引用索引 `msg_idx`（通常为 `REFIDX_...`）。 */
export function extractMessageRefIdx(
  event: QQC2CMessageCreateEvent | null | undefined
): string | undefined {
  return extractSceneExtValue(event, 'msg_idx');
}

/** 提取被引用目标消息索引 `ref_msg_idx`（`REFIDX_...` 或复合引用的 `TMP_...`）。 */
export function extractQuotedRefIdx(
  event: QQC2CMessageCreateEvent | null | undefined
): string | undefined {
  const fromScene = extractSceneExtValue(event, 'ref_msg_idx');
  if (fromScene) return fromScene;

  if (Array.isArray(event?.msg_elements)) {
    for (const el of event.msg_elements) {
      if (typeof el?.msg_idx === 'string' && el.msg_idx.trim()) {
        return el.msg_idx.trim();
      }
    }
  }
  return undefined;
}

/** 判断索引是否为永久可查库索引（`REFIDX_...`），排除临时索引 `TMP_...`。 */
export function isPermanentRefIdx(refIdx?: string | null): refIdx is string {
  return typeof refIdx === 'string' && refIdx.trim().startsWith('REFIDX_');
}

/**
 * 从 `event.msg_elements[]`（及必要时 `parallel_message.msg_nodes[]`）提取被引用原文；
 * 含嵌套合并转发头（`=== 消息 `）时自动结构化清洗排版；其余文本（含直链 URL）原样保留。
 */
export function extractMsgElementsText(
  event: QQC2CMessageCreateEvent | null | undefined
): string | undefined {
  const parts: string[] = [];

  if (Array.isArray(event?.msg_elements)) {
    for (const el of event.msg_elements) {
      if (typeof el?.content === 'string' && el.content.trim()) {
        const trimmed = el.content.trim();
        parts.push(
          trimmed.includes('=== 消息 ') ? formatForwardMessageContent(trimmed) : trimmed
        );
      }
    }
  }

  if (parts.length === 0 && Array.isArray(event?.parallel_message?.msg_nodes)) {
    for (const node of event.parallel_message.msg_nodes) {
      if (typeof node?.content === 'string' && node.content.trim()) {
        const trimmed = node.content.trim();
        parts.push(
          trimmed.includes('=== 消息 ') ? formatForwardMessageContent(trimmed) : trimmed
        );
      }
    }
  }

  const joined = parts.join('\n').trim();
  return joined || undefined;
}

function enrichDescriptorsWithFaces(
  descriptors: AttachmentDescriptor[],
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined
): void {
  if (!getFaceByMd5 || descriptors.length === 0) return;

  for (const descriptor of descriptors) {
    if (descriptor.face?.id) continue;
    if (descriptor.kind !== 'image' && descriptor.kind !== 'sticker') continue;

    const md5 =
      descriptor.local?.md5?.trim().toLowerCase() ||
      (descriptor.local?.path ? computeFileMd5(descriptor.local.path)?.toLowerCase() : undefined);
    if (!md5) continue;

    const matched = getFaceByMd5(md5);
    if (matched && matched.enabled && !matched.deleted_at) {
      descriptor.face = {
        id: matched.id,
        ...(matched.mood ? { mood: matched.mood } : {}),
        ...(matched.tags && matched.tags.length > 0 ? { tags: matched.tags } : {}),
      };
    }
  }
}

/**
 * 将官方 `QQC2CMessageCreateEvent` 与已解析附件描述符列表归一化为安全的纯文本内容。
 */
export function parseNormalizedContent(
  event: QQC2CMessageCreateEvent,
  descriptors: AttachmentDescriptor[] = [],
  options?: ParseNormalizedContentOptions
): string {
  const rawContent = typeof event?.content === 'string' ? event.content : '';
  const { text: cleanText, hadFaceTag } = stripFaceXmlTags(rawContent);

  if (hadFaceTag) {
    for (const descriptor of descriptors) {
      if (descriptor.origin !== 'outbound' && descriptor.kind === 'image') {
        descriptor.kind = 'sticker';
      }
    }
  }

  enrichDescriptorsWithFaces(descriptors, options?.getFaceByMd5);

  const renderedAttachments = renderAttachments(descriptors);

  // 1. 合并转发消息（message_type === 102）
  if (event?.message_type === 102) {
    const formattedForward = options?.formatForwardContent
      ? options.formatForwardContent(rawContent)
      : formatForwardMessageContent(rawContent, { getFaceByMd5: options?.getFaceByMd5 });
    const parts = [formattedForward, ...renderedAttachments].filter((p) => p !== '');
    if (parts.length > 0) {
      return parts.join('\n');
    }
    return renderAttachment({ kind: 'forward', origin: 'inbound' }) ?? '[合并转发]';
  }

  // 2. 卡片 / 小程序消息（message_type === 3 或存在 ark_data）
  if (event?.message_type === 3 || event?.ark_data) {
    const cardText = extractArkDataContent(event.ark_data, rawContent);
    const parts = [cardText, ...renderedAttachments].filter((p) => p !== '');
    return parts.join(' ');
  }

  // 3. 普通文本 / 富媒体 / 引用回复（message_type === 0 / 103）
  const parts: string[] = [];
  if (cleanText !== '') {
    parts.push(cleanText);
  }
  if (renderedAttachments.length > 0) {
    parts.push(...renderedAttachments);
  } else if (hadFaceTag) {
    const faceTexts = extractFaceXmlTexts(rawContent);
    if (faceTexts.length > 0) {
      parts.push(...faceTexts.map((t) => `[表情: ${t}]`));
    }
  }

  if (parts.length === 0) {
    return hadFaceTag ? '[表情]' : '';
  }
  if (parts.length === 1) return parts[0]!;
  return parts.join(' ');
}
