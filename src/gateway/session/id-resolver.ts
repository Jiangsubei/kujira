/**
 * kujira: 会话标识解析、编解码、空缺填补与哈希计算模块
 * 纯函数逻辑，零外部服务依赖（统一适配 QQ 官方 Bot 单聊 `kujira-user-<hash16>`）。
 */

import * as crypto from 'node:crypto';
import { openidToSessionBaseId } from '../../utils/peer.js';
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

/**
 * 格式化会话版本轮次标签（如 `#1`、`#2` 或多轮归档 `#2 (1)`）
 */
export function formatSessionVersionTag(sessionId: string): string {
  const parsed = parseSessionId(sessionId);
  if (!parsed) {
    return '#1';
  }
  return parsed.round > 0
    ? `#${parsed.version} (${parsed.round})`
    : `#${parsed.version}`;
}

/**
 * 生成尚无原生 AI 总结标题时的默认回退会话标题（如 `新会话 #1`、`新会话 #2 (1)`）
 */
export function formatFallbackSessionTitle(sessionId: string): string {
  return `新会话 ${formatSessionVersionTag(sessionId)}`;
}

export { encodeSegment } from '../../utils/path.js';

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
