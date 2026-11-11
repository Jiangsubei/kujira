/**
 * kujira: DSH 路径锚定、路径段转义与 Windows 超长路径保护工具
 */

import * as path from 'node:path';
import * as os from 'node:os';

/**
 * 将相对路径或带 .dsh 前缀的路径规范化为基于 dshHome 的绝对路径。
 * 若传入绝对路径，则直接返回绝对路径。
 */
export function resolveDshPath(dshHome?: string, targetPath?: string, defaultRelative = ''): string {
  const fallbackHome = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const effectiveHome = path.resolve(fallbackHome);
  const candidate = targetPath && targetPath.trim() ? targetPath.trim() : defaultRelative;
  if (!candidate) {
    return effectiveHome;
  }
  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }
  const cleanRelative = candidate.replace(/^(?:\.\/|\.\\)?\.dsh(?:[\\/]|$)/, '');
  return path.resolve(effectiveHome, cleanRelative);
}

/**
 * 将字符串转义为安全的文件路径段（对齐 DSH 0.2.x session-persistence-jsonl 的 encodeSegment 规范）
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Windows 超长路径保护辅助：
 * 在 Windows 下当解析后的绝对路径长度达到或超过 248 字符且尚未带 `\\?\` 前缀时，
 * 转换为 Win32 命名空间路径（`\\?\...` 或 `\\?\UNC\...`）；非 Windows 或短路径保持原样。
 */
export function toSafeNamespacedPath(p: string): string {
  if (!p || process.platform !== 'win32') {
    return p;
  }
  if (p.startsWith('\\\\?\\')) {
    return p;
  }
  const resolved = path.resolve(p);
  if (resolved.length >= 248) {
    return path.toNamespacedPath(resolved);
  }
  return p;
}
