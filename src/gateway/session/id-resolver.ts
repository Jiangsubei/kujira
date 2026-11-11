/**
 * kujira: 会话标识解析、编解码、空缺填补与哈希计算模块
 * 纯函数逻辑，零外部服务依赖（统一适配 QQ 官方 Bot 单聊 `kujira-user-<hash16>`）。
 */

import * as crypto from 'node:crypto';
import { computeOpenidHash16, openidToSessionBaseId } from '../../utils/peer.js';
import type { ParsedSessionId } from './types.js';

/**
 * 解析 DSH SessionId（支持基础版本 kujira-user-<id> / kujira-user-<id>-2、多轮归档版本 -r1-1 及带短哈希防撞版本）
 */
export function parseSessionId(sessionId: string): ParsedSessionId | null {
  if (typeof sessionId !== 'string') return null;
  const userMatch = sessionId.match(
    /^kujira-user-([0-9a-zA-Z_]+?)(?:-r(\d+))?(?:-(\d+))?(?:-([0-9a-fA-F]{4,16}))?$/
  );
  if (!userMatch) {
    return null;
  }
  const id = userMatch[1]!;
  const round = userMatch[2] ? parseInt(userMatch[2], 10) : 0;
  const version = userMatch[3] ? parseInt(userMatch[3], 10) : 1;
  const hash = userMatch[4] || undefined;
  return {
    peer: `user_${id}`,
    id,
    round,
    version,
    ...(hash ? { hash } : {}),
    isGroup: false,
  };
}

/**
 * 生成 6 位十六进制短哈希防撞后缀
 */
export function generateSessionHash(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * 从当前未归档活跃会话的版本列表中，寻找最小未占用正整数编号 (First Missing Positive)
 * 例如活跃集合为 [3]，返回 1；活跃集合为 [1, 3]，返回 2；活跃集合为 [1, 2, 3]，返回 4。
 */
export function findSmallestAvailableVersion(activeVersions: Iterable<number>): number {
  const set = new Set(activeVersions);
  let v = 1;
  while (set.has(v)) {
    v++;
  }
  return v;
}

/**
 * 构造符合命名规范的 SessionId (支持短哈希后缀)
 */
export function buildSessionId(
  baseId: string,
  round: number,
  version: number,
  hash?: string
): string {
  const hashSuffix = hash ? `-${hash}` : '';
  if (round === 0) {
    if (hash) {
      return `${baseId}-${version}${hashSuffix}`;
    }
    return version === 1 ? baseId : `${baseId}-${version}`;
  }
  return `${baseId}-r${round}-${version}${hashSuffix}`;
}

/**
 * 将单聊 peer (`user_<hash16>`) 或 32 位 hex `openid` 转换为 SessionId 基础前缀 `kujira-user-<hash16>`
 */
export function peerToBaseId(peer: string): string {
  if (peer.startsWith('user_')) {
    return `kujira-user-${peer.slice(5)}`;
  }
  const parsed = parseSessionId(peer);
  if (parsed) {
    return `kujira-user-${parsed.id}`;
  }
  if (/^[0-9a-fA-F]{32}$/.test(peer)) {
    return openidToSessionBaseId(peer);
  }
  if (peer.startsWith('kujira-')) {
    return peer;
  }
  return `kujira-${peer}`;
}

/**
 * 将 DSH SessionId 反向解析为内部单聊 Peer (`user_<hash16>`，支持自动剥离版本/轮次后缀)
 */
export function sessionIdToPeer(sessionId: string): string {
  const parsed = parseSessionId(sessionId);
  if (parsed) {
    return parsed.peer;
  }
  if (sessionId.startsWith('user_')) {
    return sessionId;
  }
  return sessionId;
}

/**
 * 判断 SessionId 是否属于 Kujira 单聊会话
 */
export function isKujiraSession(sessionId: string): boolean {
  return (
    typeof sessionId === 'string' &&
    (sessionId.startsWith('kujira-user-') || sessionId.startsWith('kujira-'))
  );
}

/** 内部兼容别名，等价于 {@link isKujiraSession} */
export const isQQSession = isKujiraSession;

function extractPeerDisplayId(peer: string): string {
  if (peer.startsWith('user_')) {
    return peer.slice(5).split('-')[0] || peer;
  }
  if (peer.startsWith('kujira-user-')) {
    return parseSessionId(peer)?.id || peer.slice('kujira-user-'.length).split('-')[0] || peer;
  }
  if (/^[0-9a-fA-F]{32}$/.test(peer)) {
    return computeOpenidHash16(peer);
  }
  return peer;
}

/**
 * 从单聊会话标题中反向提取显示名称（格式：`私聊: ... <id> #N`）
 * 无法提取出名称时返回 undefined。
 */
export function extractNameFromSessionTitle(
  title: string | undefined,
  peer: string
): string | undefined {
  if (!title || typeof title !== 'string') return undefined;

  const stripped = title
    .replace(/^私聊:\s*/, '')
    .replace(/\s+#\d+.*$/, '')
    .trim();
  if (!stripped) return undefined;

  const peerId = extractPeerDisplayId(peer);
  let name = stripped;
  if (peerId && name.endsWith(peerId)) {
    name = name.slice(0, -peerId.length).trim();
  }
  return name || undefined;
}

/**
 * 根据 peer、sessionId 与昵称格式化单聊会话标题（支持多轮归档格式如 `#1 (1)`）
 */
export function formatSessionTitle(
  peer: string,
  sessionId: string,
  name?: string
): string {
  let versionNum = '1';
  let roundNum = 0;
  const parsed = parseSessionId(sessionId);
  if (parsed) {
    versionNum = String(parsed.version);
    roundNum = parsed.round;
  }

  const tag = roundNum > 0 ? `#${versionNum} (${roundNum})` : `#${versionNum}`;
  const hashOrId = extractPeerDisplayId(peer);
  const displayName = name ? `${name} ` : '';
  return `私聊: ${displayName}${hashOrId} ${tag}`;
}

export {
  formatTimeOnly,
  formatSenderString,
  resolveChannelInfo,
  formatMsgIdString,
  formatQuotedString,
  formatMessageBody,
  formatExternalPrompt,
  formatWakeupPrompt,
} from '../external-prompt.js';
