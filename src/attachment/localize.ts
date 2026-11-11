/**
 * kujira: 统一入站附件本地化管线（附件描述符级）
 *
 * 设计目的：把「结构化附件 → 落盘 → 检视 → 描述符」这条策略从各处入口收敛到一处，
 * 供以下入口共用，避免同一套下载/分类/去重/错误脱敏逻辑被重复实现：
 * - 直发消息 `C2C_MESSAGE_CREATE.attachments[]`（用户主动发送）；
 * - 引用消息 `msg_elements[].attachments[]`（实测：引用图片/视频时官方直接下发结构化附件）；
 * - 合并转发 `message_type=102` 的内嵌附件（文本解析后同样构造 `QQAttachment` 形态再走本模块）。
 *
 * 严格约束：
 * - 一律裸 GET（不附加 Authorization 头），不设体积上限；
 * - 日志与 `unavailable` 短错误字段严禁携带带 query / `rkey` 凭证的完整 URL；
 * - 已落盘附件只暴露 OS 路径，未落盘/失败由渲染层按选项 A 展示真实直链；
 * - 语音以 `content_type === 'voice'` 为准，优先 `voice_wav_url`，失败回退 `url`；
 * - 可选字段一律条件展开，描述符中绝不出现 `undefined` 键。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FaceRecord, QQAttachment } from '../types/index.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import {
  sanitizeUrlForLog,
  detectBufferExt,
  type MediaResourceType,
  type MediaStorageManager,
  type SaveResourceOptions,
} from '../storage/media.js';
import {
  describeAttachment,
  sanitizeAttachmentFileName,
} from './classify.js';
import type { AttachmentDescriptor, AttachmentFaceMeta } from './types.js';

export interface AttachmentLocalizeLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

export interface AttachmentLocalizeOptions {
  /** 方案 A 内部 peer（`user_<hash16>`），作为落盘子目录 */
  peer: string;
  mediaManager: MediaStorageManager;
  logger?: AttachmentLocalizeLogger;
  /** 严格表情包判定命中时，图片类附件落盘 `sticker/` 而非 `image/` */
  forceSticker?: boolean;
  /** 落盘后按 MD5 匹配本地表情库；命中启用且未删除的表情包时绑定 `descriptor.face` */
  getFaceByMd5?: (md5: string) => FaceRecord | null | undefined;
}

export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** 对异常信息执行 URL 凭证与敏感参数脱敏，严禁泄露 rkey/token/sig。 */
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '未知错误');
  const cleaned = raw
    .replace(/https?:\/\/[^\s"'<>)\]]+/gi, (match) => sanitizeUrlForLog(match))
    .replace(/([?&](?:rkey|auth_token|token|sig|sign|key)=)[^&\s"'<>)\]]+/gi, '$1***');
  return cleaned.slice(0, 200);
}

/** 净化外部传入文件名（防止路径穿越与非法字符）。 */
export function sanitizeInboundFilename(rawName?: unknown): string | undefined {
  return sanitizeAttachmentFileName(rawName);
}

export function inferExtFromFilename(name?: string): string | undefined {
  if (!name) return undefined;
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return ext || undefined;
}

export function inferExtFromUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  const clean = sanitizeUrlForLog(rawUrl);
  const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
  return match ? match[1]!.toLowerCase() : undefined;
}

export function replaceExtForWav(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const parsed = path.parse(fileName);
  const stem = parsed.name.trim();
  return stem ? `${stem}.wav` : 'voice.wav';
}

/** 读取落盘文件头部魔数判定真实格式，失败回退扩展名。 */
export function detectSavedFormat(localPath: string, fallbackExt?: string): string | undefined {
  try {
    const fd = fs.openSync(localPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      if (bytesRead > 0) {
        const magic = detectBufferExt(buf.subarray(0, bytesRead));
        if (magic) return magic;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 忽略读取异常，回退扩展名
  }
  const ext = path.extname(localPath).replace(/^\./, '').toLowerCase();
  return ext || fallbackExt;
}

export function readLocalSize(localPath: string, declaredSize?: number): number | undefined {
  try {
    const stat = fs.statSync(localPath);
    if (Number.isFinite(stat.size)) return stat.size;
  } catch {
    // ignore
  }
  return declaredSize !== undefined && Number.isFinite(declaredSize) ? declaredSize : undefined;
}

export function extractAttachmentDimensions(att: QQAttachment): string | undefined {
  if (
    typeof att.width === 'number' &&
    Number.isFinite(att.width) &&
    att.width > 0 &&
    typeof att.height === 'number' &&
    Number.isFinite(att.height) &&
    att.height > 0
  ) {
    return `${Math.round(att.width)}x${Math.round(att.height)}`;
  }
  return undefined;
}

export function normalizePositiveDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/** 启用且未删除的表情包记录 → 描述符可用的精简 face 元信息。 */
export function toActiveFaceMeta(
  face: FaceRecord | null | undefined
): AttachmentFaceMeta | undefined {
  if (!face || !face.enabled || face.deleted_at) return undefined;
  return {
    id: face.id,
    ...(face.mood ? { mood: face.mood } : {}),
    ...(face.tags && face.tags.length > 0 ? { tags: face.tags } : {}),
  };
}

/**
 * 单个结构化附件 → 落盘后的统一描述符（直发、引用、合并转发共用）。
 * 失败只标记 `unavailable`（已脱敏），绝不抛出。
 */
export async function localizeInboundAttachment(
  att: QQAttachment,
  options: AttachmentLocalizeOptions
): Promise<AttachmentDescriptor> {
  const { peer, mediaManager, logger, forceSticker = false, getFaceByMd5 } = options;
  const base = describeAttachment(att, 'inbound');
  const safeName = sanitizeInboundFilename(att.filename);
  const declaredSize = typeof att.size === 'number' && Number.isFinite(att.size) ? att.size : undefined;
  const dimensions = extractAttachmentDimensions(att);

  const rawUrl = isHttpUrl(att.url) ? att.url.trim() : undefined;
  const voiceWavUrl = isHttpUrl(att.voice_wav_url) ? att.voice_wav_url.trim() : undefined;

  const withFace = (descriptor: AttachmentDescriptor): AttachmentDescriptor => {
    if (!getFaceByMd5) return descriptor;
    if (descriptor.kind !== 'image' && descriptor.kind !== 'sticker') return descriptor;
    const md5 = descriptor.local?.md5?.trim().toLowerCase();
    if (!md5) return descriptor;
    const face = toActiveFaceMeta(getFaceByMd5(md5));
    return face ? { ...descriptor, face } : descriptor;
  };

  // 语音特殊规则：忽略响应头错报 audio/mp3，以 content_type === 'voice' 为准，优先拉取 voice_wav_url
  if (base.kind === 'record') {
    const candidates: Array<{ url: string; ext: string; filename?: string }> = [];
    if (voiceWavUrl) {
      candidates.push({
        url: voiceWavUrl,
        ext: 'wav',
        filename: replaceExtForWav(safeName),
      });
    }
    if (rawUrl) {
      candidates.push({
        url: rawUrl,
        ext: inferExtFromFilename(safeName) || inferExtFromUrl(rawUrl) || 'amr',
        filename: safeName,
      });
    }

    if (candidates.length === 0) {
      return {
        ...base,
        unavailable: 'no_download_url',
      };
    }

    let lastError = 'download_failed';
    for (const candidate of candidates) {
      try {
        const saveOpts: SaveResourceOptions = {
          type: 'voice',
          sessionId: peer,
          ext: candidate.ext,
          ...(candidate.filename ? { filename: candidate.filename } : {}),
        };
        const saved = await mediaManager.downloadAndSave(candidate.url, saveOpts);
        const format = detectSavedFormat(saved.localPath, candidate.ext);
        const size = readLocalSize(saved.localPath, declaredSize);
        const durationSec = normalizePositiveDuration(saved.durationSec);
        return withFace({
          ...base,
          local: {
            path: saved.localPath,
            ...(format ? { format } : {}),
            ...(size !== undefined ? { size } : {}),
            ...(saved.md5 ? { md5: saved.md5 } : {}),
            ...(saved.fingerprint ? { fingerprint: saved.fingerprint } : {}),
            ...(durationSec !== undefined ? { durationSec } : {}),
          },
        });
      } catch (err) {
        lastError = sanitizeErrorMessage(err);
        logger?.warn?.(
          `[InboundMedia] 语音附件下载失败 (peer: ${peer}, url: ${sanitizeUrlForLog(candidate.url)}): ${lastError}`
        );
      }
    }

    return {
      ...base,
      unavailable: lastError,
    };
  }

  // 图片 / 表情包 / 视频 / 文件（含以 content_type='file' 下发的 .png 等文件）
  if (!rawUrl) {
    return {
      ...base,
      unavailable: 'no_download_url',
    };
  }

  const targetType: MediaResourceType =
    base.kind === 'image' || base.kind === 'sticker'
      ? forceSticker
        ? 'sticker'
        : 'image'
      : base.kind === 'video'
        ? 'video'
        : 'files';

  const fallbackExt =
    inferExtFromFilename(safeName) ||
    inferExtFromUrl(rawUrl) ||
    (base.kind === 'video' ? 'mp4' : undefined);

  try {
    const saveOpts: SaveResourceOptions = {
      type: targetType,
      sessionId: peer,
      ...(safeName ? { filename: safeName } : {}),
      ...(fallbackExt ? { ext: fallbackExt } : {}),
    };
    const saved = await mediaManager.downloadAndSave(rawUrl, saveOpts);
    const format = detectSavedFormat(saved.localPath, fallbackExt);
    const size = readLocalSize(saved.localPath, declaredSize);
    const durationSec = normalizePositiveDuration(saved.durationSec);

    return withFace({
      ...base,
      local: {
        path: saved.localPath,
        ...(format ? { format } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(saved.md5 ? { md5: saved.md5 } : {}),
        ...(saved.fingerprint ? { fingerprint: saved.fingerprint } : {}),
        ...(base.kind === 'video' && dimensions ? { dimensions } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
      },
    });
  } catch (err) {
    const safeError = sanitizeErrorMessage(err);
    logger?.warn?.(
      `[InboundMedia] 入站附件下载失败 (peer: ${peer}, kind: ${base.kind}, url: ${sanitizeUrlForLog(rawUrl)}): ${safeError}`
    );
    return {
      ...base,
      unavailable: safeError,
    };
  }
}

/**
 * 批量结构化附件 → 描述符（有限并发 4，按输入顺序返回）。
 * 单个附件失败只标记 `unavailable`，不阻断其余附件。
 */
export async function localizeInboundAttachments(
  attachments: ReadonlyArray<QQAttachment>,
  options: AttachmentLocalizeOptions
): Promise<AttachmentDescriptor[]> {
  const valid = attachments.filter(
    (att): att is QQAttachment => Boolean(att) && typeof att === 'object'
  );
  if (valid.length === 0) return [];

  return mapWithConcurrency(valid, 4, (att) => localizeInboundAttachment(att, options));
}
