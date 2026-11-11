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
import { extractFaceXmlTexts, hasFaceXmlTag, isPureStickerMessage, stripFaceXmlTags } from '../attachment/classify.js';
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
 * 从 `event.msg_elements[]`（或必要时 `parallel_message.msg_nodes[]`）收集被引用原文片段。
 * 保持原始文本（含 URL），供上层按需做内嵌媒体落盘与替换。
 */
export function msgElementsRawContents(
  event: QQC2CMessageCreateEvent | null | undefined
): string[] {
  const parts: string[] = [];

  if (Array.isArray(event?.msg_elements)) {
    for (const el of event.msg_elements) {
      if (typeof el?.content === 'string' && el.content.trim()) {
        parts.push(el.content.trim());
      }
    }
  }

  if (parts.length === 0 && Array.isArray(event?.parallel_message?.msg_nodes)) {
    for (const node of event.parallel_message.msg_nodes) {
      if (typeof node?.content === 'string' && node.content.trim()) {
        parts.push(node.content.trim());
      }
    }
  }

  return parts;
}

const FORWARD_LIKE_CONTENT_RE = /(?:^|\n)\s*===\s*消息\s*\d+\s*===|\[附件\d+\]/;

/** 是否为合并转发式引用内容（含 `=== 消息 N ===` 头或行首 `[附件k]` 行）。 */
export function isForwardLikeContent(raw: string): boolean {
  return FORWARD_LIKE_CONTENT_RE.test(raw);
}

function applyUrlReplacements(raw: string, replacements: ReadonlyMap<string, string>): string {
  let out = raw;
  for (const [url, placeholder] of replacements) {
    if (url && out.includes(url)) {
      out = out.split(url).join(placeholder);
    }
  }
  return out;
}

export interface ExtractMsgElementsOptions {
  /** 合并转发内嵌附件原始 URL → 已落盘占位文案（仅对合并转发式引用片段生效，普通引用原文保持不变） */
  replacements?: ReadonlyMap<string, string>;
  /**
   * 元素下标 → 已本地化的附件渲染文案（如 `[图片:/path]`）。
   * 实测：引用图片/视频时 `msg_elements[].content` 为空串，附件只在 `attachments[]` 中下发。
   */
  elementMedia?: ReadonlyMap<number, string>;
}

function transformQuotedPart(
  raw: string,
  replacements: ReadonlyMap<string, string> | undefined,
  hasReplacements: boolean
): string {
  if (!isForwardLikeContent(raw)) return raw;
  if (raw.includes('=== 消息 ')) {
    return formatForwardMessageContent(raw, hasReplacements ? { replacements } : undefined);
  }
  return hasReplacements ? applyUrlReplacements(raw, replacements!) : raw;
}

/**
 * 从 `event.msg_elements[]`（及必要时 `parallel_message.msg_nodes[]`）提取被引用原文；
 * 含嵌套合并转发头（`=== 消息 `）时自动结构化清洗排版；合并转发式片段可按替换表将内嵌附件 URL 本地化；
 * 其余普通引用文本原样保留；`elementMedia` 可把「正文为空、附件在 attachments[]」的媒体引用还原为本地路径。
 */
export function extractMsgElementsText(
  event: QQC2CMessageCreateEvent | null | undefined,
  options?: ExtractMsgElementsOptions
): string | undefined {
  const replacements = options?.replacements;
  const hasReplacements = Boolean(replacements && replacements.size > 0);
  const elementMedia = options?.elementMedia;

  const elements = Array.isArray(event?.msg_elements) ? event.msg_elements : [];
  const elementContents = elements.map((el) =>
    typeof el?.content === 'string' ? el.content.trim() : ''
  );
  const hasAnyContent = elementContents.some(Boolean);

  // 正文全空且没有任何已本地化附件：保持既有行为，整体回退 parallel_message 形态摘要
  if (!hasAnyContent && !(elementMedia && elementMedia.size > 0)) {
    const rawParts = msgElementsRawContents(event);
    if (rawParts.length === 0) return undefined;
    const joined = rawParts
      .map((raw) => transformQuotedPart(raw, replacements, hasReplacements))
      .join('\n')
      .trim();
    return joined || undefined;
  }

  const parts: string[] = [];
  for (const [index, raw] of elementContents.entries()) {
    const text = raw ? transformQuotedPart(raw, replacements, hasReplacements) : '';
    const mediaText = elementMedia?.get(index)?.trim() || '';
    if (text && mediaText) parts.push(`${text} ${mediaText}`);
    else if (mediaText) parts.push(mediaText);
    else if (text) parts.push(text);
  }

  // 有附件但正文全空的极端情况兜底：若一个片段都没产出，再回退 parallel_message
  const joined = parts.join('\n').trim() || msgElementsRawContents(event).join('\n').trim();
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
    const inboundImageCount = descriptors.filter(
      (d) => d.origin !== 'outbound' && d.kind === 'image'
    ).length;
    if (isPureStickerMessage(rawContent, inboundImageCount)) {
      for (const descriptor of descriptors) {
        if (descriptor.origin !== 'outbound' && descriptor.kind === 'image') {
          descriptor.kind = 'sticker';
        }
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
