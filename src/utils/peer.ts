/**
 * kujira: QQ 官方 Bot 单聊身份映射工具（方案 A：短 Hash + 数据库双向映射）
 *
 * 将入站 `author.user_openid` 稳定映射为内部 `peer` (`user_<hash16>`) 与
 * DSH SessionId 基础前缀 (`kujira-user-<hash16>`)。
 * 注意：此映射为单向摘要，出站发信前必须通过数据库 `peer_openid_map` 反查真实 `openid`。
 */

import * as crypto from 'node:crypto';

/**
 * 校验 `openid` 合法性：必须为非空字符串且不含任何空白或 ASCII 控制字符。
 * 线上实测 `author.user_openid` 为 32 位大写十六进制字符串，此处保持宽松校验以兼容平台演进。
 */
export function isValidOpenid(openid: string): boolean {
  if (typeof openid !== 'string' || openid.length === 0) {
    return false;
  }
  return !/[\s\u0000-\u001f\u007f]/.test(openid);
}

/**
 * 计算 `openid` 的 SHA-256 摘要前 16 位小写十六进制字符串（`[0-9a-f]{16}`）。
 */
export function computeOpenidHash16(openid: string): string {
  if (!isValidOpenid(openid)) {
    throw new Error('Invalid openid: must be a non-empty string without whitespace or control characters');
  }
  return crypto.createHash('sha256').update(openid, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 将 `openid` 映射为内部单聊 `peer`：`user_<hash16>`。
 */
export function openidToPeer(openid: string): string {
  return `user_${computeOpenidHash16(openid)}`;
}

/**
 * 将 `openid` 映射为 DSH SessionId 基础前缀：`kujira-user-<hash16>`。
 */
export function openidToSessionBaseId(openid: string): string {
  return `kujira-user-${computeOpenidHash16(openid)}`;
}

/**
 * 从内部单聊 `peer` (`user_<hash16>`) 中提取 `<hash16>` 部分；
 * 兼容字母、数字与下划线（不假定纯数字），非单聊 user peer 返回 `null`。
 */
export function extractPeerHash(peer: string): string | null {
  if (typeof peer !== 'string') {
    return null;
  }
  const match = /^user_([A-Za-z0-9_]+)$/.exec(peer);
  return match ? match[1]! : null;
}
