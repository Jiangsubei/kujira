/**
 * kujira: 本地资源下载、两级去重与 7 天 TTL 清理模块
 * 管理图片、表情包、语音、视频与文件的本地缓存落盘、两级去重（file_id 索引 + SHA-256 指纹）以及过期文件清理。
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from './database.js';
import { DEFAULT_DOWNLOAD_ROOT } from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';

export type MediaResourceType = 'image' | 'sticker' | 'files' | 'file' | 'voice' | 'video';

export interface MediaStorageOptions {
  dshHome?: string;
  downloadDir?: string;
  db?: MessageDatabase | null;
  ttlDays?: number;
}

export interface SaveResourceOptions {
  type?: MediaResourceType;
  sessionId?: string;
  fileId?: string | null;
  filename?: string;
  ext?: string;
}

export interface SaveResourceResult {
  localPath: string;
  fingerprint: string;
  deduplicated: boolean;
  level?: 1 | 2;
  md5?: string;
  durationSec?: number;
}

/**
 * 对 URL 执行日志/异常输出脱敏：仅保留 protocol + host + pathname，彻底剥离 query 参数与凭证信息。
 */
export function sanitizeUrlForLog(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    const qIndex = trimmed.indexOf('?');
    const hIndex = trimmed.indexOf('#');
    let cut = trimmed.length;
    if (qIndex !== -1) cut = Math.min(cut, qIndex);
    if (hIndex !== -1) cut = Math.min(cut, hIndex);
    return trimmed.slice(0, cut);
  }
}

/**
 * 计算 Buffer 的 MD5 十六进制字符串
 */
export function computeBufferMd5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * 计算本地文件的 MD5 十六进制字符串（若文件不存在或读取失败返回 null）
 */
export function computeFileMd5(filePath: string): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 根据字节流魔数推断真实文件扩展名（不信任外部响应头或伪后缀）。
 * 支持: gif, png, jpg, webp, wav, amr, ogg, m4a, mp4
 */
export function detectBufferExt(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 2) return undefined;

  // GIF87a / GIF89a
  if (buffer.length >= 6) {
    const header6 = buffer.toString('ascii', 0, 6);
    if (header6 === 'GIF89a' || header6 === 'GIF87a') {
      return 'gif';
    }
  }

  // PNG (\x89PNG)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  // JPEG (\xFF\xD8)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'jpg';
  }

  // RIFF 容器: WebP (RIFF....WEBP) 或 WAV (RIFF....WAVE)
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    const riffType = buffer.toString('ascii', 8, 12);
    if (riffType === 'WEBP') return 'webp';
    if (riffType === 'WAVE') return 'wav';
  }

  // AMR (#!AMR / #!AMR-WB)
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '#!AMR') {
    return 'amr';
  }

  // Ogg (OggS)
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') {
    return 'ogg';
  }

  // ISO BMFF (....ftyp<brand>): m4a / mp4
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') {
      return 'm4a';
    }
    return 'mp4';
  }

  return undefined;
}

const MAX_MOOV_BYTES = 8 * 1024 * 1024;

interface IsoBoxHeader {
  type: string;
  headerSize: number;
  boxSize: number;
  boxEnd: number;
  payloadStart: number;
}

function parseIsoBoxHeaderFromBuffer(
  buf: Buffer,
  offset: number,
  end: number,
  totalAvailableEnd: number = end
): IsoBoxHeader | null {
  if (offset + 8 > end) return null;
  const rawSize = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  let headerSize = 8;
  let boxSize: number;

  if (rawSize === 1) {
    if (offset + 16 > end) return null;
    headerSize = 16;
    const bigSize = buf.readBigUInt64BE(offset + 8);
    if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    boxSize = Number(bigSize);
  } else if (rawSize === 0) {
    boxSize = totalAvailableEnd - offset;
  } else {
    boxSize = rawSize;
  }

  if (!Number.isFinite(boxSize) || boxSize < headerSize) return null;
  const boxEnd = offset + boxSize;
  if (boxEnd > totalAvailableEnd) return null;
  return {
    type,
    headerSize,
    boxSize,
    boxEnd,
    payloadStart: offset + headerSize,
  };
}

function parseMvhdDurationSec(buf: Buffer, payloadStart: number, boxEnd: number): number | undefined {
  const payloadLen = boxEnd - payloadStart;
  if (payloadLen < 1) return undefined;
  const version = buf.readUInt8(payloadStart);
  let timescale = 0;
  let duration = 0;

  if (version === 0) {
    if (payloadLen < 20) return undefined;
    timescale = buf.readUInt32BE(payloadStart + 12);
    duration = buf.readUInt32BE(payloadStart + 16);
  } else if (version === 1) {
    if (payloadLen < 32) return undefined;
    timescale = buf.readUInt32BE(payloadStart + 20);
    duration = Number(buf.readBigUInt64BE(payloadStart + 24));
  } else {
    return undefined;
  }

  if (timescale > 0 && Number.isFinite(duration) && duration > 0) {
    const sec = duration / timescale;
    return Number.isFinite(sec) && sec > 0 ? sec : undefined;
  }
  return undefined;
}

function findMvhdDurationInRange(buf: Buffer, start: number, end: number): number | undefined {
  let offset = start;
  while (offset + 8 <= end) {
    const box = parseIsoBoxHeaderFromBuffer(buf, offset, end);
    if (!box) break;
    if (box.type === 'mvhd') {
      const durationSec = parseMvhdDurationSec(buf, box.payloadStart, box.boxEnd);
      if (durationSec !== undefined) return durationSec;
    }
    offset = box.boxEnd;
  }
  return undefined;
}

/**
 * 纯 Node.js 解析 MP4/MOV Buffer 中的视频时长（秒），基于 ISO BMFF `moov -> mvhd`。
 * 不依赖外部 ffprobe；无法识别或异常时静默返回 undefined。
 */
export function extractMp4DurationSecFromBuffer(buffer: Buffer): number | undefined {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return undefined;
  try {
    let offset = 0;
    const end = buffer.length;
    while (offset + 8 <= end) {
      const box = parseIsoBoxHeaderFromBuffer(buffer, offset, end);
      if (!box) break;
      if (box.type === 'moov') {
        const durationSec = findMvhdDurationInRange(buffer, box.payloadStart, box.boxEnd);
        if (durationSec !== undefined) return durationSec;
      }
      offset = box.boxEnd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readExactSync(
  fd: number,
  target: Buffer,
  targetOffset: number,
  length: number,
  filePosition: number
): boolean {
  let total = 0;
  while (total < length) {
    const n = fs.readSync(fd, target, targetOffset + total, length - total, filePosition + total);
    if (n <= 0) return false;
    total += n;
  }
  return true;
}

/**
 * 纯 Node.js 从本地 MP4/MOV 文件提取视频时长（秒）。
 * 仅顺序扫描顶层 8/16 字节 Box 头并跳过 `mdat` 等大块数据，仅将不超过 8 MiB 的 `moov` Box 读入内存解析。
 * 绝不整文件读入内存；异常时静默返回 undefined。
 */
export function extractMp4DurationSecFromFile(filePath: string): number | undefined {
  if (!filePath || typeof filePath !== 'string') return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (!Number.isFinite(fileSize) || fileSize < 8) {
      return undefined;
    }

    const headerBuf = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= fileSize) {
      const remaining = fileSize - offset;
      const headerReadLen = Math.min(16, remaining);
      if (!readExactSync(fd, headerBuf, 0, headerReadLen, offset)) {
        break;
      }

      const box = parseIsoBoxHeaderFromBuffer(headerBuf, 0, headerReadLen, remaining);
      if (!box) break;

      if (box.type === 'moov' && box.boxSize <= MAX_MOOV_BYTES) {
        const moovBuf = Buffer.alloc(box.boxSize);
        if (readExactSync(fd, moovBuf, 0, box.boxSize, offset)) {
          const durationSec = extractMp4DurationSecFromBuffer(moovBuf);
          if (durationSec !== undefined) {
            return durationSec;
          }
        }
      }

      offset += box.boxSize;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function normalizePositiveDuration(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function resolveVideoDurationSec(options: {
  type?: MediaResourceType;
  detectedExt?: string;
  filePath: string;
  buffer?: Buffer;
  fallbackToFile?: boolean;
}): number | undefined {
  const shouldExtract =
    options.type === 'video' ||
    options.detectedExt === 'mp4' ||
    path.extname(options.filePath).toLowerCase() === '.mp4';
  if (!shouldExtract) return undefined;

  if (options.buffer) {
    const fromBuf = normalizePositiveDuration(extractMp4DurationSecFromBuffer(options.buffer));
    if (fromBuf !== undefined) return fromBuf;
    if (!options.fallbackToFile) return undefined;
  }

  return normalizePositiveDuration(extractMp4DurationSecFromFile(options.filePath));
}

function sanitizeTextUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s'"]+/gi, (match) => sanitizeUrlForLog(match));
}

function sanitizeFilename(rawName?: string): { name?: string; traversalLiteral?: boolean } {
  if (!rawName || typeof rawName !== 'string') return {};
  const normalized = rawName.trim().replace(/\\/g, '/');
  if (!normalized) return {};
  const base = path.basename(normalized).trim();
  if (!base) return {};
  if (base === '.' || base === '..') {
    return { name: base, traversalLiteral: true };
  }
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  if (!cleaned) return {};
  if (cleaned === '.' || cleaned === '..') {
    return { name: cleaned, traversalLiteral: true };
  }
  return { name: cleaned };
}

function sanitizePathSegment(rawSegment: string, fallback = 'common'): string {
  const sanitized = sanitizeFilename(rawSegment);
  if (!sanitized.name || sanitized.traversalLiteral) return fallback;
  return sanitized.name;
}

function assertPathWithinDir(baseDir: string, targetPath: string, displayName: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (
    !rel ||
    rel === '.' ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    path.isAbsolute(rel)
  ) {
    throw new Error(`[MediaStorageManager] 非法文件名检测到路径穿越: ${displayName}`);
  }
}

function shouldAlignExtensionWithMagic(type: string): boolean {
  return type === 'image' || type === 'sticker' || type === 'voice' || type === 'video';
}

export class MediaStorageManager {
  public readonly downloadRoot: string;
  public readonly ttlDays: number;
  private db: MessageDatabase | null;

  constructor(options: MediaStorageOptions = {}) {
    const dshHome = resolveDshPath(options.dshHome || process.env.DSH_HOME, undefined, '');
    this.downloadRoot = resolveDshPath(dshHome, options.downloadDir, DEFAULT_DOWNLOAD_ROOT);
    this.ttlDays = options.ttlDays ?? 7;
    this.db = options.db || null;
  }

  setDatabase(db: MessageDatabase): void {
    this.db = db;
  }

  getDownloadDir(type: MediaResourceType, sessionId = 'common'): string {
    const normalizedType = type === 'file' ? 'files' : type;
    const safeSession = sanitizePathSegment(sessionId, 'common');
    return path.join(this.downloadRoot, normalizedType, safeSession);
  }

  computeHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * 一级去重只读查询：file_id 命中且文件仍在 → 返回现有落盘路径。
   */
  lookupCached(fileId?: string | null): { localPath: string; fingerprint: string } | null {
    if (!fileId || !this.db) return null;
    const record = this.db.getByFileId(fileId);
    if (record?.local_path && fs.existsSync(record.local_path)) {
      return { localPath: record.local_path, fingerprint: record.fingerprint || '' };
    }
    return null;
  }

  private async tryReuseByFileId(
    fileId?: string | null,
    type?: MediaResourceType
  ): Promise<SaveResourceResult | null> {
    if (!fileId || !this.db) return null;
    const record = this.db.getByFileId(fileId);
    if (record?.local_path && fs.existsSync(record.local_path)) {
      const now = new Date();
      await fsp.utimes(record.local_path, now, now).catch(() => {});
      const durationSec = resolveVideoDurationSec({
        type,
        filePath: record.local_path,
      });
      return {
        localPath: record.local_path,
        fingerprint: record.fingerprint || '',
        deduplicated: true,
        level: 1,
        md5: computeFileMd5(record.local_path) || undefined,
        ...(durationSec !== undefined ? { durationSec } : {}),
      };
    }
    return null;
  }

  /**
   * 两级去重并落盘保存 Buffer 数据
   */
  async saveBuffer(buffer: Buffer, options: SaveResourceOptions = {}): Promise<SaveResourceResult> {
    const sessionId = options.sessionId || 'common';
    const type = options.type === 'file' ? 'files' : options.type || 'image';

    // 1. 一级去重: file_id 查库
    const l1Hit = await this.tryReuseByFileId(options.fileId, type);
    if (l1Hit) return l1Hit;

    // 2. 二级去重: SHA-256 指纹去重
    const fingerprint = this.computeHash(buffer);
    const md5 = computeBufferMd5(buffer);
    const detectedExt = detectBufferExt(buffer);

    if (this.db) {
      const record = this.db.getByFingerprint(fingerprint);
      if (record?.local_path && fs.existsSync(record.local_path)) {
        let validPath = record.local_path;
        // 自动自愈：若已落盘媒体文件后缀与真实魔数不一致，自动重命名纠偏
        if (detectedExt && shouldAlignExtensionWithMagic(type)) {
          const currentExt = path.extname(validPath).replace(/^\./, '').toLowerCase();
          if (currentExt && currentExt !== detectedExt) {
            const correctedPath = validPath.slice(0, -currentExt.length) + detectedExt;
            try {
              await fsp.rename(validPath, correctedPath);
              validPath = correctedPath;
              this.db.updateLocalPathByFileId(
                record.file_id || options.fileId || '',
                correctedPath,
                fingerprint
              );
            } catch {}
          }
        }
        if (options.fileId) {
          try {
            this.db.updateLocalPathByFileId(options.fileId, validPath, fingerprint);
          } catch {}
        }
        const now = new Date();
        await fsp.utimes(validPath, now, now).catch(() => {});
        const durationSec = resolveVideoDurationSec({
          type,
          detectedExt,
          filePath: validPath,
          buffer,
          fallbackToFile: true,
        });
        return {
          localPath: validPath,
          fingerprint,
          deduplicated: true,
          level: 2,
          md5,
          ...(durationSec !== undefined ? { durationSec } : {}),
        };
      }
    }

    // 3. 落盘写入文件（魔数优先于外部扩展名与响应头）
    const fallbackExt = type === 'image' || type === 'sticker' ? 'png' : 'dat';
    const ext = (detectedExt || options.ext || fallbackExt).replace(/^\./, '').toLowerCase();
    const targetDir = this.getDownloadDir(type, sessionId);
    await fsp.mkdir(targetDir, { recursive: true });

    const sanitizedName = sanitizeFilename(options.filename);
    if (sanitizedName.traversalLiteral) {
      throw new Error(`[MediaStorageManager] 非法文件名检测到路径穿越: ${sanitizedName.name}`);
    }

    let fileName = sanitizedName.name;
    if (!fileName) {
      if (type === 'image' || type === 'sticker') {
        fileName = `${fingerprint}.${ext}`;
      } else {
        const safeIdPart = options.fileId ? sanitizePathSegment(options.fileId, fingerprint) : fingerprint;
        fileName = `${safeIdPart}.${ext}`;
      }
    } else if (shouldAlignExtensionWithMagic(type) && detectedExt) {
      const parsed = path.parse(fileName);
      if (parsed.ext.replace(/^\./, '').toLowerCase() !== detectedExt) {
        fileName = `${parsed.name}.${detectedExt}`;
      }
    }

    const resolvedDir = path.resolve(targetDir);
    const targetPath = path.resolve(resolvedDir, fileName);
    assertPathWithinDir(resolvedDir, targetPath, fileName);

    await fsp.writeFile(targetPath, buffer);

    if (options.fileId && this.db) {
      this.db.updateLocalPathByFileId(options.fileId, targetPath, fingerprint);
    }

    const durationSec = resolveVideoDurationSec({
      type,
      detectedExt,
      filePath: targetPath,
      buffer,
    });

    return {
      localPath: targetPath,
      fingerprint,
      deduplicated: false,
      md5,
      ...(durationSec !== undefined ? { durationSec } : {}),
    };
  }

  /**
   * 从 URL 或现有本地路径裸 GET 下载并落盘（绝不在异常/日志中暴露带 query 凭证的完整 URL，
   * 且不附加任何鉴权头、不信任下载响应头 Content-Type）。
   */
  async downloadAndSave(
    urlOrPath: string,
    options: SaveResourceOptions = {}
  ): Promise<SaveResourceResult> {
    // 1. 一级去重先行校验
    const type = options.type === 'file' ? 'files' : options.type || 'image';
    const l1Hit = await this.tryReuseByFileId(options.fileId, type);
    if (l1Hit) return l1Hit;

    let buffer: Buffer;

    // 2. 处理本地路径或 file:// URI
    if (urlOrPath.startsWith('file://')) {
      buffer = await fsp.readFile(fileURLToPath(urlOrPath));
    } else if (path.isAbsolute(urlOrPath)) {
      if (fs.existsSync(urlOrPath)) {
        buffer = await fsp.readFile(urlOrPath);
      } else {
        throw new Error(`本地源文件不存在: ${urlOrPath}`);
      }
    } else if (/^https?:\/\//i.test(urlOrPath)) {
      // 3. HTTP(S) 裸 GET 下载（不附加任何鉴权 Header，不采信响应头 Content-Type）
      let response: Response;
      try {
        response = await fetch(urlOrPath);
      } catch (err: any) {
        const reason = err?.message ? sanitizeTextUrls(String(err.message)) : 'network error';
        throw new Error(`HTTP 下载异常 (${sanitizeUrlForLog(urlOrPath)}): ${reason}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP 下载失败 (status: ${response.status}): ${sanitizeUrlForLog(urlOrPath)}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      throw new Error(`不支持的 URL 格式: ${sanitizeUrlForLog(urlOrPath)}`);
    }

    return this.saveBuffer(buffer, options);
  }

  /**
   * 7 天 TTL 清理任务
   */
  async cleanExpired(ttlDays = this.ttlDays): Promise<{ deletedFiles: number; freedBytes: number }> {
    return cleanExpiredMedia(this.downloadRoot, ttlDays, this.db || undefined);
  }
}

/**
 * 递归扫描并清理过期媒体文件
 */
export async function cleanExpiredMedia(
  downloadRoot: string,
  ttlDays = 7,
  db?: MessageDatabase
): Promise<{ deletedFiles: number; freedBytes: number }> {
  let deletedFiles = 0;
  let freedBytes = 0;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (!fs.existsSync(downloadRoot)) {
    return { deletedFiles, freedBytes };
  }

  const walkAndClean = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndClean(fullPath);
        const remaining = await fsp.readdir(fullPath).catch(() => ['non-empty']);
        if (remaining.length === 0) {
          await fsp.rmdir(fullPath).catch(() => {});
        }
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          if (now - stat.mtimeMs > ttlMs) {
            await fsp.unlink(fullPath);
            deletedFiles++;
            freedBytes += stat.size;
            if (db) {
              db.clearLocalPath(fullPath);
            }
          }
        } catch {}
      }
    }
  };

  await walkAndClean(downloadRoot);

  // 物理清理已过 7 天后悔期的软删除表情包文件及数据库记录
  if (db && typeof (db as any).purgeExpiredFaces === 'function') {
    try {
      const purgedPaths = (db as any).purgeExpiredFaces(7);
      for (const p of purgedPaths) {
        if (p && fs.existsSync(p)) {
          try {
            const stat = fs.statSync(p);
            fs.unlinkSync(p);
            deletedFiles++;
            freedBytes += stat.size;
          } catch {}
        }
      }
    } catch {}
  }

  return { deletedFiles, freedBytes };
}

/**
 * 启动媒体 TTL 清理定时任务
 */
export function startMediaCleanupTask(
  ctx: Context | any,
  manager: MediaStorageManager,
  intervalMs = 24 * 60 * 60 * 1000,
  initialDelayMs = 5000
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let initialTimer: NodeJS.Timeout | null = null;

  const runCleanup = () => {
    manager.cleanExpired().catch((err) => {
      ctx?.logger?.error?.('[MediaCleanup] 定时清理任务执行异常:', err);
    });
  };

  if (initialDelayMs >= 0) {
    initialTimer = setTimeout(() => {
      initialTimer = null;
      runCleanup();
    }, initialDelayMs);
  }

  timer = setInterval(runCleanup, intervalMs);

  const stop = () => {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', stop);
  }

  return stop;
}
