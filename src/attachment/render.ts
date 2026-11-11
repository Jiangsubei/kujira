/**
 * kujira: 唯一附件文本渲染入口。
 *
 * 入站、出站、引用重解析、历史重放共用同一套安全文案：
 * - 命中表情库 → `[表情包: <face_id> (情绪: <mood>) 路径: <local_path>]`（入站/出站完全一致）；
 * - 普通图片 → `[图片:<local_path>]`；无本地路径时严禁输出带 query 凭证的 `remote.url`！
 * - 文件（含以 `content_type='file'` 下发的 `.png` 等文件）→ `[文件:<name> 已保存: <local_path>]`；
 * - 语音 → 结合 `local.path` 与 `remote.asrReferText` 渲染；
 * - 合并转发 → 适配官方 `message_type=102` 合并转发占位渲染；
 * - 一律展示 OS 路径，绝不把 `file:///` URI 或带 `rkey` 凭证 URL 暴露给模型或历史。
 */

import * as path from 'node:path';
import type { AttachmentDescriptor } from './types.js';

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
  if (descriptor.local?.path) {
    return `[表情包:${descriptor.local.path}]`;
  }
  if (descriptor.unavailable) {
    return '[表情包 (入站落盘失败)]';
  }
  return '[表情包]';
}

function renderImage(descriptor: AttachmentDescriptor): string {
  // 普通图片若命中本地表情库（MD5 命中），与表情包一致输出语义占位符（附带本地路径）
  if (descriptor.face?.id) {
    return formatFacePlaceholder(descriptor.face, descriptor.local?.path);
  }
  if (descriptor.local?.path) {
    return `[图片:${descriptor.local.path}]`;
  }
  // 安全红线：严禁将带 query 凭证的 remote.url 直接输出给模型，仅输出脱敏占位
  const safeName = descriptor.fileName?.trim() || '';
  const safeRemoteId = (descriptor.remote?.fileUuid || descriptor.remote?.fileId || '').trim();
  const safeLabel = safeName || safeRemoteId;
  if (descriptor.unavailable) {
    return safeLabel ? `[图片:${safeLabel} (入站落盘失败)]` : '[图片 (入站落盘失败)]';
  }
  return safeLabel ? `[图片:${safeLabel}]` : '[图片]';
}

function renderFile(descriptor: AttachmentDescriptor): string {
  const name =
    descriptor.fileName?.trim() ||
    (descriptor.local?.path ? path.basename(descriptor.local.path) : '') ||
    '未知文件';
  if (descriptor.local?.path) {
    return `[文件:${name} 已保存: ${descriptor.local.path}]`;
  }
  if (descriptor.unavailable) {
    return `[文件:${name} (入站落盘失败)]`;
  }
  return `[文件:${name}]`;
}

function renderRecord(descriptor: AttachmentDescriptor): string {
  const localPath = descriptor.local?.path?.trim() || '';
  const asrText = descriptor.remote?.asrReferText?.trim() || '';
  const asrPart = asrText ? ` (语音转文字: "${asrText}")` : '';

  if (localPath) {
    return `[语音 已保存: ${localPath}${asrPart}]`;
  }
  if (descriptor.unavailable) {
    return `[语音${asrPart} (入站落盘失败)]`;
  }
  if (asrPart) {
    return `[语音${asrPart}]`;
  }
  return '[语音]';
}

function renderVideo(descriptor: AttachmentDescriptor): string {
  const rawFileName = descriptor.fileName?.trim() || '';
  const remoteId = (descriptor.remote?.fileUuid || descriptor.remote?.fileId || '').trim();
  const isRedundantName = Boolean(rawFileName && remoteId && rawFileName === remoteId);
  const namePart = rawFileName && !isRedundantName ? `:${rawFileName}` : '';

  if (descriptor.local?.path) {
    return `[视频${namePart} 已保存: ${descriptor.local.path}]`;
  }
  if (descriptor.unavailable) {
    const idPart = remoteId ? ` (ID:${remoteId})` : '';
    return `[视频${namePart}${idPart} (入站落盘失败)]`;
  }
  if (remoteId) {
    return `[视频${namePart} (ID:${remoteId})]`;
  }
  return `[视频${namePart}]`;
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
