/**
 * kujira: 会话状态、模型路由偏好及 peer<->openid 身份映射持久化仓库
 * (session_states, peer_openid_map)
 */

import type { KnownPeerSummaryRecord, SessionStateRecord } from '../../types/index.js';

export type { KnownPeerSummaryRecord, SessionStateRecord };

const PEER_PREVIEW_MAX_CHARS = 16;
const SHORT_OPENID_LEN = 8;

function formatLastMessagePreview(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const chars = Array.from(compact);
  if (chars.length <= PEER_PREVIEW_MAX_CHARS) {
    return compact;
  }
  return `${chars.slice(0, PEER_PREVIEW_MAX_CHARS).join('')}…`;
}

export class SessionRepository {
  constructor(private getDb: () => any) {}

  saveSessionState(state: SessionStateRecord): void {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO session_states (
        peer, current_session_id, cleared_round, cleared_version, updated_at,
        model_provider, model_name, model_reasoning_effort
      ) VALUES (
        @peer, @current_session_id, @cleared_round, @cleared_version, @updated_at,
        @model_provider, @model_name, @model_reasoning_effort
      )
    `).run({
      peer: state.peer,
      current_session_id: state.current_session_id,
      cleared_round: state.cleared_round ?? 0,
      cleared_version: state.cleared_version ?? 1,
      updated_at: state.updated_at || Date.now(),
      model_provider: state.model_provider ?? null,
      model_name: state.model_name ?? null,
      model_reasoning_effort: state.model_reasoning_effort ?? null,
    });
  }

  getSessionState(peer: string): SessionStateRecord | null {
    const db = this.getDb();
    const row = db.prepare(`SELECT * FROM session_states WHERE peer = ?`).get(peer) as any;
    if (!row) return null;
    return {
      peer: row.peer,
      current_session_id: row.current_session_id,
      cleared_round: Number(row.cleared_round ?? 0),
      cleared_version: Number(row.cleared_version ?? 1),
      updated_at: Number(row.updated_at),
      model_provider: row.model_provider || undefined,
      model_name: row.model_name || undefined,
      model_reasoning_effort: row.model_reasoning_effort || undefined,
    };
  }

  getAllSessionStates(): SessionStateRecord[] {
    const db = this.getDb();
    const rows = db.prepare(`SELECT * FROM session_states`).all() as any[];
    return rows.map((row) => ({
      peer: row.peer,
      current_session_id: row.current_session_id,
      cleared_round: Number(row.cleared_round ?? 0),
      cleared_version: Number(row.cleared_version ?? 1),
      updated_at: Number(row.updated_at),
      model_provider: row.model_provider || undefined,
      model_name: row.model_name || undefined,
      model_reasoning_effort: row.model_reasoning_effort || undefined,
    }));
  }

  /**
   * 写入或刷新方案 A 身份映射：内部 peer (`user_<hash16>`) <-> 真实 `openid`
   */
  upsertPeerOpenid(peer: string, openid: string, remark?: string): void {
    const cleanPeer = String(peer || '').trim();
    const cleanOpenid = String(openid || '').trim();
    if (!cleanPeer || !cleanOpenid) {
      throw new Error('[SessionRepository] upsertPeerOpenid requires non-empty peer and openid');
    }

    const db = this.getDb();
    const hasRemark = remark !== undefined ? 1 : 0;
    const remarkVal = remark !== undefined ? String(remark) : '';
    const updatedAt = Date.now();

    db.prepare(`
      INSERT INTO peer_openid_map (peer, openid, remark, updated_at)
      VALUES (@peer, @openid, @remark, @updated_at)
      ON CONFLICT(peer) DO UPDATE SET
        openid = excluded.openid,
        remark = CASE WHEN @has_remark = 1 THEN excluded.remark ELSE peer_openid_map.remark END,
        updated_at = excluded.updated_at
    `).run({
      peer: cleanPeer,
      openid: cleanOpenid,
      remark: remarkVal,
      has_remark: hasRemark,
      updated_at: updatedAt,
    });
  }

  /**
   * 根据内部 `peer` 反查真实 `openid`（出站接口调用前必需）
   */
  getOpenidByPeer(peer: string): string | null {
    const cleanPeer = typeof peer === 'string' ? peer.trim() : '';
    if (!cleanPeer) return null;
    const db = this.getDb();
    const row = db
      .prepare('SELECT openid FROM peer_openid_map WHERE peer = ? LIMIT 1')
      .get(cleanPeer) as { openid?: string } | undefined;
    return row?.openid ? String(row.openid) : null;
  }

  /**
   * 根据真实 `openid` 查询已登记的内部 `peer`
   */
  getPeerByOpenid(openid: string): string | null {
    const cleanOpenid = typeof openid === 'string' ? openid.trim() : '';
    if (!cleanOpenid) return null;
    const db = this.getDb();
    const row = db
      .prepare('SELECT peer FROM peer_openid_map WHERE openid = ? LIMIT 1')
      .get(cleanOpenid) as { peer?: string } | undefined;
    return row?.peer ? String(row.peer) : null;
  }

  /**
   * 全量列举已登记过身份映射的 peer（即「曾经真实互动过」的用户）。
   * 冷场搭话据此判定：有 peer 记录才允许为其创建会话并唤醒，
   * 绝不为从未出现过的 User 凭空新建 Session。
   */
  getAllPeers(): string[] {
    const db = this.getDb();
    const rows = db.prepare('SELECT peer FROM peer_openid_map').all() as Array<{ peer?: unknown }>;
    const out: string[] = [];
    for (const row of rows) {
      const peer = typeof row?.peer === 'string' ? row.peer.trim() : '';
      if (peer) out.push(peer);
    }
    return out;
  }

  /**
   * 枚举所有曾经互动过的单聊用户脱敏摘要（按最近入站消息时间倒序）。
   * 仅统计用户入站消息（self = 0），绝不返回完整明文 openid。
   */
  listKnownPeersWithLastMessage(): KnownPeerSummaryRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare(`
        SELECT
          p.peer AS peer,
          p.openid AS openid,
          p.updated_at AS updated_at,
          m.time AS last_message_time,
          m.content AS last_message_content
        FROM peer_openid_map p
        LEFT JOIN messages m
          ON m.rowid = (
            SELECT m2.rowid
            FROM messages m2
            WHERE m2.peer = p.peer AND m2.self = 0
            ORDER BY m2.time DESC, m2.rowid DESC
            LIMIT 1
          )
        ORDER BY
          CASE WHEN m.time IS NULL THEN 1 ELSE 0 END ASC,
          m.time DESC,
          p.updated_at DESC,
          p.peer ASC
      `)
      .all() as Array<{
      peer?: unknown;
      openid?: unknown;
      last_message_time?: unknown;
      last_message_content?: unknown;
    }>;

    const out: KnownPeerSummaryRecord[] = [];
    for (const row of rows) {
      const peer = typeof row?.peer === 'string' ? row.peer.trim() : '';
      const openid = typeof row?.openid === 'string' ? row.openid.trim() : '';
      if (!peer) continue;
      const lastTime =
        typeof row?.last_message_time === 'number' && Number.isFinite(row.last_message_time)
          ? row.last_message_time
          : null;
      out.push({
        peer,
        short_openid: openid ? openid.slice(0, SHORT_OPENID_LEN) : peer.slice(0, SHORT_OPENID_LEN),
        last_message_time: lastTime,
        last_message_preview: formatLastMessagePreview(row?.last_message_content),
      });
    }
    return out;
  }
}
