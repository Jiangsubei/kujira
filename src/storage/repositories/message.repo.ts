/**
 * kujira: 消息记录、被动回复槽位与富媒体上传缓存持久化仓库
 * (messages, inbound_reply_slots, media_upload_cache)
 */

import type {
  ChatMessageSummary,
  InboundReplySlot,
  MediaUploadCacheRecord,
  MessageRecord,
  ReadChatHistoryParams,
  ReadChatHistoryResult,
} from '../../types/index.js';
import { formatDateTime, parseTimeValue } from '../time-parser.js';

export class MessageRepository {
  constructor(private getDb: () => any) {}

  private safeParseAttachmentsField(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) || (parsed && typeof parsed === 'object') ? raw : null;
    } catch {
      return null;
    }
  }

  private mapMessageRow(row: any): MessageRecord {
    return {
      msg_id: String(row.msg_id),
      peer: String(row.peer),
      user_id: String(row.user_id),
      sender_name: String(row.sender_name ?? ''),
      time: Number(row.time),
      type: String(row.type),
      content: String(row.content ?? ''),
      raw: String(row.raw ?? ''),
      ref_idx: row.ref_idx ?? null,
      file_id: row.file_id ?? null,
      local_path: row.local_path ?? null,
      fingerprint: row.fingerprint ?? null,
      recalled: Number(row.recalled ?? 0),
      self: Number(row.self ?? 0),
      reply_to: row.reply_to !== null && row.reply_to !== undefined ? String(row.reply_to) : null,
      source: 'qq',
      attachments: this.safeParseAttachmentsField(row.attachments),
    };
  }

  private buildMessageBindings(record: MessageRecord): Record<string, any> {
    return {
      msg_id: String(record.msg_id),
      peer: record.peer,
      user_id: String(record.user_id),
      sender_name: record.sender_name || '',
      time: record.time,
      type: record.type,
      content: record.content,
      raw: typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw),
      ref_idx: record.ref_idx ?? null,
      file_id: record.file_id ?? null,
      local_path: record.local_path ?? null,
      fingerprint: record.fingerprint ?? null,
      recalled: record.recalled ? 1 : 0,
      self: record.self ? 1 : 0,
      reply_to: record.reply_to !== undefined && record.reply_to !== null ? String(record.reply_to) : null,
      source: record.source ?? 'qq',
      attachments: record.attachments ?? null,
    };
  }

  saveMessage(record: MessageRecord): void {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        ref_idx, file_id, local_path, fingerprint, recalled, self, reply_to, source, attachments
      ) VALUES (
        @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
        @ref_idx, @file_id, @local_path, @fingerprint, @recalled, @self, @reply_to, @source, @attachments
      )
    `);
    stmt.run(this.buildMessageBindings(record));
  }

  /**
   * 检查指定消息 ID 是否已存在
   */
  hasMessage(msgId: string): boolean {
    if (!msgId) return false;
    const db = this.getDb();
    const row = db.prepare('SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1').get(String(msgId));
    return Boolean(row);
  }

  /**
   * 获取指定会话 peer 在本地数据库中的最新一条消息时间戳（毫秒）
   */
  getLatestMessageTime(peer: string): number | null {
    const db = this.getDb();
    const row = db.prepare('SELECT MAX(time) AS max_time FROM messages WHERE peer = ?').get(peer) as
      | { max_time: number | null }
      | undefined;
    return row && row.max_time !== null && !Number.isNaN(row.max_time) ? row.max_time : null;
  }

  /**
   * 幂等插入消息：仅在 msg_id 不存在时插入，已存在时忽略且绝不覆盖已有字段（保护已有 local_path 等）
   */
  saveMessageIfNotExists(record: MessageRecord): boolean {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO messages (
        msg_id, peer, user_id, sender_name, time, type, content, raw,
        ref_idx, file_id, local_path, fingerprint, recalled, self, reply_to, source, attachments
      ) VALUES (
        @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
        @ref_idx, @file_id, @local_path, @fingerprint, @recalled, @self, @reply_to, @source, @attachments
      )
    `);
    const result = stmt.run(this.buildMessageBindings(record));
    return result.changes > 0;
  }

  readHistory(peer: string, params: ReadChatHistoryParams = {}): ReadChatHistoryResult {
    const db = this.getDb();
    const conditions: string[] = ['peer = ?'];
    const sqlParams: any[] = [peer];

    // 1. 发送者展示名模糊搜索
    if (params.sender_name !== undefined && params.sender_name.trim() !== '') {
      conditions.push('sender_name LIKE ?');
      sqlParams.push(`%${params.sender_name.trim()}%`);
    }

    // 2. 消息内容关键词模糊搜索
    if (params.keyword !== undefined && params.keyword.trim() !== '') {
      conditions.push('content LIKE ?');
      sqlParams.push(`%${params.keyword.trim()}%`);
    }

    // 3. 消息类型筛选 (支持单类型或类型数组，且查询 text 时兼顾带引用的回复文本 reply)
    if (params.type !== undefined) {
      if (Array.isArray(params.type)) {
        const types = params.type.filter((t) => typeof t === 'string' && t.trim() !== '');
        const expandedTypes = new Set(types);
        if (expandedTypes.has('text')) {
          expandedTypes.add('reply');
        }
        const finalTypes = Array.from(expandedTypes);
        if (finalTypes.length === 1) {
          conditions.push('type = ?');
          sqlParams.push(finalTypes[0]);
        } else if (finalTypes.length > 1) {
          conditions.push(`type IN (${finalTypes.map(() => '?').join(', ')})`);
          sqlParams.push(...finalTypes);
        }
      } else if (typeof params.type === 'string' && params.type.trim() !== '') {
        const t = params.type.trim();
        if (t === 'text') {
          conditions.push("type IN ('text', 'reply')");
        } else {
          conditions.push('type = ?');
          sqlParams.push(t);
        }
      }
    }

    // 4. 友好时间解析与范围筛选
    let sinceTs = parseTimeValue(params.since, false);
    const untilTs = parseTimeValue(params.until, true);

    if (params.since !== undefined && params.since !== null && String(params.since).trim() !== '' && sinceTs === undefined) {
      console.warn(`[MessageDatabase] readHistory: 无法解析 since 时间参数 "${params.since}"，该筛选条件已被忽略`);
    }
    if (params.until !== undefined && params.until !== null && String(params.until).trim() !== '' && untilTs === undefined) {
      console.warn(`[MessageDatabase] readHistory: 无法解析 until 时间参数 "${params.until}"，该筛选条件已被忽略`);
    }

    if (params.relative && sinceTs === undefined) {
      sinceTs = parseTimeValue(params.relative, false);
    }

    if (sinceTs !== undefined && !Number.isNaN(sinceTs)) {
      conditions.push('time >= ?');
      sqlParams.push(sinceTs);
    }

    if (untilTs !== undefined && !Number.isNaN(untilTs)) {
      conditions.push('time <= ?');
      sqlParams.push(untilTs);
    }

    // 5. 附件/多媒体存在性筛选
    if (params.has_file) {
      conditions.push(
        "(local_path IS NOT NULL OR file_id IS NOT NULL OR (attachments IS NOT NULL AND attachments != '' AND attachments != '[]'))"
      );
    }

    // 6. 回复链关系筛选
    if (params.reply_to !== undefined && params.reply_to !== null && String(params.reply_to).trim() !== '') {
      conditions.push('reply_to = ?');
      sqlParams.push(String(params.reply_to).trim());
    }

    // 7. 机器人自身消息过滤
    if (params.exclude_self) {
      conditions.push('self = 0');
    }
    if (params.self_only) {
      conditions.push('self = 1');
    }

    // 8. 消息来源筛选 (单聊仅支持 'qq')
    if (params.source === 'qq') {
      conditions.push('source = ?');
      sqlParams.push('qq');
    }

    const whereClause = conditions.join(' AND ');
    const countRow = db.prepare(`SELECT count(*) as count FROM messages WHERE ${whereClause}`).get(...sqlParams) as { count: number };
    const total = countRow ? countRow.count : 0;

    const order = params.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const offset = Number.isFinite(Number(params.offset)) && Number(params.offset) > 0
      ? Math.floor(Number(params.offset))
      : 0;
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE ${whereClause}
      ORDER BY time ${order}, rowid ${order}
      LIMIT ? OFFSET ?
    `).all(...sqlParams, limit, offset) as any[];

    const messages: ChatMessageSummary[] = rows.map((row) => ({
      msg_id: String(row.msg_id),
      user_id: String(row.user_id),
      sender_name: String(row.sender_name ?? ''),
      time: Number(row.time),
      formatted_time: formatDateTime(Number(row.time)),
      type: String(row.type),
      content: String(row.content ?? ''),
      recalled: row.recalled === 1,
      self: row.self === 1,
      reply_to: row.reply_to !== null && row.reply_to !== undefined ? String(row.reply_to) : null,
      ref_idx: row.ref_idx ?? null,
      local_path: row.local_path ?? null,
      file_id: row.file_id ?? null,
      attachments: this.safeParseAttachmentsField(row.attachments),
      source: 'qq',
    }));

    return {
      messages,
      total: messages.length,
      total_matched: total,
      offset,
      limit,
      has_more: offset + messages.length < total,
    };
  }

  /**
   * 标记消息已撤回。
   * - 机器人自身消息：仅置 recalled=1，保留原文；
   * - 他人消息：内容替换为占位符。
   */
  markRecalled(msgId: string): void {
    if (!msgId) return;
    const db = this.getDb();
    db.prepare(
      `UPDATE messages
         SET recalled = 1,
             content = CASE WHEN self = 1 THEN content ELSE '〔已撤回〕' END
       WHERE msg_id = ?`
    ).run(String(msgId));
  }

  getMessage(msgId: string): MessageRecord | null {
    if (!msgId) return null;
    const db = this.getDb();
    const row = db.prepare(`SELECT * FROM messages WHERE msg_id = ?`).get(String(msgId)) as any;
    return row ? this.mapMessageRow(row) : null;
  }

  getMessageByRefIdx(refIdx: string): MessageRecord | null {
    const trimmed = typeof refIdx === 'string' ? refIdx.trim() : '';
    if (!trimmed) return null;
    const db = this.getDb();
    const row = db
      .prepare(`SELECT * FROM messages WHERE ref_idx = ? ORDER BY time DESC, rowid DESC LIMIT 1`)
      .get(trimmed) as any;
    return row ? this.mapMessageRow(row) : null;
  }

  getByFileId(fileId: string): MessageRecord | null {
    if (!fileId) return null;
    const db = this.getDb();
    const row = db.prepare(`SELECT * FROM messages WHERE file_id = ? LIMIT 1`).get(fileId) as any;
    return row ? this.mapMessageRow(row) : null;
  }

  getByFingerprint(fingerprint: string): MessageRecord | null {
    if (!fingerprint) return null;
    const db = this.getDb();
    const row = db.prepare(`SELECT * FROM messages WHERE fingerprint = ? LIMIT 1`).get(fingerprint) as any;
    return row ? this.mapMessageRow(row) : null;
  }

  updateLocalPath(msgId: string, localPath: string, fingerprint?: string | null): void {
    if (!msgId) return;
    const db = this.getDb();
    if (fingerprint !== undefined) {
      db.prepare(`UPDATE messages SET local_path = ?, fingerprint = ? WHERE msg_id = ?`).run(
        localPath,
        fingerprint,
        String(msgId)
      );
    } else {
      db.prepare(`UPDATE messages SET local_path = ? WHERE msg_id = ?`).run(localPath, String(msgId));
    }
  }

  /**
   * 出站媒体元数据补全：仅更新传入的字段（file_id / local_path / raw / attachments / ref_idx），
   * 绝不覆盖未传入的已有值。
   */
  updateMessageMedia(
    msgId: string,
    patch: {
      file_id?: string | null;
      local_path?: string | null;
      raw?: string;
      attachments?: string | null;
      ref_idx?: string | null;
    }
  ): void {
    if (!msgId) return;
    const db = this.getDb();
    const sets: string[] = [];
    const values: any[] = [];

    if (patch.file_id !== undefined) {
      sets.push('file_id = ?');
      values.push(patch.file_id ?? null);
    }
    if (patch.local_path !== undefined) {
      sets.push('local_path = ?');
      values.push(patch.local_path ?? null);
    }
    if (patch.raw !== undefined) {
      sets.push('raw = ?');
      values.push(patch.raw);
    }
    if (patch.attachments !== undefined) {
      sets.push('attachments = ?');
      values.push(patch.attachments ?? null);
    }
    if (patch.ref_idx !== undefined) {
      sets.push('ref_idx = ?');
      values.push(patch.ref_idx ?? null);
    }
    if (sets.length === 0) return;

    values.push(String(msgId));
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE msg_id = ?`).run(...values);
  }

  updateLocalPathByFileId(fileId: string, localPath: string, fingerprint?: string | null): void {
    if (!fileId) return;
    const db = this.getDb();
    if (fingerprint !== undefined) {
      db.prepare(`UPDATE messages SET local_path = ?, fingerprint = ? WHERE file_id = ?`).run(
        localPath,
        fingerprint,
        fileId
      );
    } else {
      db.prepare(`UPDATE messages SET local_path = ? WHERE file_id = ?`).run(localPath, fileId);
    }
  }

  clearLocalPath(localPath: string): void {
    if (!localPath) return;
    const db = this.getDb();
    db.prepare(`UPDATE messages SET local_path = NULL WHERE local_path = ?`).run(localPath);
  }

  // ==================== 入站被动回复槽位与 msg_seq 持久化 ====================

  /**
   * 登记入站被动回复锚点（仅来自 C2C_MESSAGE_CREATE d.id）。
   * 若已存在则仅刷新 received_at 与 updated_at，绝不回退 last_seq。
   */
  recordInboundReplySlot(msgId: string, peer: string, openid: string, receivedAt?: number): void {
    const cleanMsgId = String(msgId || '').trim();
    const cleanPeer = String(peer || '').trim();
    const cleanOpenid = String(openid || '').trim();
    if (!cleanMsgId || !cleanPeer || !cleanOpenid) {
      throw new Error('[MessageRepository] recordInboundReplySlot requires non-empty msgId, peer, and openid');
    }

    const db = this.getDb();
    const now = Date.now();
    const ts = typeof receivedAt === 'number' && Number.isFinite(receivedAt) ? receivedAt : now;

    db.prepare(`
      INSERT INTO inbound_reply_slots (
        msg_id, peer, openid, last_seq, received_at, invalidated, updated_at
      ) VALUES (?, ?, ?, 0, ?, 0, ?)
      ON CONFLICT(msg_id) DO UPDATE SET
        peer = excluded.peer,
        openid = excluded.openid,
        received_at = excluded.received_at,
        updated_at = excluded.updated_at
    `).run(cleanMsgId, cleanPeer, cleanOpenid, ts, now);
  }

  /**
   * 事务内原子递增并持久化 msg_seq。
   * 遇未登记 ID 且未提供 seed 时直接抛错，严防误将出站 body.id 当作被动锚点。
   */
  allocateNextMsgSeq(msgId: string, seed?: { peer: string; openid: string }): number {
    const cleanMsgId = String(msgId || '').trim();
    if (!cleanMsgId) {
      throw new Error('[MessageRepository] allocateNextMsgSeq requires non-empty msgId');
    }

    const db = this.getDb();
    const run = db.transaction((): number => {
      const now = Date.now();
      const row = db
        .prepare('SELECT last_seq FROM inbound_reply_slots WHERE msg_id = ?')
        .get(cleanMsgId) as { last_seq: number } | undefined;

      if (!row) {
        const cleanPeer = seed?.peer ? String(seed.peer).trim() : '';
        const cleanOpenid = seed?.openid ? String(seed.openid).trim() : '';
        if (!cleanPeer || !cleanOpenid) {
          throw new Error(
            `[MessageRepository] Unregistered inbound msg_id "${cleanMsgId}": refusing to allocate msg_seq without seed`
          );
        }
        db.prepare(`
          INSERT INTO inbound_reply_slots (
            msg_id, peer, openid, last_seq, received_at, invalidated, updated_at
          ) VALUES (?, ?, ?, 1, ?, 0, ?)
        `).run(cleanMsgId, cleanPeer, cleanOpenid, now, now);
        return 1;
      }

      const nextSeq = Number(row.last_seq ?? 0) + 1;
      db.prepare('UPDATE inbound_reply_slots SET last_seq = ?, updated_at = ? WHERE msg_id = ?').run(
        nextSeq,
        now,
        cleanMsgId
      );
      return nextSeq;
    });

    return run();
  }

  /**
   * 40054005 跨天去重残留重试跳槽持久化：将槽位推进至至少 minNextSeq 并返回新分配的 msg_seq。
   */
  advanceMsgSeq(msgId: string, minNextSeq: number): number {
    const cleanMsgId = String(msgId || '').trim();
    if (!cleanMsgId) {
      throw new Error('[MessageRepository] advanceMsgSeq requires non-empty msgId');
    }

    const db = this.getDb();
    const run = db.transaction((): number => {
      const row = db
        .prepare('SELECT last_seq FROM inbound_reply_slots WHERE msg_id = ?')
        .get(cleanMsgId) as { last_seq: number } | undefined;

      if (!row) {
        throw new Error(`[MessageRepository] Unregistered inbound msg_id "${cleanMsgId}": cannot advance msg_seq`);
      }

      const floorMin = Number.isFinite(minNextSeq) ? Math.max(1, Math.floor(minNextSeq)) : 1;
      const nextSeq = Math.max(Number(row.last_seq ?? 0) + 1, floorMin);
      db.prepare('UPDATE inbound_reply_slots SET last_seq = ?, updated_at = ? WHERE msg_id = ?').run(
        nextSeq,
        Date.now(),
        cleanMsgId
      );
      return nextSeq;
    });

    return run();
  }

  /**
   * 标记指定入站锚点已失效（如平台返回窗口超限或无效锚点错误）
   */
  markInboundSlotInvalidated(msgId: string): void {
    const cleanMsgId = typeof msgId === 'string' ? msgId.trim() : '';
    if (!cleanMsgId) return;
    const db = this.getDb();
    db.prepare('UPDATE inbound_reply_slots SET invalidated = 1, updated_at = ? WHERE msg_id = ?').run(
      Date.now(),
      cleanMsgId
    );
  }

  /**
   * 获取指定 peer 最近一条仍有效的入站被动回复槽位
   */
  getLatestValidInboundSlot(peer: string): InboundReplySlot | null {
    const cleanPeer = typeof peer === 'string' ? peer.trim() : '';
    if (!cleanPeer) return null;
    const db = this.getDb();
    const row = db
      .prepare(`
        SELECT msg_id, peer, openid, last_seq, received_at, invalidated, updated_at
        FROM inbound_reply_slots
        WHERE peer = ? AND invalidated = 0
        ORDER BY received_at DESC, updated_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(cleanPeer) as any;

    if (!row) return null;
    return {
      msg_id: String(row.msg_id),
      peer: String(row.peer),
      openid: String(row.openid),
      last_seq: Number(row.last_seq ?? 0),
      received_at: Number(row.received_at),
      invalidated: Number(row.invalidated ?? 0),
      updated_at: Number(row.updated_at),
    };
  }

  // ==================== 富媒体四步上传 file_info 缓存 ====================

  getCachedMediaUpload(
    openid: string,
    md5: string,
    fileType: number,
    now: number = Date.now()
  ): MediaUploadCacheRecord | null {
    const cleanOpenid = typeof openid === 'string' ? openid.trim() : '';
    const cleanMd5 = typeof md5 === 'string' ? md5.trim() : '';
    if (!cleanOpenid || !cleanMd5 || !Number.isFinite(fileType)) {
      return null;
    }

    const db = this.getDb();
    const currentTs = Number.isFinite(now) ? now : Date.now();
    const row = db
      .prepare(`
        SELECT openid, md5, file_type, file_info, file_uuid, expires_at
        FROM media_upload_cache
        WHERE openid = ? AND md5 = ? AND file_type = ? AND expires_at > ?
        LIMIT 1
      `)
      .get(cleanOpenid, cleanMd5, fileType, currentTs) as any;

    if (!row) return null;

    return {
      openid: String(row.openid),
      md5: String(row.md5),
      file_type: Number(row.file_type),
      file_info: String(row.file_info),
      ...(row.file_uuid ? { file_uuid: String(row.file_uuid) } : {}),
      expires_at: Number(row.expires_at),
    };
  }

  saveCachedMediaUpload(record: MediaUploadCacheRecord): void {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO media_upload_cache (
        openid, md5, file_type, file_info, file_uuid, expires_at
      ) VALUES (
        @openid, @md5, @file_type, @file_info, @file_uuid, @expires_at
      )
    `).run({
      openid: String(record.openid).trim(),
      md5: String(record.md5).trim(),
      file_type: record.file_type,
      file_info: record.file_info,
      file_uuid: record.file_uuid ?? null,
      expires_at: record.expires_at,
    });
  }
}
