/**
 * kujira: 入站媒体裸 GET 下载、安全文件名净化与合并转发全量媒体落盘排版
 *
 * 严格依据 QQ 官方 Bot API v2 实测行为：
 * 1. 入站 `event.attachments[]` 所有下载链接均自带访问凭证 query，直接裸 GET 即可（无需 Authorization 头），不设体积上限；
 * 2. 内部服务器日志 (`logger?.warn`) 与 `unavailable` 短错误字段严禁携带带 query / `rkey` 凭证的完整 URL；
 * 3. 选项 A：面向 Agent 展示未落盘或下载失败附件时保留真实直链 URL；已落盘附件仅展示本地 OS 路径；
 * 4. 语音附件严格以 `content_type === 'voice'` 为准（忽略响应头错报 `audio/mp3`），
 *    优先拉取 `voice_wav_url`（`type: 'voice'`, `ext: 'wav'`），缺失/失败再回退 `url`，始终保留 `asr_refer_text`；
 * 5. 外部传入的 `filename` 一律先做 `path.basename` 与危险字符净化后再传入存储层；
 * 6. `message_type=102` 合并转发全量提取 `[附件...] ... URL:https://...`（图片/表情/视频/语音/文件）裸 GET 落盘，
 *    提取视频分辨率/大小/时长并重排为精简编号列表，剥离 `<faceType=...>` 壳并匹配本地表情库。
 */

import * as path from 'node:path';
import type { FaceRecord, QQAttachment, QQC2CMessageCreateEvent } from '../types/index.js';
import type { AttachmentDescriptor, AttachmentFaceMeta, AttachmentKind } from '../attachment/types.js';
import {
  classifyAttachment,
  extractAttachmentXmlDescriptionText,
  extractSingleFaceXmlText,
  hasAttachmentXmlTag,
  hasFaceXmlTag,
  isImageFileExt,
  isPureStickerMessage,
  parseAttachmentXmlIndex,
} from '../attachment/classify.js';
import {
  detectSavedFormat,
  inferExtFromFilename,
  localizeInboundAttachment,
  localizeInboundAttachments,
  nonEmpty,
  sanitizeInboundFilename,
  toActiveFaceMeta,
} from '../attachment/localize.js';
import {
  formatAttachmentByteSize,
  formatFacePlaceholder,
  formatVideoMetaSummary,
} from '../attachment/render.js';
import {
  computeFileMd5,
  sanitizeUrlForLog,
  type MediaStorageManager,
} from '../storage/media.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

// 兼容既有调用方（`src/tools/file-source.ts` 与契约测试）的导入路径
export { sanitizeErrorMessage, sanitizeInboundFilename } from '../attachment/localize.js';
export { sanitizeUrlForLog };

export interface InboundMediaLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

export type ForwardMediaType = 'image' | 'sticker' | 'video' | 'voice' | 'files';

export interface EmbeddedForwardAttachmentEntry {
  /** 原始下载地址（含访问凭证 query；仅用于未落盘/失败时的选项 A 直链展示，严禁写入服务器日志） */
  rawUrl: string;
  /** 脱敏后的 URL（已剥离 query 与 fragment 凭证，供服务器日志使用） */
  sanitizedUrl: string;
  attachmentType?: string;
  mediaType: ForwardMediaType;
  fileName?: string;
  dimensions?: string;
  sizeText?: string;
  localPath?: string;
  localSize?: number;
  durationSec?: number;
  fingerprint?: string;
  md5?: string;
  face?: AttachmentFaceMeta;
  downloaded: boolean;
  error?: string;
}

/** @deprecated 兼容别名，请使用 {@link EmbeddedForwardAttachmentEntry} */
export type EmbeddedForwardImageEntry = EmbeddedForwardAttachmentEntry;

export interface ResolveEmbeddedForwardOptions {
  limit?: number;
  logger?: InboundMediaLogger;
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
}

export interface ResolveEmbeddedForwardMediaResult {
  /** 清洗重排后的合并转发文本（已落盘只展示路径，未落盘/失败展示选项 A 真实直链） */
  formattedContent: string;
  /** 与 `formattedContent` 同步的兼容字段 */
  sanitizedContent: string;
  /** 原始 URL → 渲染后占位符文案映射 */
  replacements: Map<string, string>;
  /** 所有成功落盘附件的本地路径列表（去重，保持出现顺序） */
  localPaths: string[];
  /** 每个内嵌附件的处理明细 */
  entries: EmbeddedForwardAttachmentEntry[];
}

/** @deprecated 兼容别名，请使用 {@link ResolveEmbeddedForwardMediaResult} */
export type ResolveEmbeddedForwardImagesResult = ResolveEmbeddedForwardMediaResult;

export interface FormatForwardMessageOptions {
  resolvedEntries?: ReadonlyMap<string, EmbeddedForwardAttachmentEntry>;
  replacements?: ReadonlyMap<string, string>;
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
}

const FORWARD_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi']);
const FORWARD_VOICE_EXTS = new Set(['wav', 'amr', 'ogg', 'mp3', 'm4a']);
const FORWARD_FILE_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'rtf',
  'epub',
  'log',
  'sql',
  'db',
  'sqlite',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'apk',
  'ipa',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'iso',
  'bin',
  'dat',
  'psd',
  'ai',
  'sketch',
  'fig',
]);

/**
 * 并发下载并落盘 `QQC2CMessageCreateEvent.attachments[]` 中的所有入站附件。
 *
 * 实际落盘策略统一收敛在 {@link localizeInboundAttachments}（与引用消息 `msg_elements[].attachments`
 * 共用同一管线）；本函数只负责「直发消息」特有的严格表情包判定：
 * - 直接裸 GET（不附加任何 Authorization 头，不设大小上限）；
 * - 任一附件失败只标记 `unavailable`（已剥离 URL query），不阻断其他附件或整条消息处理。
 */
export async function resolveInboundAttachments(
  event: QQC2CMessageCreateEvent,
  peer: string,
  mediaManager: MediaStorageManager,
  logger?: InboundMediaLogger,
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined
): Promise<AttachmentDescriptor[]> {
  if (!Array.isArray(event?.attachments) || event.attachments.length === 0) {
    return [];
  }

  const validAttachments = event.attachments.filter(
    (att): att is QQAttachment => Boolean(att) && typeof att === 'object'
  );
  if (validAttachments.length === 0) {
    return [];
  }

  // 严格表情包判定：正文仅由 <faceType=...> 构成且恰好一个图片类附件 → 落盘 `sticker/`
  let imageAttachmentCount = 0;
  for (const att of validAttachments) {
    if (classifyAttachment(att) === 'image') imageAttachmentCount++;
  }
  const forceSticker = isPureStickerMessage(event?.content, imageAttachmentCount);

  return localizeInboundAttachments(validAttachments, {
    peer,
    mediaManager,
    ...(logger ? { logger } : {}),
    forceSticker,
    ...(getFaceByMd5 ? { getFaceByMd5 } : {}),
  });
}

const FORWARD_NODE_HEADER_RE = /^\s*===\s*消息\s*(\d+)\s*===\s*$/;
const FORWARD_ATTACHMENT_LINE_RE = /^\s*\[附件\d+\]\s*(.*)$/;
const FORWARD_SENDER_LINE_RE = /^\s*\[发送者\]\s*(.*)$/;
const FORWARD_CONTENT_LINE_RE = /^\s*\[消息内容\][ \t]?(.*)$/;
const FORWARD_RELATED_LINE_RE = /^\s*\[关联消息\]\s*$/;
const FORWARD_RELATED_ITEM_RE = /^\s*---\s*第\s*\d+\s*条\s*---\s*$/;
const FORWARD_MSG_TYPE_LINE_RE = /^\s*\[消息类型\]\s*(.*)$/;
const FORWARD_INLINE_XML_TAG_RE =
  /<faceType=\s*\d+(?:\s*,\s*[^>\r\n]*)?>|<attachmentType\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,\s>\r\n]+)(?:\s*,\s*[^>\r\n]*)?>/g;
const FORWARD_FACE_TYPE_6_RE = /^<faceType=\s*6(?:\b|[\s,>])/;
const EMBEDDED_URL_TOKEN_REGEX = /URL\s*:\s*(https?:\/\/[^\s"'<>)\]]+)/i;
const FORWARD_TYPE_RE = /(?:^|\s)类型\s*:\s*([^\s]+)/;
const FORWARD_NAME_RE =
  /(?:^|\s)文件名\s*:[ \t]*(?!(?:类型|尺寸|大小|URL)\s*:)(.+?)(?=[ \t]+(?:类型|尺寸|大小|URL)\s*:|$)/;
const FORWARD_DIM_RE = /(?:^|\s)尺寸\s*:\s*([^\s]+)/;
const FORWARD_SIZE_RE = /(?:^|\s)大小\s*:\s*([^\s]+)/;

/**
 * 根据合并转发 `[附件k]` 的 `类型` 与 `文件名` 推断存储目录类型。
 */
export function inferForwardMediaType(
  attachmentType?: string,
  fileName?: string
): ForwardMediaType {
  const norm = attachmentType?.trim().toLowerCase() ?? '';
  if (norm) {
    if (/表情|sticker/.test(norm)) return 'sticker';
    if (/视频|video/.test(norm)) return 'video';
    if (/语音|音频|voice|audio/.test(norm)) return 'voice';
    if (/图|动图|image|gif|pic/.test(norm)) return 'image';
    if (/文件|file/.test(norm)) return 'files';
  }

  const ext = inferExtFromFilename(fileName);
  if (ext) {
    if (isImageFileExt(fileName)) return 'image';
    if (FORWARD_VIDEO_EXTS.has(ext)) return 'video';
    if (FORWARD_VOICE_EXTS.has(ext)) return 'voice';
    if (FORWARD_FILE_EXTS.has(ext)) return 'files';
  }

  return 'image';
}

interface ParsedForwardAttachment {
  attachmentType?: string;
  mediaType: ForwardMediaType;
  fileName?: string;
  dimensions?: string;
  sizeText?: string;
  rawUrl?: string;
}

function normalizeForwardDimensions(raw?: string): string | undefined {
  const value = nonEmpty(raw);
  if (!value) return undefined;
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(value);
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w > 0 && h > 0) {
      return `${w}x${h}`;
    }
    return undefined;
  }
  return value === '0x0' ? undefined : value;
}

function parseForwardAttachmentLine(line: string): ParsedForwardAttachment | null {
  const attMatch = FORWARD_ATTACHMENT_LINE_RE.exec(line);
  const urlMatch = EMBEDDED_URL_TOKEN_REGEX.exec(line);
  if (!attMatch && !urlMatch) return null;

  const attachmentType = nonEmpty(FORWARD_TYPE_RE.exec(line)?.[1]);
  const rawName = FORWARD_NAME_RE.exec(line)?.[1];
  const fileName = sanitizeInboundFilename(rawName);
  const dimensions = normalizeForwardDimensions(FORWARD_DIM_RE.exec(line)?.[1]);
  const sizeText = nonEmpty(FORWARD_SIZE_RE.exec(line)?.[1]);
  const rawUrl = nonEmpty(urlMatch?.[1]);
  const mediaType = inferForwardMediaType(attachmentType, fileName);

  return {
    ...(attachmentType ? { attachmentType } : {}),
    mediaType,
    ...(fileName ? { fileName } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(sizeText ? { sizeText } : {}),
    ...(rawUrl ? { rawUrl } : {}),
  };
}

function resolveEntryFaceMeta(
  entry: EmbeddedForwardAttachmentEntry | undefined,
  mediaType: ForwardMediaType,
  localPath: string | undefined,
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined
): AttachmentFaceMeta | undefined {
  if (entry?.face?.id) return entry.face;
  if (!getFaceByMd5 || (mediaType !== 'image' && mediaType !== 'sticker')) return undefined;
  const md5 =
    entry?.md5?.trim().toLowerCase() ||
    (localPath ? computeFileMd5(localPath)?.toLowerCase() : undefined);
  if (!md5) return undefined;
  return toActiveFaceMeta(getFaceByMd5(md5));
}

function renderForwardAttachment(
  parsed: ParsedForwardAttachment,
  entry: EmbeddedForwardAttachmentEntry | undefined,
  ctx: {
    hadFaceTag: boolean;
    getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
    replacement?: string;
  }
): string {
  const mediaType = entry?.mediaType ?? parsed.mediaType;
  const fileName = parsed.fileName ?? entry?.fileName;
  const dimensions = parsed.dimensions ?? entry?.dimensions;
  const rawSizeText = parsed.sizeText ?? entry?.sizeText;
  const localPath = entry?.localPath?.trim();
  const rawUrl = parsed.rawUrl ?? entry?.rawUrl;
  const error = entry?.error?.trim();

  if (localPath) {
    if (mediaType === 'image' || mediaType === 'sticker') {
      const face = resolveEntryFaceMeta(entry, mediaType, localPath, ctx.getFaceByMd5);
      if (face) {
        return formatFacePlaceholder(face, localPath);
      }
      if (ctx.hadFaceTag || mediaType === 'sticker') {
        return `[表情包:${localPath}]`;
      }
      return `[图片:${localPath}]`;
    }

    if (mediaType === 'video') {
      const namePart = fileName ? `:${fileName}` : '';
      const computedSize =
        rawSizeText ||
        (typeof entry?.localSize === 'number' && entry.localSize > 0
          ? formatAttachmentByteSize(entry.localSize)
          : undefined);
      const meta = formatVideoMetaSummary({
        dimensions,
        sizeText: computedSize,
        durationSec: entry?.durationSec,
      });
      return `[视频${namePart}${meta ? ` (${meta})` : ''} 已保存: ${localPath}]`;
    }

    if (mediaType === 'voice') {
      const namePart = fileName ? `:${fileName}` : '';
      return `[语音${namePart} 已保存: ${localPath}]`;
    }

    const displayName = fileName || path.basename(localPath);
    return `[文件:${displayName} 已保存: ${localPath}]`;
  }

  if (ctx.replacement) {
    return ctx.replacement;
  }

  // 选项 A：未落盘或下载失败时保留真实直链 URL；若官方响应本身缺 URL 则明确标记无法下载
  const kindLabel =
    mediaType === 'video'
      ? '视频'
      : mediaType === 'voice'
        ? '语音'
        : mediaType === 'files'
          ? '文件'
          : ctx.hadFaceTag || mediaType === 'sticker'
            ? '表情包'
            : '图片';
  const namePart = fileName ? `:${fileName}` : '';
  const meta =
    mediaType === 'video'
      ? formatVideoMetaSummary({
          dimensions,
          sizeText: rawSizeText,
          durationSec: entry?.durationSec,
        })
      : [dimensions, rawSizeText].filter(Boolean).join(', ');

  return `[${kindLabel}${namePart}${meta ? ` (${meta})` : ''}${error ? ` (下载失败: ${error})` : ''}${rawUrl ? ` 直链: ${rawUrl}` : ' 无下载地址'}]`;
}

interface ParsedForwardRelatedItem {
  senderName?: string;
  messageType?: string;
  rawTextLines: string[];
  attachments: ParsedForwardAttachment[];
}

interface ParsedForwardNode {
  index: number;
  senderName?: string;
  rawTextLines: string[];
  attachments: ParsedForwardAttachment[];
  relatedMessages: ParsedForwardRelatedItem[];
}

interface ParsedForwardDocument {
  headerLines: string[];
  nodes: ParsedForwardNode[];
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') {
    start++;
  }
  let end = lines.length;
  while (end > start && lines[end - 1]!.trim() === '') {
    end--;
  }
  return lines.slice(start, end);
}

function parseForwardDocument(content: string): ParsedForwardDocument {
  const lines = content.split(/\r?\n/);
  const headerLines: string[] = [];
  const nodes: ParsedForwardNode[] = [];
  let currentNode: ParsedForwardNode | null = null;
  let currentRelated: ParsedForwardRelatedItem | null = null;
  let inRelated = false;

  const flushRelated = (): void => {
    if (currentNode && currentRelated) {
      currentRelated.rawTextLines = trimBlankLines(currentRelated.rawTextLines);
      if (
        currentRelated.rawTextLines.length > 0 ||
        currentRelated.attachments.length > 0 ||
        currentRelated.senderName ||
        currentRelated.messageType
      ) {
        currentNode.relatedMessages.push(currentRelated);
      }
    }
    currentRelated = null;
  };

  for (const line of lines) {
    const headerMatch = FORWARD_NODE_HEADER_RE.exec(line);
    if (headerMatch) {
      flushRelated();
      if (currentNode) {
        currentNode.rawTextLines = trimBlankLines(currentNode.rawTextLines);
        nodes.push(currentNode);
      }
      currentNode = {
        index: Number(headerMatch[1]),
        rawTextLines: [],
        attachments: [],
        relatedMessages: [],
      };
      inRelated = false;
      continue;
    }

    if (!currentNode) {
      headerLines.push(line);
      continue;
    }

    if (!inRelated && FORWARD_RELATED_LINE_RE.test(line)) {
      inRelated = true;
      currentRelated = null;
      continue;
    }

    if (inRelated) {
      if (FORWARD_RELATED_ITEM_RE.test(line)) {
        flushRelated();
        currentRelated = {
          rawTextLines: [],
          attachments: [],
        };
        continue;
      }

      if (line.trim() === '') {
        continue;
      }

      if (!currentRelated) {
        currentRelated = {
          rawTextLines: [],
          attachments: [],
        };
      }

      const relMsgTypeMatch = FORWARD_MSG_TYPE_LINE_RE.exec(line);
      if (relMsgTypeMatch) {
        const msgType = nonEmpty(relMsgTypeMatch[1]);
        if (msgType && !currentRelated.messageType) {
          currentRelated.messageType = msgType;
        }
        continue;
      }

      const relSenderMatch = FORWARD_SENDER_LINE_RE.exec(line);
      if (relSenderMatch) {
        const sender = nonEmpty(relSenderMatch[1]);
        if (sender && !currentRelated.senderName) {
          currentRelated.senderName = sender;
        }
        continue;
      }

      if (FORWARD_ATTACHMENT_LINE_RE.test(line)) {
        const parsedAtt = parseForwardAttachmentLine(line);
        if (parsedAtt) {
          currentRelated.attachments.push(parsedAtt);
        }
        continue;
      }

      const relContentMatch = FORWARD_CONTENT_LINE_RE.exec(line);
      if (relContentMatch) {
        const part = (relContentMatch[1] ?? '').trim();
        if (part !== '' || currentRelated.rawTextLines.length > 0) {
          currentRelated.rawTextLines.push(part);
        }
        continue;
      }

      currentRelated.rawTextLines.push(line.trim());
      continue;
    }

    const senderMatch = FORWARD_SENDER_LINE_RE.exec(line);
    if (senderMatch) {
      const sender = nonEmpty(senderMatch[1]);
      if (sender && !currentNode.senderName) {
        currentNode.senderName = sender;
      }
      continue;
    }

    if (FORWARD_ATTACHMENT_LINE_RE.test(line)) {
      const parsedAtt = parseForwardAttachmentLine(line);
      if (parsedAtt) {
        currentNode.attachments.push(parsedAtt);
      }
      continue;
    }

    const contentMatch = FORWARD_CONTENT_LINE_RE.exec(line);
    if (contentMatch) {
      const firstPart = contentMatch[1] ?? '';
      if (firstPart.trim() !== '' || currentNode.rawTextLines.length > 0) {
        currentNode.rawTextLines.push(firstPart);
      }
      continue;
    }

    if (line.trim() === '' && currentNode.rawTextLines.length === 0) {
      continue;
    }
    currentNode.rawTextLines.push(line);
  }

  flushRelated();
  if (currentNode) {
    currentNode.rawTextLines = trimBlankLines(currentNode.rawTextLines);
    nodes.push(currentNode);
  }

  return {
    headerLines: trimBlankLines(headerLines),
    nodes,
  };
}

/**
 * 规整合并转发中的卡片节点与嵌套合并转发折叠占位：
 * - 嵌套合并转发（`[卡片消息] 合并转发消息` + `摘要: [聊天记录]` + 重复尾行）折叠为清晰单行占位；
 * - 普通卡片节点去除 `[消息类型] 卡片消息` 元信息行与尾部重复的 `[卡片消息] <名称> 摘要:<摘要>` 摘要行；
 * - 非卡片节点原样保留，不影响 `[消息类型] 引用消息` 单独出现时的既有行为。
 */
function normalizeForwardCardLines(lines: string[], hasAttachments: boolean): string[] {
  if (lines.length === 0) return lines;

  const hasCardTypeLine = lines.some((l) => /^\s*\[消息类型\]\s*卡片消息\s*$/.test(l));
  const hasNestedForwardCardLine = lines.some((l) =>
    /^\s*\[卡片消息\]\s*合并转发消息(?:\s+摘要\s*:\s*\[聊天记录\])?\s*$/.test(l)
  );
  if (!hasCardTypeLine && !hasNestedForwardCardLine) {
    return lines;
  }

  const withoutType = lines.filter((l) => !/^\s*\[消息类型\]\s*卡片消息\s*$/.test(l));
  const nonEmptyLines = withoutType.map((l) => l.trim()).filter(Boolean);

  if (
    !hasAttachments &&
    hasNestedForwardCardLine &&
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every(
      (l) =>
        /^\[卡片消息\]\s*合并转发消息(?:\s+摘要\s*:\s*\[聊天记录\])?$/.test(l) ||
        /^摘要\s*:\s*\[聊天记录\]$/.test(l)
    )
  ) {
    return ['[嵌套合并转发（平台未展开，无法查看内容）]'];
  }

  // 去除普通卡片节点末尾重复的 `[卡片消息] <名称> 摘要:<摘要>` 汇总行
  const cleaned = trimBlankLines(withoutType);
  if (cleaned.length >= 2) {
    const lastLine = cleaned[cleaned.length - 1]!.trim();
    const dupMatch = /^\[卡片消息\]\s*(.+?)\s+摘要\s*:\s*(.+)$/.exec(lastLine);
    if (dupMatch) {
      const cardName = dupMatch[1]!.trim();
      const summary = dupMatch[2]!.trim();
      const earlier = cleaned.slice(0, -1).map((l) => l.trim());
      const hasNameLine = earlier.some((l) => l === `[卡片消息] ${cardName}`);
      const hasSummaryLine = earlier.some((l) => {
        const m = /^摘要\s*:\s*(.+)$/.exec(l);
        return Boolean(m && m[1]!.trim() === summary);
      });
      if (hasNameLine && hasSummaryLine) {
        return trimBlankLines(cleaned.slice(0, -1));
      }
    }
  }

  return cleaned;
}

function collectNodeXmlContext(rawTextLines: string[]): {
  hadFaceTag: boolean;
  hadAttachmentTag: boolean;
  hasStickerFaceTag: boolean;
  referencedAttachmentIndices: Set<number>;
  hasUnindexedAttachmentTag: boolean;
} {
  let hadFaceTag = false;
  let hadAttachmentTag = false;
  let hasStickerFaceTag = false;
  const referencedAttachmentIndices = new Set<number>();
  let hasUnindexedAttachmentTag = false;

  for (const line of rawTextLines) {
    if (!hasFaceXmlTag(line) && !hasAttachmentXmlTag(line)) continue;
    FORWARD_INLINE_XML_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FORWARD_INLINE_XML_TAG_RE.exec(line)) !== null) {
      const tag = m[0];
      if (tag.startsWith('<attachmentType')) {
        hadAttachmentTag = true;
        const idx = parseAttachmentXmlIndex(tag);
        if (idx !== undefined) {
          referencedAttachmentIndices.add(idx);
        } else {
          hasUnindexedAttachmentTag = true;
        }
      } else {
        hadFaceTag = true;
        if (FORWARD_FACE_TYPE_6_RE.test(tag) || !extractSingleFaceXmlText(tag)) {
          hasStickerFaceTag = true;
        }
      }
    }
  }

  return {
    hadFaceTag,
    hadAttachmentTag,
    hasStickerFaceTag,
    referencedAttachmentIndices,
    hasUnindexedAttachmentTag,
  };
}

/**
 * 将节点正文与附件做单趟顺序就地转换：
 * - `<attachmentType=...,attachmentIndex=N,...>` 就地替换为对应附件（无匹配附件时回退解码 `description.text`）；
 * - `<faceType=...>` 就地替换为表情包附件或 `[表情: <ext.text>]`；
 * - 未被就地消费的附件按原顺序追加在后。
 */
function renderForwardInlineContent(
  rawTextLines: string[],
  attachments: ParsedForwardAttachment[],
  options?: FormatForwardMessageOptions
): string[] {
  const xmlCtx = collectNodeXmlContext(rawTextLines);

  const renderedAttachments = attachments.map((att, idx) => {
    const entry = att.rawUrl ? options?.resolvedEntries?.get(att.rawUrl) : undefined;
    const replacement = att.rawUrl ? options?.replacements?.get(att.rawUrl) : undefined;
    const isStickerFaceCtx =
      xmlCtx.hasStickerFaceTag &&
      !xmlCtx.referencedAttachmentIndices.has(idx) &&
      !xmlCtx.hasUnindexedAttachmentTag;
    return renderForwardAttachment(att, entry, {
      hadFaceTag: isStickerFaceCtx,
      getFaceByMd5: options?.getFaceByMd5,
      replacement,
    });
  });

  const consumedAttachments = new Set<number>();
  const processedLines: string[] = [];

  for (const line of rawTextLines) {
    if (!hasFaceXmlTag(line) && !hasAttachmentXmlTag(line)) {
      processedLines.push(line);
      continue;
    }

    FORWARD_INLINE_XML_TAG_RE.lastIndex = 0;
    const replaced = line.replace(FORWARD_INLINE_XML_TAG_RE, (match) => {
      if (match.startsWith('<attachmentType')) {
        const declaredIdx = parseAttachmentXmlIndex(match);
        if (
          declaredIdx !== undefined &&
          declaredIdx < renderedAttachments.length &&
          !consumedAttachments.has(declaredIdx)
        ) {
          consumedAttachments.add(declaredIdx);
          return renderedAttachments[declaredIdx]!;
        }
        if (declaredIdx === undefined) {
          const nextIdx = renderedAttachments.findIndex((_, idx) => !consumedAttachments.has(idx));
          if (nextIdx >= 0) {
            consumedAttachments.add(nextIdx);
            return renderedAttachments[nextIdx]!;
          }
        }
        return extractAttachmentXmlDescriptionText(match) ?? '';
      }

      const isFaceType6 = FORWARD_FACE_TYPE_6_RE.test(match);
      const faceText = extractSingleFaceXmlText(match);
      if (isFaceType6 || !faceText) {
        const stickerAttIdx = attachments.findIndex(
          (att, idx) =>
            !consumedAttachments.has(idx) &&
            !xmlCtx.referencedAttachmentIndices.has(idx) &&
            (att.mediaType === 'image' || att.mediaType === 'sticker')
        );
        if (stickerAttIdx >= 0) {
          consumedAttachments.add(stickerAttIdx);
          return renderedAttachments[stickerAttIdx]!;
        }
      }

      if (faceText) {
        return `[表情: ${faceText}]`;
      }
      return '';
    });

    const normalized = replaced
      .replace(/\]\s*\[/g, '] [')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (normalized !== '') {
      processedLines.push(normalized);
    }
  }

  const trimmedTextLines = trimBlankLines(processedLines);
  const unconsumedAttachments = renderedAttachments.filter((_, idx) => !consumedAttachments.has(idx));

  const contentLines: string[] = [];
  if (trimmedTextLines.length > 0) {
    if (trimmedTextLines.length === 1 && unconsumedAttachments.length > 0) {
      contentLines.push(`${trimmedTextLines[0]} ${unconsumedAttachments.join(' ')}`);
    } else {
      contentLines.push(...trimmedTextLines, ...unconsumedAttachments);
    }
  } else if (unconsumedAttachments.length > 0) {
    contentLines.push(...unconsumedAttachments);
  } else if (xmlCtx.hadFaceTag) {
    contentLines.push('[表情]');
  }

  return contentLines;
}

/**
 * 解析并清洗重构 QQ 官方 `message_type=102` 合并转发文本（剥离冗余标签与 `<faceType=...>` / `<attachmentType=...>` 壳，
 * 按 `1. 发送者: 内容/附件` 重排；已落盘附件仅展示本地路径，未落盘/失败保留选项 A 真实直链）。
 */
export function formatForwardMessageContent(
  content: string,
  options?: FormatForwardMessageOptions
): string {
  if (!content || typeof content !== 'string') return '';
  if (content.trim() === '') return '';

  const doc = parseForwardDocument(content);

  // 兼容分支：无 `=== 消息 N ===` 头的散装 `[附件k] ... URL:...` 片段
  if (doc.nodes.length === 0) {
    const outLines = content.split(/\r?\n/).map((line) => {
      if (!FORWARD_ATTACHMENT_LINE_RE.test(line)) {
        return line;
      }
      const parsed = parseForwardAttachmentLine(line);
      if (!parsed) return line;
      const entry = parsed.rawUrl ? options?.resolvedEntries?.get(parsed.rawUrl) : undefined;
      const replacement = parsed.rawUrl ? options?.replacements?.get(parsed.rawUrl) : undefined;
      return renderForwardAttachment(parsed, entry, {
        hadFaceTag: false,
        getFaceByMd5: options?.getFaceByMd5,
        replacement,
      });
    });
    return outLines.join('\n');
  }

  const outLines: string[] = [...doc.headerLines];

  for (const node of doc.nodes) {
    let baseLines = normalizeForwardCardLines(node.rawTextLines, node.attachments.length > 0);
    // 仅当存在结构化 `[关联消息]` 块并转为 `[引用回复: "..."]` 时，剥离节点顶层冗余的 `[消息类型] 引用消息`
    if (node.relatedMessages.length > 0) {
      baseLines = trimBlankLines(
        baseLines.filter((l) => !/^\s*\[消息类型\]\s*引用消息\s*$/.test(l))
      );
    }

    const contentLines = renderForwardInlineContent(baseLines, node.attachments, options);

    if (node.relatedMessages.length > 0) {
      const quoteTags = node.relatedMessages.map((rel) => {
        const relLines = renderForwardInlineContent(rel.rawTextLines, rel.attachments, options);
        const relBody = relLines.join(' ').trim();
        const quoteInner =
          rel.senderName && relBody
            ? `${rel.senderName}: ${relBody}`
            : relBody || rel.senderName || '';
        return quoteInner ? `[引用回复: "${quoteInner}"]` : '[引用回复]';
      });
      const quotedPrefix = quoteTags.join(' ');
      if (contentLines.length > 0) {
        contentLines[0] = `${quotedPrefix} ${contentLines[0]}`;
      } else {
        contentLines.push(quotedPrefix);
      }
    }

    if (contentLines.length === 0) {
      outLines.push(
        node.senderName
          ? `${node.index}. ${node.senderName}: [未展开或不支持的消息内容]`
          : `${node.index}. [空消息]`
      );
      continue;
    }

    const prefix = node.senderName ? `${node.index}. ${node.senderName}: ` : `${node.index}. `;
    outLines.push(`${prefix}${contentLines[0]}`);
    for (let i = 1; i < contentLines.length; i++) {
      outLines.push(`   ${contentLines[i]}`);
    }
  }

  return outLines.join('\n');
}

function normalizeDownloadLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return Number.POSITIVE_INFINITY;
  }
  if (limit === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(limit)) {
    return limit > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return Math.max(0, Math.floor(limit));
}

function parseForwardResolveArgs(
  limitOrOptions?: number | ResolveEmbeddedForwardOptions,
  maybeLogger?: InboundMediaLogger
): {
  limit: number;
  logger?: InboundMediaLogger;
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
} {
  if (typeof limitOrOptions === 'number') {
    return {
      limit: normalizeDownloadLimit(limitOrOptions),
      logger: maybeLogger,
    };
  }
  if (limitOrOptions && typeof limitOrOptions === 'object') {
    const obj = limitOrOptions as Record<string, unknown>;
    const looksLikeOptions =
      'limit' in obj || 'logger' in obj || 'getFaceByMd5' in obj;
    if (!looksLikeOptions && ('warn' in obj || 'info' in obj || 'debug' in obj || 'error' in obj)) {
      return {
        limit: Number.POSITIVE_INFINITY,
        logger: limitOrOptions as InboundMediaLogger,
      };
    }
    const opts = limitOrOptions as ResolveEmbeddedForwardOptions;
    return {
      limit: normalizeDownloadLimit(opts.limit),
      logger: opts.logger ?? maybeLogger,
      getFaceByMd5: opts.getFaceByMd5,
    };
  }
  return {
    limit: Number.POSITIVE_INFINITY,
    logger: maybeLogger,
  };
}

/**
 * 合并转发内嵌媒体落盘明细 → 统一附件描述符，供入站消息入库 `attachments`。
 *
 * - `remote.url` 保留官方真实响应地址（含 rkey 凭证），仅在展示层做清洗；
 * - 仅成功落盘的 entry 带 `local`；下载失败或无 URL 的 entry 标记 `unavailable`；
 * - 同一落盘路径（SHA-256 指纹复用命中）只保留首次出现的描述符。
 */
export function descriptorsFromForwardEntries(
  entries: ReadonlyArray<EmbeddedForwardAttachmentEntry>
): AttachmentDescriptor[] {
  const kindByMedia: Record<ForwardMediaType, AttachmentKind> = {
    image: 'image',
    sticker: 'sticker',
    video: 'video',
    voice: 'record',
    files: 'file',
  };

  const out: AttachmentDescriptor[] = [];
  const seenPaths = new Set<string>();

  for (const entry of entries) {
    const localPath = entry.localPath?.trim();
    if (localPath) {
      if (seenPaths.has(localPath)) continue;
      seenPaths.add(localPath);
    }

    const format = localPath
      ? detectSavedFormat(localPath, inferExtFromFilename(entry.fileName))
      : undefined;
    const size =
      typeof entry.localSize === 'number' && entry.localSize > 0 ? entry.localSize : undefined;

    out.push({
      kind: kindByMedia[entry.mediaType],
      origin: 'inbound',
      remote: { url: entry.rawUrl },
      ...(entry.fileName ? { fileName: entry.fileName } : {}),
      ...(localPath
        ? {
            local: {
              path: localPath,
              ...(format ? { format } : {}),
              ...(size !== undefined ? { size } : {}),
              ...(entry.md5 ? { md5: entry.md5 } : {}),
              ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
              ...(entry.mediaType === 'video' && entry.dimensions
                ? { dimensions: entry.dimensions }
                : {}),
              ...(entry.mediaType === 'video' &&
              typeof entry.durationSec === 'number' &&
              Number.isFinite(entry.durationSec)
                ? { durationSec: entry.durationSec }
                : {}),
            },
          }
        : {}),
      ...(entry.face ? { face: entry.face } : {}),
      ...(entry.error ? { unavailable: entry.error } : {}),
    });
  }

  return out;
}

/**
 * 从官方 `message_type=102` 展开文本中提取全量 `[附件...] ... URL:https://...` 内嵌媒体
 * （图片/表情/视频/语音/文件）并裸 GET 落盘（不设默认数量或大小上限），返回排版后正文与区分视觉图的路径集合。
 */
export async function resolveEmbeddedForwardMedia(
  content: string,
  peer: string,
  mediaManager?: MediaStorageManager,
  options?: ResolveEmbeddedForwardOptions
): Promise<ResolveEmbeddedForwardMediaResult>;
export async function resolveEmbeddedForwardMedia(
  content: string,
  peer: string,
  mediaManager: MediaStorageManager | undefined,
  limit?: number,
  logger?: InboundMediaLogger
): Promise<ResolveEmbeddedForwardMediaResult>;
export async function resolveEmbeddedForwardMedia(
  content: string,
  peer: string,
  mediaManager?: MediaStorageManager,
  limitOrOptions?: number | ResolveEmbeddedForwardOptions,
  maybeLogger?: InboundMediaLogger
): Promise<ResolveEmbeddedForwardMediaResult> {
  const replacements = new Map<string, string>();
  const localPaths: string[] = [];
  const entries: EmbeddedForwardAttachmentEntry[] = [];

  if (!content || typeof content !== 'string') {
    return {
      formattedContent: '',
      sanitizedContent: '',
      replacements,
      localPaths,
      entries,
    };
  }

  const { limit: maxDownloads, logger, getFaceByMd5 } = parseForwardResolveArgs(
    limitOrOptions,
    maybeLogger
  );
  let downloadedCount = 0;
  const cachedByUrl = new Map<string, EmbeddedForwardAttachmentEntry>();

  const doc = parseForwardDocument(content);
  const workItems: Array<{ parsed: ParsedForwardAttachment; hadFaceTag: boolean }> = [];

  if (doc.nodes.length > 0) {
    for (const node of doc.nodes) {
      const xmlCtx = collectNodeXmlContext(node.rawTextLines);
      for (const [idx, att] of node.attachments.entries()) {
        if (att.rawUrl) {
          const isStickerFaceCtx =
            xmlCtx.hasStickerFaceTag &&
            !xmlCtx.referencedAttachmentIndices.has(idx) &&
            !xmlCtx.hasUnindexedAttachmentTag;
          workItems.push({ parsed: att, hadFaceTag: isStickerFaceCtx });
        }
      }
      for (const rel of node.relatedMessages) {
        const relCtx = collectNodeXmlContext(rel.rawTextLines);
        for (const [idx, att] of rel.attachments.entries()) {
          if (att.rawUrl) {
            const isStickerFaceCtx =
              relCtx.hasStickerFaceTag &&
              !relCtx.referencedAttachmentIndices.has(idx) &&
              !relCtx.hasUnindexedAttachmentTag;
            workItems.push({ parsed: att, hadFaceTag: isStickerFaceCtx });
          }
        }
      }
    }
  } else {
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseForwardAttachmentLine(line);
      if (parsed?.rawUrl) {
        workItems.push({ parsed, hadFaceTag: false });
      }
    }
  }

  function baseEntry(
    parsed: ParsedForwardAttachment,
    rawUrl: string
  ): Omit<EmbeddedForwardAttachmentEntry, 'downloaded'> {
    return {
      rawUrl,
      sanitizedUrl: sanitizeUrlForLog(rawUrl),
      mediaType: parsed.mediaType,
      ...(parsed.attachmentType ? { attachmentType: parsed.attachmentType } : {}),
      ...(parsed.fileName ? { fileName: parsed.fileName } : {}),
      ...(parsed.dimensions ? { dimensions: parsed.dimensions } : {}),
      ...(parsed.sizeText ? { sizeText: parsed.sizeText } : {}),
    };
  }

  function cloneEntry(
    source: EmbeddedForwardAttachmentEntry,
    parsed: ParsedForwardAttachment
  ): EmbeddedForwardAttachmentEntry {
    return {
      ...source,
      ...(parsed.attachmentType ? { attachmentType: parsed.attachmentType } : {}),
      ...(parsed.fileName ? { fileName: parsed.fileName } : {}),
      ...(parsed.dimensions ? { dimensions: parsed.dimensions } : {}),
      ...(parsed.sizeText ? { sizeText: parsed.sizeText } : {}),
    };
  }

  /** 合并转发 `[附件k]` 的媒体类型 → 统一本地化管线可识别的结构化附件形态。 */
  function toLocalizableAttachment(
    parsed: ParsedForwardAttachment,
    rawUrl: string
  ): QQAttachment {
    const contentType =
      parsed.mediaType === 'video'
        ? 'video'
        : parsed.mediaType === 'voice'
          ? 'voice'
          : parsed.mediaType === 'files'
            ? 'file'
            : 'image';
    return {
      content_type: contentType,
      ...(parsed.fileName ? { filename: parsed.fileName } : {}),
      url: rawUrl,
    };
  }

  async function downloadEntry(
    parsed: ParsedForwardAttachment,
    rawUrl: string
  ): Promise<EmbeddedForwardAttachmentEntry> {
    const base = baseEntry(parsed, rawUrl);

    // 与直发 / 引用共用同一套落盘 + 检视 + 表情匹配管线
    const descriptor = await localizeInboundAttachment(toLocalizableAttachment(parsed, rawUrl), {
      peer,
      mediaManager: mediaManager!,
      ...(logger ? { logger } : {}),
      forceSticker: parsed.mediaType === 'sticker',
      ...(getFaceByMd5 ? { getFaceByMd5 } : {}),
    });

    const localPath = descriptor.local?.path;
    if (!localPath) {
      const safeError = descriptor.unavailable || 'download_failed';
      logger?.warn?.(
        `[InboundMedia] 合并转发内嵌媒体下载失败 (peer: ${peer}, type: ${parsed.mediaType}, url: ${base.sanitizedUrl}): ${safeError}`
      );
      return {
        ...base,
        downloaded: false,
        error: safeError,
      };
    }

    const md5 =
      descriptor.local?.md5?.trim().toLowerCase() ||
      computeFileMd5(localPath)?.toLowerCase() ||
      undefined;
    const face =
      descriptor.face ||
      resolveEntryFaceMeta({ ...base, md5, downloaded: false }, parsed.mediaType, localPath, getFaceByMd5);

    return {
      ...base,
      localPath,
      ...(descriptor.local?.size !== undefined ? { localSize: descriptor.local.size } : {}),
      ...(descriptor.local?.durationSec !== undefined
        ? { durationSec: descriptor.local.durationSec }
        : {}),
      ...(descriptor.local?.fingerprint ? { fingerprint: descriptor.local.fingerprint } : {}),
      ...(md5 ? { md5 } : {}),
      ...(face ? { face } : {}),
      downloaded: true,
    };
  }

  if (Number.isFinite(maxDownloads)) {
    // 显式 limit：逐条按出现顺序处理，确保“前 N 个成功下载”的既有语义完全不变
    for (const { parsed, hadFaceTag } of workItems) {
      const rawUrl = parsed.rawUrl!;

      if (cachedByUrl.has(rawUrl)) {
        const cloned = cloneEntry(cachedByUrl.get(rawUrl)!, parsed);
        entries.push(cloned);
        if (!replacements.has(rawUrl)) {
          replacements.set(
            rawUrl,
            renderForwardAttachment(parsed, cloned, { hadFaceTag, getFaceByMd5 })
          );
        }
        continue;
      }

      if (!mediaManager || downloadedCount >= maxDownloads) {
        const unresolvedEntry: EmbeddedForwardAttachmentEntry = {
          ...baseEntry(parsed, rawUrl),
          downloaded: false,
        };
        cachedByUrl.set(rawUrl, unresolvedEntry);
        entries.push(unresolvedEntry);
        replacements.set(
          rawUrl,
          renderForwardAttachment(parsed, unresolvedEntry, { hadFaceTag, getFaceByMd5 })
        );
        continue;
      }

      const entry = await downloadEntry(parsed, rawUrl);
      if (entry.downloaded) downloadedCount++;
      if (entry.localPath && !localPaths.includes(entry.localPath)) {
        localPaths.push(entry.localPath);
      }
      cachedByUrl.set(rawUrl, entry);
      entries.push(entry);
      replacements.set(
        rawUrl,
        renderForwardAttachment(parsed, entry, { hadFaceTag, getFaceByMd5 })
      );
    }
  } else {
    // 默认无 limit：有限并发 4 下载，最终按出现顺序组装 entries / replacements / localPaths
    type ForwardPlan =
      | { kind: 'download' | 'unresolved'; parsed: ParsedForwardAttachment; hadFaceTag: boolean; rawUrl: string }
      | {
          kind: 'duplicate';
          parsed: ParsedForwardAttachment;
          hadFaceTag: boolean;
          rawUrl: string;
          sourceIndex: number;
        };

    const plans: ForwardPlan[] = [];
    const sourceIndexByUrl = new Map<string, number>();
    for (const { parsed, hadFaceTag } of workItems) {
      const rawUrl = parsed.rawUrl!;
      const sourceIndex = sourceIndexByUrl.get(rawUrl);
      if (sourceIndex !== undefined) {
        plans.push({ kind: 'duplicate', parsed, hadFaceTag, rawUrl, sourceIndex });
        continue;
      }
      sourceIndexByUrl.set(rawUrl, plans.length);
      plans.push({ kind: mediaManager ? 'download' : 'unresolved', parsed, hadFaceTag, rawUrl });
    }

    const resolved = new Array<EmbeddedForwardAttachmentEntry | undefined>(plans.length);
    const downloadTargets: number[] = [];
    plans.forEach((plan, index) => {
      if (plan.kind === 'download') downloadTargets.push(index);
    });

    await mapWithConcurrency(downloadTargets, 4, async (index) => {
      const plan = plans[index]!;
      if (plan.kind !== 'download') return;
      resolved[index] = await downloadEntry(plan.parsed, plan.rawUrl);
    });

    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index]!;
      let entry: EmbeddedForwardAttachmentEntry;

      if (plan.kind === 'duplicate') {
        const sourcePlan = plans[plan.sourceIndex]!;
        const sourceEntry =
          sourcePlan.kind === 'download' ? resolved[plan.sourceIndex] : undefined;
        entry = sourceEntry
          ? cloneEntry(sourceEntry, plan.parsed)
          : { ...baseEntry(plan.parsed, plan.rawUrl), downloaded: false };
      } else if (plan.kind === 'unresolved') {
        entry = { ...baseEntry(plan.parsed, plan.rawUrl), downloaded: false };
        cachedByUrl.set(plan.rawUrl, entry);
      } else {
        entry = resolved[index]!;
        cachedByUrl.set(plan.rawUrl, entry);
      }

      if (entry.localPath && !localPaths.includes(entry.localPath)) {
        localPaths.push(entry.localPath);
      }
      entries.push(entry);
      if (!replacements.has(plan.rawUrl)) {
        replacements.set(
          plan.rawUrl,
          renderForwardAttachment(plan.parsed, entry, {
            hadFaceTag: plan.hadFaceTag,
            getFaceByMd5,
          })
        );
      }
    }
  }

  const formattedContent = formatForwardMessageContent(content, {
    resolvedEntries: cachedByUrl,
    getFaceByMd5,
  });

  return {
    formattedContent,
    sanitizedContent: formattedContent,
    replacements,
    localPaths,
    entries,
  };
}

/** 兼容别名，等价于 {@link resolveEmbeddedForwardMedia} */
export const resolveEmbeddedForwardImages = resolveEmbeddedForwardMedia;
