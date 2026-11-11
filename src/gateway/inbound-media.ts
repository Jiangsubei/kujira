/**
 * kujira: 入站媒体裸 GET 下载、安全文件名净化与合并转发内嵌图片脱敏落盘
 *
 * 严格依据 QQ 官方 Bot API v2 实测行为：
 * 1. 入站 `event.attachments[]` 所有下载链接均自带访问凭证 query，直接裸 GET 即可（无需 Authorization 头）；
 * 2. 所有错误、描述符 `unavailable` 与日志输出严禁携带带 query / `rkey` 凭证的完整 URL；
 * 3. 语音附件严格以 `content_type === 'voice'` 为准（忽略响应头错报 `audio/mp3`），
 *    优先拉取 `voice_wav_url`（`type: 'voice'`, `ext: 'wav'`），缺失/失败再回退 `url`，始终保留 `asr_refer_text`；
 * 4. 外部传入的 `filename` 一律先做 `path.basename` 与危险字符净化后再传入存储层；
 * 5. `message_type=102` 合并转发内嵌 `[附件...] ... URL:https://...` 限量裸 GET 落盘，并从正文彻底剥离/替换含 `rkey` 明文 URL。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QQAttachment, QQC2CMessageCreateEvent } from '../types/index.js';
import type { AttachmentDescriptor } from '../attachment/types.js';
import {
  describeAttachment,
  sanitizeAttachmentFileName,
} from '../attachment/classify.js';
import {
  detectBufferExt,
  sanitizeUrlForLog,
  type MediaResourceType,
  type MediaStorageManager,
  type SaveResourceOptions,
} from '../storage/media.js';

export { sanitizeUrlForLog };

export interface InboundMediaLogger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

export interface EmbeddedForwardImageEntry {
  /** 脱敏后的 URL（已剥离 query 与 fragment 凭证） */
  sanitizedUrl: string;
  attachmentType?: string;
  fileName?: string;
  localPath?: string;
  fingerprint?: string;
  md5?: string;
  downloaded: boolean;
  error?: string;
}

export interface ResolveEmbeddedForwardImagesResult {
  /** 已将正文内所有含凭证 URL 替换为 `[图片:<local_path>]` 或 `[图片(链接已脱敏)]` 后的安全文本 */
  sanitizedContent: string;
  /** 原始 URL → 替换文本映射 */
  replacements: Map<string, string>;
  /** 成功落盘的本地图片路径列表（去重，保持出现顺序） */
  localPaths: string[];
  /** 每个内嵌附件的脱敏处理明细 */
  entries: EmbeddedForwardImageEntry[];
}

const DEFAULT_FORWARD_IMAGE_LIMIT = 10;

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isHttpUrl(value: unknown): value is string {
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

function inferExtFromFilename(name?: string): string | undefined {
  if (!name) return undefined;
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return ext || undefined;
}

function inferExtFromUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  const clean = sanitizeUrlForLog(rawUrl);
  const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
  return match ? match[1]!.toLowerCase() : undefined;
}

function replaceExtForWav(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const parsed = path.parse(fileName);
  const stem = parsed.name.trim();
  return stem ? `${stem}.wav` : 'voice.wav';
}

function detectSavedFormat(localPath: string, fallbackExt?: string): string | undefined {
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

function readLocalSize(localPath: string, declaredSize?: number): number | undefined {
  try {
    const stat = fs.statSync(localPath);
    if (Number.isFinite(stat.size)) return stat.size;
  } catch {
    // ignore
  }
  return declaredSize !== undefined && Number.isFinite(declaredSize) ? declaredSize : undefined;
}

async function resolveSingleInboundAttachment(
  att: QQAttachment,
  peer: string,
  mediaManager: MediaStorageManager,
  logger?: InboundMediaLogger
): Promise<AttachmentDescriptor> {
  const base = describeAttachment(att, 'inbound');
  const safeName = sanitizeInboundFilename(att.filename);
  const declaredSize = typeof att.size === 'number' && Number.isFinite(att.size) ? att.size : undefined;

  const rawUrl = isHttpUrl(att.url) ? att.url.trim() : undefined;
  const voiceWavUrl = isHttpUrl(att.voice_wav_url) ? att.voice_wav_url.trim() : undefined;

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
        return {
          ...base,
          local: {
            path: saved.localPath,
            ...(format ? { format } : {}),
            ...(size !== undefined ? { size } : {}),
            ...(saved.md5 ? { md5: saved.md5 } : {}),
            ...(saved.fingerprint ? { fingerprint: saved.fingerprint } : {}),
          },
        };
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

  // 图片 / 视频 / 文件（含以 content_type='file' 下发的 .png 等文件）
  if (!rawUrl) {
    return {
      ...base,
      unavailable: 'no_download_url',
    };
  }

  const targetType: MediaResourceType =
    base.kind === 'image' || base.kind === 'sticker'
      ? 'image'
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

    return {
      ...base,
      local: {
        path: saved.localPath,
        ...(format ? { format } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(saved.md5 ? { md5: saved.md5 } : {}),
        ...(saved.fingerprint ? { fingerprint: saved.fingerprint } : {}),
      },
    };
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
 * 并发下载并落盘 `QQC2CMessageCreateEvent.attachments[]` 中的所有入站附件。
 * - 直接裸 GET（不附加任何 Authorization 头）；
 * - 任一附件失败只标记 `unavailable`（已剥离 URL query），不阻断其他附件或整条消息处理。
 */
export async function resolveInboundAttachments(
  event: QQC2CMessageCreateEvent,
  peer: string,
  mediaManager: MediaStorageManager,
  logger?: InboundMediaLogger
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

  return Promise.all(
    validAttachments.map((att) => resolveSingleInboundAttachment(att, peer, mediaManager, logger))
  );
}

const EMBEDDED_URL_TOKEN_REGEX = /URL\s*:\s*(https?:\/\/[^\s"'<>)\]]+)/gi;
const BARE_CREDENTIAL_URL_REGEX = /https?:\/\/[^\s"'<>)\]]*[?&](?:rkey|auth_token|sig)=[^\s"'<>)\]]+/gi;

function isDownloadableForwardType(attachmentType?: string): boolean {
  if (!attachmentType) return true;
  const normalized = attachmentType.trim().toLowerCase();
  if (!normalized) return true;
  if (/视频|音频|语音|file|video|audio|voice/.test(normalized)) {
    return false;
  }
  return /图|表情|image|sticker|gif|pic/.test(normalized);
}

function isStickerForwardType(attachmentType?: string): boolean {
  if (!attachmentType) return false;
  return /表情|sticker/.test(attachmentType.trim().toLowerCase());
}

/**
 * 同步脱敏合并转发文本中任何携带访问凭证的 URL（防泄漏兜底）。
 * 若传入 `replacements` 映射表，优先替换为已落盘的 `[图片:<local_path>]`。
 */
export function sanitizeForwardContentUrls(
  content: string,
  replacements?: ReadonlyMap<string, string>
): string {
  if (!content || typeof content !== 'string') return '';

  const withUrlTokensReplaced = content.replace(EMBEDDED_URL_TOKEN_REGEX, (_full, rawUrl: string) => {
    const mapped = replacements?.get(rawUrl);
    if (mapped) return mapped;
    return '[图片(链接已脱敏)]';
  });

  return withUrlTokensReplaced.replace(BARE_CREDENTIAL_URL_REGEX, (rawUrl) => {
    const mapped = replacements?.get(rawUrl);
    if (mapped) return mapped;
    return '[图片(链接已脱敏)]';
  });
}

/**
 * 从官方 `message_type=102` 展开文本中提取 `[附件...] ... URL:https://...` 内嵌图片链接并限量裸 GET 落盘，
 * 返回替换映射与已脱敏正文（所有含 `rkey` 的明文 URL 均替换为 `[图片:<local_path>]` 或 `[图片(链接已脱敏)]`）。
 */
export async function resolveEmbeddedForwardImages(
  content: string,
  peer: string,
  mediaManager?: MediaStorageManager,
  limit: number = DEFAULT_FORWARD_IMAGE_LIMIT,
  logger?: InboundMediaLogger
): Promise<ResolveEmbeddedForwardImagesResult> {
  const replacements = new Map<string, string>();
  const localPaths: string[] = [];
  const entries: EmbeddedForwardImageEntry[] = [];

  if (!content || typeof content !== 'string') {
    return {
      sanitizedContent: '',
      replacements,
      localPaths,
      entries,
    };
  }

  const maxDownloads = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_FORWARD_IMAGE_LIMIT;
  let downloadedCount = 0;
  const cachedByUrl = new Map<string, { localPath: string; fingerprint?: string; md5?: string }>();

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    EMBEDDED_URL_TOKEN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EMBEDDED_URL_TOKEN_REGEX.exec(line)) !== null) {
      const rawUrl = match[1]!;
      const sanitizedUrl = sanitizeUrlForLog(rawUrl);

      const typeMatch = /类型\s*:\s*([^\s]+)/.exec(line);
      const attachmentType = nonEmpty(typeMatch?.[1]);
      const nameMatch = /文件名\s*:\s*([^\s]+)/.exec(line);
      const fileName = sanitizeInboundFilename(nameMatch?.[1]);

      if (replacements.has(rawUrl)) {
        const cached = cachedByUrl.get(rawUrl);
        entries.push({
          sanitizedUrl,
          ...(attachmentType ? { attachmentType } : {}),
          ...(fileName ? { fileName } : {}),
          ...(cached?.localPath ? { localPath: cached.localPath } : {}),
          ...(cached?.fingerprint ? { fingerprint: cached.fingerprint } : {}),
          ...(cached?.md5 ? { md5: cached.md5 } : {}),
          downloaded: Boolean(cached?.localPath),
        });
        continue;
      }

      if (!mediaManager || !isDownloadableForwardType(attachmentType) || downloadedCount >= maxDownloads) {
        replacements.set(rawUrl, '[图片(链接已脱敏)]');
        entries.push({
          sanitizedUrl,
          ...(attachmentType ? { attachmentType } : {}),
          ...(fileName ? { fileName } : {}),
          downloaded: false,
        });
        continue;
      }

      const urlExt = inferExtFromFilename(fileName) || inferExtFromUrl(rawUrl);
      const mediaType: MediaResourceType = isStickerForwardType(attachmentType) ? 'sticker' : 'image';

      try {
        const saved = await mediaManager.downloadAndSave(rawUrl, {
          type: mediaType,
          sessionId: peer,
          ...(fileName ? { filename: fileName } : {}),
          ...(urlExt ? { ext: urlExt } : {}),
        });
        downloadedCount++;
        const replacement = `[图片:${saved.localPath}]`;
        replacements.set(rawUrl, replacement);
        cachedByUrl.set(rawUrl, {
          localPath: saved.localPath,
          fingerprint: saved.fingerprint,
          md5: saved.md5,
        });
        if (!localPaths.includes(saved.localPath)) {
          localPaths.push(saved.localPath);
        }
        entries.push({
          sanitizedUrl,
          ...(attachmentType ? { attachmentType } : {}),
          ...(fileName ? { fileName } : {}),
          localPath: saved.localPath,
          ...(saved.fingerprint ? { fingerprint: saved.fingerprint } : {}),
          ...(saved.md5 ? { md5: saved.md5 } : {}),
          downloaded: true,
        });
      } catch (err) {
        const safeError = sanitizeErrorMessage(err);
        logger?.warn?.(
          `[InboundMedia] 合并转发内嵌图片下载失败 (peer: ${peer}, url: ${sanitizedUrl}): ${safeError}`
        );
        replacements.set(rawUrl, '[图片(链接已脱敏)]');
        entries.push({
          sanitizedUrl,
          ...(attachmentType ? { attachmentType } : {}),
          ...(fileName ? { fileName } : {}),
          downloaded: false,
          error: safeError,
        });
      }
    }
  }

  const sanitizedContent = sanitizeForwardContentUrls(content, replacements);
  return {
    sanitizedContent,
    replacements,
    localPaths,
    entries,
  };
}
