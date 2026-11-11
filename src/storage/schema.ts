/**
 * kujira: 数据库表结构初始化 (QQ 官方 Bot API v2 合规单聊)
 */

import { formatShortMessageId, parseShortMessageId } from '../utils/short-id.js';

function ensureAndBackfillShortIds(db: any): void {
  const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const hasShortIdColumn = columns.some((col) => col.name === 'short_id');
  if (!hasShortIdColumn) {
    db.exec('ALTER TABLE messages ADD COLUMN short_id TEXT');
  }

  const missingRows = db
    .prepare(
      `SELECT rowid, peer, self
       FROM messages
       WHERE short_id IS NULL OR short_id = ''
       ORDER BY peer ASC, time ASC, rowid ASC`
    )
    .all() as Array<{ rowid: number; peer: string; self: number }>;

  if (missingRows.length > 0) {
    const maxSeqByKey = new Map<string, number>();
    const affectedPeers = Array.from(new Set(missingRows.map((r) => String(r.peer))));
    const selectExisting = db.prepare(
      `SELECT short_id FROM messages WHERE peer = ? AND short_id IS NOT NULL AND short_id != ''`
    );

    for (const peer of affectedPeers) {
      const existingRows = selectExisting.all(peer) as Array<{ short_id: string }>;
      for (const existing of existingRows) {
        const parsed = parseShortMessageId(existing.short_id);
        if (!parsed) continue;
        const selfBit = parsed.direction === 'outbound' ? 1 : 0;
        const key = `${peer}\0${selfBit}`;
        const prev = maxSeqByKey.get(key) ?? 0;
        if (parsed.seq > prev) {
          maxSeqByKey.set(key, parsed.seq);
        }
      }
    }

    const updateStmt = db.prepare('UPDATE messages SET short_id = ? WHERE rowid = ?');
    for (const row of missingRows) {
      const peer = String(row.peer);
      const selfBit = row.self ? 1 : 0;
      const key = `${peer}\0${selfBit}`;
      const nextSeq = (maxSeqByKey.get(key) ?? 0) + 1;
      maxSeqByKey.set(key, nextSeq);
      updateStmt.run(formatShortMessageId(selfBit, nextSeq), row.rowid);
    }
  }

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_peer_short_id ON messages (peer, short_id);`);
}

export function initDatabaseSchema(db: any): void {
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        short_id TEXT,
        peer TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        time INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        raw TEXT NOT NULL,
        ref_idx TEXT,
        file_id TEXT,
        local_path TEXT,
        fingerprint TEXT,
        recalled INTEGER NOT NULL DEFAULT 0,
        self INTEGER NOT NULL DEFAULT 0,
        reply_to TEXT,
        source TEXT NOT NULL DEFAULT 'qq',
        attachments TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_peer_time ON messages (peer, time);
      CREATE INDEX IF NOT EXISTS idx_messages_peer_user_time ON messages (peer, user_id, time);
      CREATE INDEX IF NOT EXISTS idx_messages_ref_idx ON messages (ref_idx);
      CREATE INDEX IF NOT EXISTS idx_messages_file_id ON messages (file_id);
      CREATE INDEX IF NOT EXISTS idx_messages_fingerprint ON messages (fingerprint);
      CREATE INDEX IF NOT EXISTS idx_messages_peer_source_time ON messages (peer, source, time);

      CREATE TABLE IF NOT EXISTS peer_openid_map (
        peer TEXT PRIMARY KEY,
        openid TEXT UNIQUE NOT NULL,
        remark TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_reply_slots (
        msg_id TEXT PRIMARY KEY,
        peer TEXT NOT NULL,
        openid TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL,
        invalidated INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inbound_slots_peer_valid
        ON inbound_reply_slots (peer, invalidated, received_at DESC);

      CREATE TABLE IF NOT EXISTS media_upload_cache (
        openid TEXT NOT NULL,
        md5 TEXT NOT NULL,
        file_type INTEGER NOT NULL,
        file_info TEXT NOT NULL,
        file_uuid TEXT,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (openid, md5, file_type)
      );

      CREATE TABLE IF NOT EXISTS session_states (
        peer TEXT PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        cleared_round INTEGER NOT NULL DEFAULT 0,
        cleared_version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        model_provider TEXT,
        model_name TEXT,
        model_reasoning_effort TEXT
      );

      CREATE TABLE IF NOT EXISTS plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS faces (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        md5 TEXT NOT NULL UNIQUE,
        added_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        tags TEXT NOT NULL,
        mood TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        size INTEGER NOT NULL,
        format TEXT NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_faces_enabled ON faces (enabled);
      CREATE INDEX IF NOT EXISTS idx_faces_deleted ON faces (deleted_at);
      CREATE INDEX IF NOT EXISTS idx_faces_last_used ON faces (last_used_at);

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        peer TEXT NOT NULL,
        creator TEXT NOT NULL,
        prompt TEXT NOT NULL,
        type TEXT NOT NULL,
        recurring_rule TEXT,
        next_run_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_pending_run ON scheduled_tasks (status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_peer ON scheduled_tasks (peer, status);

      CREATE TABLE IF NOT EXISTS slang_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT UNIQUE NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        definition TEXT NOT NULL,
        example TEXT,
        query_count INTEGER NOT NULL DEFAULT 0,
        last_queried_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_slang_term ON slang_entries (term);
      CREATE INDEX IF NOT EXISTS idx_slang_query_count ON slang_entries (query_count);
      CREATE INDEX IF NOT EXISTS idx_slang_updated_at ON slang_entries (updated_at);
    `);

    ensureAndBackfillShortIds(db);
  });

  run();
}
