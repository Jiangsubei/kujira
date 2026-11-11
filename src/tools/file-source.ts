/**
 * kujira: send_file 文件源归一化与字节读取（QQ 官方 Bot API v2 四步分片上传前处理）
 *
 * 统一将输入归一化为：
 *   1. 本地绝对路径     -> 校验存在性与可读性后读取字节流；
 *   2. file:// URI     -> 使用 fileURLToPath 转换后校验存在性与可读性读取；
 *   3. http(s):// URL  -> 标明为外部链接，拉取字节流（错误日志经 sanitizeUrlForLog 脱敏）；
 *   4. Base64          -> base64:// 或 data:...;base64, 解码为 Buffer。
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBufferExt, sanitizeUrlForLog } from '../storage/media.js';
import { sanitizeErrorMessage } from '../gateway/inbound-media.js';
import { sanitizeAttachmentFileName } from '../attachment/classify.js';

export type SendFileSourceKind = 'local' | 'file-uri' | 'url' | 'base64';
export type SendFileMediaKind = 'image' | 'file' | 'video' | 'voice';

export interface NormalizedSendFileSource {
  kind: SendFileSourceKind;
  /** 归一化后的源值：本地/file-uri 为 OS 绝对路径，url 为 http(s) URL，base64 为 base64:// 串 */
  value: string;
  /** 本地文件路径（仅 local / file-uri 形态） */
  localPath?: string;
  /** 解码后的字节流（仅 base64 形态直接可用） */
  buffer?: Buffer;
  /** 推断出的文件名（已净化，绝不含路径穿越） */
  fileName?: string;
  /** data: URI 声明的 MIME 类型（若有） */
  mimeType?: string;
}

export type ClassifyResult = { source: NormalizedSendFileSource } | { error: string };

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|mkv|avi|webm|flv|m4v)$/i;
const VOICE_EXT_RE = /\.(wav|amr|silk|mp3|ogg|m4a|aac|flac|opus)$/i;

function mimeToExt(mime?: string): string | undefined {
  if (!mime) return undefined;
  const clean = mime.split(';')[0]?.trim().toLowerCase();
  if (!clean || !clean.includes('/')) return undefined;
  const sub = clean.split('/')[1];
  if (!sub) return undefined;
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'x-wav' || sub === 'wave') return 'wav';
  if (sub === 'mpeg') return 'mp3';
  if (/^[a-z0-9]{1,8}$/.test(sub)) return sub;
  return undefined;
}

function inferUrlFileName(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const base = path.basename(decodeURIComponent(parsed.pathname));
    return sanitizeAttachmentFileName(base);
  } catch {
    const clean = sanitizeUrlForLog(rawUrl);
    const base = path.basename(clean);
    return sanitizeAttachmentFileName(base);
  }
}

/**
 * 判定发送文件类型：显式传入 `file_type` 强制生效；缺省时按 MIME 或路径/URL 扩展名自动推导。
 */
export function detectSendFileType(
  fileType: SendFileMediaKind | undefined,
  sourceValue: string,
  mimeType?: string
): SendFileMediaKind {
  if (
    fileType === 'image' ||
    fileType === 'file' ||
    fileType === 'video' ||
    fileType === 'voice'
  ) {
    return fileType;
  }

  const normalizedMime = (mimeType || '').toLowerCase();
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'voice';

  if (/^data:image\//i.test(sourceValue)) return 'image';
  if (/^data:video\//i.test(sourceValue)) return 'video';
  if (/^data:audio\//i.test(sourceValue)) return 'voice';

  const pathPart = (sourceValue || '').split(/[?#]/)[0] || '';
  if (IMAGE_EXT_RE.test(pathPart)) return 'image';
  if (VIDEO_EXT_RE.test(pathPart)) return 'video';
  if (VOICE_EXT_RE.test(pathPart)) return 'voice';
  return 'file';
}

/**
 * 统一归一化文件源：本地绝对路径 / `file://` URI / `http(s)://` URL / Base64。
 */
export function classifySendFileSource(input: string): ClassifyResult {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) {
    return { error: '发送文件失败: 你需要指定 file_path' };
  }

  // 1. Base64: base64:// 或 data:...;base64,
  if (/^base64:\/\//i.test(trimmed)) {
    const rawB64 = trimmed.slice('base64://'.length).trim();
    if (!rawB64) {
      return { error: '发送文件失败: base64 内容为空' };
    }
    const buffer = Buffer.from(rawB64, 'base64');
    if (buffer.length === 0) {
      return { error: '发送文件失败: base64 内容解码后为空' };
    }
    const ext = detectBufferExt(buffer) || 'bin';
    return {
      source: {
        kind: 'base64',
        value: trimmed,
        buffer,
        fileName: `attachment.${ext}`,
      },
    };
  }

  const dataMatch = /^data:([^;,]*);base64,(.*)$/i.exec(trimmed);
  if (dataMatch) {
    const mimeType = dataMatch[1]?.trim() || undefined;
    const rawB64 = (dataMatch[2] || '').trim();
    if (!rawB64) {
      return { error: '发送文件失败: data URI base64 内容为空' };
    }
    const buffer = Buffer.from(rawB64, 'base64');
    if (buffer.length === 0) {
      return { error: '发送文件失败: data URI 解码后为空' };
    }
    const ext = detectBufferExt(buffer) || mimeToExt(mimeType) || 'bin';
    return {
      source: {
        kind: 'base64',
        value: `base64://${rawB64}`,
        buffer,
        fileName: `attachment.${ext}`,
        ...(mimeType ? { mimeType } : {}),
      },
    };
  }

  // 2. 外部 HTTP(S) URL
  if (/^https?:\/\//i.test(trimmed)) {
    const fileName = inferUrlFileName(trimmed);
    return {
      source: {
        kind: 'url',
        value: trimmed,
        ...(fileName ? { fileName } : {}),
      },
    };
  }

  // 3. file:// URI（标准 node:url fileURLToPath 解析）
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const localPath = path.resolve(fileURLToPath(trimmed));
      const fileName = sanitizeAttachmentFileName(path.basename(localPath));
      return {
        source: {
          kind: 'file-uri',
          value: localPath,
          localPath,
          ...(fileName ? { fileName } : {}),
        },
      };
    } catch {
      return { error: `发送文件失败: 无法解析 file:// URI: ${trimmed}` };
    }
  }

  // 4. 本地绝对路径
  if (path.isAbsolute(trimmed)) {
    const localPath = path.resolve(trimmed);
    const fileName = sanitizeAttachmentFileName(path.basename(localPath));
    return {
      source: {
        kind: 'local',
        value: localPath,
        localPath,
        ...(fileName ? { fileName } : {}),
      },
    };
  }

  // 5. 无法识别（相对路径等）
  return {
    error: `发送文件失败: 无法识别的文件源（需本地绝对路径 / file:// URI / http(s) URL / base64）: ${trimmed}`,
  };
}

/**
 * 校验并读取文件字节流（本地读取前验证存在性与可读性；HTTP 失败日志严格脱敏去 query）。
 */
export async function readSendFileBytes(
  source: NormalizedSendFileSource,
  fetchFn: typeof fetch = fetch
): Promise<{ buffer: Buffer; fileName: string } | { error: string }> {
  if (source.kind === 'base64' && source.buffer) {
    if (source.buffer.length === 0) {
      return { error: '发送文件失败: 文件内容为空，无法上传' };
    }
    return {
      buffer: source.buffer,
      fileName: source.fileName || `attachment.${detectBufferExt(source.buffer) || 'bin'}`,
    };
  }

  if ((source.kind === 'local' || source.kind === 'file-uri') && source.localPath) {
    const localPath = source.localPath;
    if (!fs.existsSync(localPath)) {
      return { error: `发送文件失败: 本地路径不存在: ${localPath}` };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(localPath);
    } catch (err) {
      return { error: `发送文件失败: 无法读取文件状态 (${localPath}): ${sanitizeErrorMessage(err)}` };
    }
    if (!stat.isFile()) {
      return { error: `发送文件失败: 目标路径不是普通文件: ${localPath}` };
    }
    try {
      await fsp.access(localPath, fs.constants.R_OK);
    } catch {
      return { error: `发送文件失败: 本地文件不可读（缺少读权限）: ${localPath}` };
    }
    try {
      const buffer = await fsp.readFile(localPath);
      if (buffer.length === 0) {
        return { error: `发送文件失败: 文件内容为空，无法上传: ${localPath}` };
      }
      const fallbackExt = detectBufferExt(buffer) || 'bin';
      const fileName = source.fileName || sanitizeAttachmentFileName(path.basename(localPath)) || `file.${fallbackExt}`;
      return { buffer, fileName };
    } catch (err) {
      return { error: `发送文件失败: 读取本地文件失败 (${localPath}): ${sanitizeErrorMessage(err)}` };
    }
  }

  if (source.kind === 'url') {
    const safeUrl = sanitizeUrlForLog(source.value);
    let response: Response;
    try {
      response = await fetchFn(source.value);
    } catch (err) {
      return { error: `发送文件失败: 拉取外部 URL 异常 (${safeUrl}): ${sanitizeErrorMessage(err)}` };
    }
    if (!response.ok) {
      return { error: `发送文件失败: 拉取外部 URL 失败 (status: ${response.status}, url: ${safeUrl})` };
    }
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        return { error: `发送文件失败: 外部 URL 返回空文件 (${safeUrl})` };
      }
      const ext = detectBufferExt(buffer) || mimeToExt(response.headers.get('content-type') || undefined) || 'bin';
      const fileName = source.fileName || `download.${ext}`;
      return { buffer, fileName };
    } catch (err) {
      return { error: `发送文件失败: 读取外部 URL 响应失败 (${safeUrl}): ${sanitizeErrorMessage(err)}` };
    }
  }

  return { error: '发送文件失败: 不支持的文件源类型' };
}
