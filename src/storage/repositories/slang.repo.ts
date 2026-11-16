/**
 * kujira: 黑话词典持久化仓库 (slang_entries)
 */

import type { SlangEntry, SlangQueryOptions } from '../../types/index.js';

export class SlangRepository {
  constructor(private getDb: () => any) {}

  private mapSlangRow(row: any): SlangEntry {
    return {
      id: row.id,
      term: row.term,
      tags: row.tags || '',
      definition: row.definition,
      example: row.example || '',
      query_count: row.query_count || 0,
      last_queried_at: row.last_queried_at || null,
      deleted_at: row.deleted_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 按词条标题检索黑话词条
   * @param term 标题名称
   * @param incrementQueryCount 是否自增 query_count 并更新 last_queried_at
   * @param includeDeleted 是否包含已处于回收站的词条
   */
  getSlangEntry(term: string, incrementQueryCount = false, includeDeleted = false): SlangEntry | null {
    const db = this.getDb();
    const clean = term.trim();
    if (!clean) return null;

    const sql = includeDeleted
      ? 'SELECT * FROM slang_entries WHERE term = ?'
      : 'SELECT * FROM slang_entries WHERE term = ? AND deleted_at IS NULL';
    let row = db.prepare(sql).get(clean);
    if (!row) return null;

    if (incrementQueryCount) {
      const now = Date.now();
      db.prepare('UPDATE slang_entries SET query_count = query_count + 1, last_queried_at = ? WHERE id = ?').run(now, row.id);
      row.query_count = (row.query_count || 0) + 1;
      row.last_queried_at = now;
    }

    return this.mapSlangRow(row);
  }

  /**
   * 插入新黑话词条
   */
  insertSlangEntry(entry: {
    term: string;
    tags?: string;
    definition: string;
    example?: string;
  }): SlangEntry {
    const db = this.getDb();
    const cleanTerm = entry.term.trim();
    const cleanDef = entry.definition.trim();
    const cleanTags = (entry.tags || '').trim();
    const cleanEx = (entry.example || '').trim();
    const now = Date.now();

    const info = db.prepare(`
      INSERT INTO slang_entries (term, tags, definition, example, query_count, last_queried_at, deleted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)
    `).run(cleanTerm, cleanTags, cleanDef, cleanEx, now, now);

    return {
      id: Number(info.lastInsertRowid),
      term: cleanTerm,
      tags: cleanTags,
      definition: cleanDef,
      example: cleanEx,
      query_count: 0,
      last_queried_at: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * 更新已有黑话词条
   */
  updateSlangEntry(
    term: string,
    updates: {
      new_term?: string;
      tags?: string;
      definition?: string;
      example?: string;
      deleted_at?: number | null;
    }
  ): SlangEntry | null {
    const db = this.getDb();
    const existing = this.getSlangEntry(term, false, true);
    if (!existing) return null;

    const sets: string[] = [];
    const values: any[] = [];

    if (updates.new_term !== undefined && updates.new_term.trim()) {
      sets.push('term = ?');
      values.push(updates.new_term.trim());
    }
    if (updates.tags !== undefined) {
      sets.push('tags = ?');
      values.push(updates.tags.trim());
    }
    if (updates.definition !== undefined && updates.definition.trim()) {
      sets.push('definition = ?');
      values.push(updates.definition.trim());
    }
    if (updates.example !== undefined) {
      sets.push('example = ?');
      values.push(updates.example.trim());
    }
    if (updates.deleted_at !== undefined) {
      sets.push('deleted_at = ?');
      values.push(updates.deleted_at);
    }

    const now = Date.now();
    sets.push('updated_at = ?');
    values.push(now);

    values.push(existing.id);

    db.prepare(`UPDATE slang_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getSlangEntry(updates.new_term?.trim() || existing.term, false, true);
  }

  /**
   * 软删除指定黑话词条（保留 7 天后悔期）
   */
  deleteSlangEntry(term: string): boolean {
    const db = this.getDb();
    const existing = this.getSlangEntry(term, false, false);
    if (!existing) return false;
    const now = Date.now();
    const res = db.prepare('UPDATE slang_entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, existing.id);
    return res.changes > 0;
  }

  /**
   * 从回收站复原黑话词条
   */
  restoreSlangEntry(term: string): boolean {
    const db = this.getDb();
    const clean = term.trim();
    const now = Date.now();
    const info = db.prepare(`
      UPDATE slang_entries
      SET deleted_at = NULL, updated_at = ?
      WHERE term = ? AND deleted_at IS NOT NULL
    `).run(now, clean);
    return info.changes > 0;
  }

  /**
   * 物理清理已过 7 天后悔期的黑话词条
   */
  purgeExpiredSlang(graceDays: number = 7): string[] {
    const db = this.getDb();
    const thresholdMs = Date.now() - graceDays * 24 * 3600 * 1000;
    const rows = db.prepare(`
      SELECT term FROM slang_entries
      WHERE deleted_at IS NOT NULL AND deleted_at < ?
    `).all(thresholdMs) as any[];

    if (rows.length > 0) {
      db.prepare(`
        DELETE FROM slang_entries
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
      `).run(thresholdMs);
    }

    return rows.map((r: any) => r.term);
  }

  /**
   * 查询黑话列表（支持按标题、标签、释义、例句关键词模糊反查，支持可选 limit/inTrash）
   */
  querySlangEntries(options: SlangQueryOptions = {}): {
    entries: SlangEntry[];
    total: number;
  } {
    const db = this.getDb();
    const kw = options.keyword?.trim();
    const whereClauses: string[] = [];
    const params: any[] = [];

    if (options.inTrash) {
      whereClauses.push('deleted_at IS NOT NULL');
    } else if (!options.includeDeleted) {
      whereClauses.push('deleted_at IS NULL');
    }

    if (kw) {
      whereClauses.push('(term LIKE ? OR tags LIKE ? OR definition LIKE ? OR example LIKE ?)');
      const like = `%${kw}%`;
      params.push(like, like, like, like);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM slang_entries ${whereClause}`).get(...params);
    const total = totalRow ? totalRow.total : 0;

    let query = `SELECT * FROM slang_entries ${whereClause} ORDER BY updated_at DESC, id DESC`;
    if (options.limit !== undefined && options.limit > 0) {
      query += ` LIMIT ${Number(options.limit)}`;
      if (options.offset !== undefined && options.offset > 0) {
        query += ` OFFSET ${Math.floor(Number(options.offset))}`;
      }
    }

    const rows = db.prepare(query).all(...params);
    return {
      entries: rows.map((r: any) => this.mapSlangRow(r)),
      total,
    };
  }

  /**
   * 获取用于常驻 L1 Prompt 渲染的轻量索引列表（仅限活跃黑话）
   */
  getAllSlangEntriesForContext(): Array<{ term: string; tags: string }> {
    const db = this.getDb();
    const rows = db.prepare('SELECT term, tags FROM slang_entries WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC').all();
    return rows.map((r: any) => ({
      term: r.term,
      tags: r.tags || '',
    }));
  }

  /**
   * 获取黑话总条数（默认仅活跃黑话）
   */
  getSlangCount(includeDeleted = false): number {
    const db = this.getDb();
    const sql = includeDeleted
      ? 'SELECT COUNT(*) as count FROM slang_entries'
      : 'SELECT COUNT(*) as count FROM slang_entries WHERE deleted_at IS NULL';
    const row = db.prepare(sql).get();
    return row ? row.count : 0;
  }

  /**
   * LRU 淘汰策略：软删除淘汰被模型查询次数最少且最久未被查询的词条（进入 7 天后悔期）
   */
  evictSlangEntryLru(): SlangEntry | null {
    const db = this.getDb();
    const candidate = db.prepare(`
      SELECT * FROM slang_entries
      WHERE deleted_at IS NULL
      ORDER BY query_count ASC, COALESCE(last_queried_at, 0) ASC, id ASC
      LIMIT 1
    `).get();

    if (!candidate) return null;
    const now = Date.now();
    db.prepare('UPDATE slang_entries SET deleted_at = ? WHERE id = ?').run(now, candidate.id);
    return this.mapSlangRow({ ...candidate, deleted_at: now });
  }
}
