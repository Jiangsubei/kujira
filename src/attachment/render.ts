/**
 * kujira: 唯一附件文本渲染入口。
 *
 * 入站、出站、引用重解析、历史重放共用同一套安全文案：
 * - 命中表情库 → `[表情包: <face_id> (情绪: <mood>) 路径: <local_path>]`（入站/出站完全一致）；
 * - 普通图片 → `[图片:<local_path>]`；
 * - 文件（含以 `content_type='file'` 下发的 `.png` 等文件）→ `[文件:<name> 已保存: <local_path>]`；
 * - 语音 → 结合 `local.path` 与 `remote.asrReferText` 渲染；
 * - 视频 → `[视频(:<name>) (<dimensions>, <size>, <duration>) 已保存: <local_path>]`（无分辨率/时长时保持简洁路径）；
 * - 合并转发 → 适配官方 `message_type=102` 合并转发占位渲染；
 * - 已落盘附件一律只展示 OS 路径（绝不输出 `file:///` URI 且不附加 URL）；未落盘或下载失败时展示真实直链 URL 供 Agent 处理。
 */

import * as path from 'node:path';
import type { AttachmentDescriptor } from './types.js';

/** 格式化附件字节大小（`< 1024 -> B`，`< 1MB -> KB`，其余 `MB`；非法或负数返回 `''`）。 */
export function formatAttachmentByteSize(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 格式化视频时长（无效或 `<= 0` 返回 `''`；`< 60` 保留至多一位小数；`>= 60` 按分秒输出）。 */
export function formatVideoDuration(seconds: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  if (seconds < 60) {
    return `${Number((Math.round(seconds * 10) / 10).toFixed(1))}s`;
  }
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const remSecs = totalSeconds % 60;
  return remSecs > 0 ? `${mins}m${remSecs}s` : `${mins}m`;
}

/** 组合视频元信息摘要（`分辨率, 大小, 时长`，无有效字段时返回 `''`）。 */
export function formatVideoMetaSummary(meta: {
  dimensions?: string;
  sizeText?: string;
  sizeBytes?: number;
  durationSec?: number;
}): string {
  const dimensions = meta.dimensions?.trim() || '';
  const resolvedSizeText =
    meta.sizeText?.trim() ||
    (typeof meta.sizeBytes === 'number' ? formatAttachmentByteSize(meta.sizeBytes) : '');
  const durationText =
    typeof meta.durationSec === 'number' ? formatVideoDuration(meta.durationSec) : '';
  return [dimensions, resolvedSizeText, durationText].filter(Boolean).join(', ');
}

function renderUnresolvedAttachment(
  basePrefix: string,
  unavailable?: string,
  url?: string
): string {
  const reason = unavailable?.trim();
  const resolvedUrl = url?.trim();
  if (reason) {
    return resolvedUrl
      ? `${basePrefix} (下载失败: ${reason}) 直链: ${resolvedUrl}]`
      : `${basePrefix} (入站落盘失败)]`;
  }
  return resolvedUrl ? `${basePrefix} 直链: ${resolvedUrl}]` : `${basePrefix}]`;
}

/** 格式化已收藏表情包语义占位符（支持附带本地路径）。 */
export function formatFacePlaceholder(
  face: { id: string; mood?: string | null },
  localPath?: string | null
): string {
  const moodPart =
    face.mood && typeof face.mood === 'string' && face.mood.trim()
      ? ` (情绪: ${face.mood.trim()})`
      : '';
  const pathPart =
    localPath && typeof localPath === 'string' && localPath.trim()
      ? ` 路径: ${localPath.trim()}`
      : '';
  return `[表情包: ${face.id}${moodPart}${pathPart}]`;
}

/** 清洗表情包 summary，去除外层方括号，如 "[动画表情]" -> "动画表情"。 */
export function cleanStickerSummary(summary?: string | null): string {
  if (!summary || typeof summary !== 'string') return '表情';
  const trimmed = summary.trim();
  const stripped = trimmed.replace(/^\[+|\]+$/g, '').trim();
  return stripped || '表情';
}

function renderSticker(descriptor: AttachmentDescriptor): string {
  if (descriptor.face?.id) {
    return formatFacePlaceholder(descriptor.face, descriptor.local?.path);
  }
  const localPath = descriptor.local?.path?.trim() || '';
  if (localPath) {
    return `[表情包:${localPath}]`;
  }
  return renderUnresolvedAttachment('[表情包', descriptor.unavailable, descriptor.remote?.url);
}

function renderImage(descriptor: AttachmentDescriptor): string {
  // 普通图片若命中本地表情库（MD5 命中），与表情包一致输出语义占位符（附带本地路径）
  if (descriptor.face?.id) {
    return formatFacePlaceholder(descriptor.face, descriptor.local?.path);
  }
  const localPath = descriptor.local?.path?.trim() || '';
  if (localPath) {
    return `[图片:${localPath}]`;
  }
  const safeName = descriptor.fileName?.trim() || '';
  const safeRemoteId =
    descriptor.remote?.fileUuid?.trim() || descriptor.remote?.fileId?.trim() || '';
  const safeLabel = safeName || safeRemoteId;
  const basePrefix = safeLabel ? `[图片:${safeLabel}` : '[图片';
  return renderUnresolvedAttachment(basePrefix, descriptor.unavailable, descriptor.remote?.url);
}

function renderFile(descriptor: AttachmentDescriptor): string {
  const localPath = descriptor.local?.path?.trim() || '';
  const name =
    descriptor.fileName?.trim() ||
    (localPath ? path.basename(localPath) : '') ||
    '未知文件';
  if (localPath) {
    return `[文件:${name} 已保存: ${localPath}]`;
  }
  return renderUnresolvedAttachment(`[文件:${name}`, descriptor.unavailable, descriptor.remote?.url);
}

function renderRecord(descriptor: AttachmentDescriptor): string {
  const localPath = descriptor.local?.path?.trim() || '';
  const asrText = descriptor.remote?.asrReferText?.trim() || '';
  const asrPart = asrText ? ` (语音转文字: "${asrText}")` : '';

  if (localPath) {
    return `[语音 已保存: ${localPath}${asrPart}]`;
  }
  const recordUrl = descriptor.remote?.voiceWavUrl?.trim() || descriptor.remote?.url?.trim();
  return renderUnresolvedAttachment(`[语音${asrPart}`, descriptor.unavailable, recordUrl);
}

function renderVideo(descriptor: AttachmentDescriptor): string {
  const rawFileName = descriptor.fileName?.trim() || '';
  const remoteId =
    descriptor.remote?.fileUuid?.trim() || descriptor.remote?.fileId?.trim() || '';
  const isRedundantName = Boolean(rawFileName && remoteId && rawFileName === remoteId);
  const namePart = rawFileName && !isRedundantName ? `:${rawFileName}` : '';

  const localPath = descriptor.local?.path?.trim() || '';
  if (localPath) {
    const hasDimensions = Boolean(descriptor.local?.dimensions?.trim());
    const hasValidDuration =
      typeof descriptor.local?.durationSec === 'number' &&
      Number.isFinite(descriptor.local.durationSec) &&
      descriptor.local.durationSec > 0;
    if (hasDimensions || hasValidDuration) {
      const meta = formatVideoMetaSummary({
        dimensions: descriptor.local?.dimensions,
        sizeBytes: descriptor.local?.size,
        durationSec: descriptor.local?.durationSec,
      });
      return `[视频${namePart}${meta ? ` (${meta})` : ''} 已保存: ${localPath}]`;
    }
    return `[视频${namePart} 已保存: ${localPath}]`;
  }
  const idPart = remoteId ? ` (ID:${remoteId})` : '';
  return renderUnresolvedAttachment(
    `[视频${namePart}${idPart}`,
    descriptor.unavailable,
    descriptor.remote?.url
  );
}

function renderForward(descriptor: AttachmentDescriptor): string {
  const summary = descriptor.summary?.trim();
  if (summary) {
    return `[合并转发: ${summary}]`;
  }
  const remoteId = (descriptor.remote?.fileUuid || descriptor.remote?.fileId || '').trim();
  if (remoteId) {
    return `[合并转发 (ID:${remoteId})]`;
  }
  return '[合并转发]';
}

/**
 * 渲染单个附件描述符；未知 kind 返回 null（由调用方兜底占位）。
 */
export function renderAttachment(descriptor: AttachmentDescriptor | null | undefined): string | null {
  if (!descriptor) return null;

  switch (descriptor.kind) {
    case 'sticker':
      return renderSticker(descriptor);
    case 'image':
      return renderImage(descriptor);
    case 'file':
      return renderFile(descriptor);
    case 'record':
      return renderRecord(descriptor);
    case 'video':
      return renderVideo(descriptor);
    case 'forward':
      return renderForward(descriptor);
    default:
      return null;
  }
}

/** 批量渲染；null 项直接跳过。 */
export function renderAttachments(
  descriptors: ReadonlyArray<AttachmentDescriptor>
): string[] {
  const out: string[] = [];
  for (const descriptor of descriptors) {
    const text = renderAttachment(descriptor);
    if (text) out.push(text);
  }
  return out;
}
