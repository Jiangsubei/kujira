/**
 * kujira: 会话标题与版本后缀展示辅助模块
 */

import { formatSessionVersionTag } from '../../gateway/session.js';

export const DEFAULT_SESSION_TITLE = '新会话';

export interface SessionDisplaySource {
  listPeerSessionIds?(peer: string): string[];
  getSessionTitle?(sessionId: string): string | undefined;
}

export interface PeerSessionDisplayEntry {
  sid: string;
  num: number;
  baseTitle: string;
  tag: string;
  hasDuplicate: boolean;
  label: string;
}

export function resolveBaseSessionTitle(
  sm: SessionDisplaySource | undefined,
  sessionId: string
): string {
  const title = sm?.getSessionTitle?.(sessionId)?.trim();
  return title || DEFAULT_SESSION_TITLE;
}

/**
 * 解析指定 peer 下全部会话的展示条目（降序：新→旧，序号 1..N 与 /会话 <序号> 严格对齐）。
 * 仅当同一 peer 下存在多个相同基础标题时，才为重名组内会话追加版本后缀 `(#N)`。
 */
export function resolvePeerSessionDisplayEntries(
  sm: SessionDisplaySource | undefined,
  peer: string,
  currentSidFallback?: string
): PeerSessionDisplayEntry[] {
  const rawSessions = sm?.listPeerSessionIds?.(peer) ?? [];
  const sessions =
    rawSessions.length > 0
      ? [...rawSessions].reverse()
      : currentSidFallback
        ? [currentSidFallback]
        : [];

  const draft = sessions.map((sid, index) => ({
    sid,
    num: index + 1,
    baseTitle: resolveBaseSessionTitle(sm, sid),
    tag: formatSessionVersionTag(sid),
  }));

  const titleCounts = new Map<string, number>();
  for (const item of draft) {
    titleCounts.set(item.baseTitle, (titleCounts.get(item.baseTitle) ?? 0) + 1);
  }

  return draft.map((item) => {
    const hasDuplicate = (titleCounts.get(item.baseTitle) ?? 0) > 1;
    const label = hasDuplicate ? `${item.baseTitle} (${item.tag})` : item.baseTitle;
    return {
      ...item,
      hasDuplicate,
      label,
    };
  });
}

/**
 * 解析单个会话在当前 peer 上下文中的展示标题（无重名不带 `(#N)`，有重名带 `(#N)`）。
 */
export function resolveSessionDisplayLabel(
  sm: SessionDisplaySource | undefined,
  peer: string,
  targetSid: string
): string {
  const entries = resolvePeerSessionDisplayEntries(sm, peer, targetSid);
  const matched = entries.find((entry) => entry.sid === targetSid);
  if (matched) {
    return matched.label;
  }

  const baseTitle = resolveBaseSessionTitle(sm, targetSid);
  const hasDuplicate = entries.some((entry) => entry.baseTitle === baseTitle);
  return hasDuplicate ? `${baseTitle} (${formatSessionVersionTag(targetSid)})` : baseTitle;
}
