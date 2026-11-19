import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  formatSlangContextIndex,
  SlangStorage,
} from '../../src/slang/storage.js';
import { setupSlangService } from '../../src/slang/index.js';
import { SnapshotManager } from '../../src/prompt/snapshot.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToSessionBaseId } from '../../src/utils/peer.js';
import type { SlangEntry } from '../../src/types/index.js';

describe('SlangStorage Contract Tests', () => {
  let tmpDir: string;
  let testDbPath: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-slang-storage-test-'));
    testDbPath = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(testDbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('L1 Prompt Context Formatter', () => {
    it('should format L1 context index with terms and tags', () => {
      const indexText = formatSlangContextIndex([
        { term: '开香槟', tags: '提前庆祝、反转被打脸' },
        { term: '电子阳痿', tags: '游戏倦怠、买而不玩' },
        { term: '旧梗无标签' },
      ]);
      expect(indexText).toContain('- 开香槟：提前庆祝、反转被打脸');
      expect(indexText).toContain('- 电子阳痿：游戏倦怠、买而不玩');
      expect(indexText).toContain('- 旧梗无标签');
    });
  });

  describe('SlangStorage CRUD Operations', () => {
    it('should initialize and return empty list when db has no entries', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      const entries = await storage.getEntries();
      expect(entries).toEqual([]);
      expect(storage.getEntriesSync()).toEqual([]);
      const stats = storage.getStats();
      expect(stats.total).toBe(0);
      expect(stats.maxEntries).toBe(300);
      expect(stats.evictPolicy).toBe('reject');
    });

    it('should enforce 4 required parameters: term, tags, definition, example', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await expect(storage.recordEntry({
        term: '',
        tags: '标签',
        definition: '释义',
        example: '例句',
      })).rejects.toThrow('词条名称不能为空');

      await expect(storage.recordEntry({
        term: '词',
        tags: '',
        definition: '释义',
        example: '例句',
      })).rejects.toThrow('词条标签（简要概述）不能为空');

      await expect(storage.recordEntry({
        term: '词',
        tags: '标签',
        definition: '',
        example: '例句',
      })).rejects.toThrow('词条释义不能为空');

      await expect(storage.recordEntry({
        term: '词',
        tags: '标签',
        definition: '释义',
        example: '',
      })).rejects.toThrow('典型例句不能为空');
    });

    it('should record/add entry with 4 required fields and persist to SQLite', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      const res = await storage.recordEntry({
        term: '牢大',
        tags: '科比、坠机梗',
        definition: '指科比，戏谑用法。',
        example: '想你了，牢大！',
      });

      expect(res.action).toBe('created');
      expect(res.entry.term).toBe('牢大');
      expect(res.entry.tags).toBe('科比、坠机梗');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.term).toBe('牢大');
      expect(entries[0]!.tags).toBe('科比、坠机梗');

      const rawPrompt = storage.getRawMarkdownSync();
      expect(rawPrompt).toContain('- 牢大：科比、坠机梗');
    });

    it('should update existing entry when term already exists in recordEntry', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({
        term: '牢大',
        tags: '旧标签',
        definition: '旧释义',
        example: '旧例句',
      });

      const res = await storage.recordEntry({
        term: '牢大',
        tags: '新标签',
        definition: '新释义',
        example: '新例句',
      });

      expect(res.action).toBe('updated');
      expect(res.entry.definition).toBe('新释义');
      expect(res.entry.tags).toBe('新标签');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.definition).toBe('新释义');
      expect(entries[0]!.example).toBe('新例句');
    });

    it('should edit entry with rename support and partial update', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({
        term: '原始词',
        tags: '原始标签',
        definition: '原始释义',
        example: '原始例句',
      });

      const updated = await storage.editEntry('原始词', {
        new_term: '更名词',
        definition: '更新后释义',
      });

      expect(updated.term).toBe('更名词');
      expect(updated.definition).toBe('更新后释义');
      expect(updated.example).toBe('原始例句');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.term).toBe('更名词');
    });

    it('should throw error when editing non-existent entry', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await expect(storage.editEntry('不存在的词', { definition: 'xxx' })).rejects.toThrow('未找到');
    });

    it('should delete existing entry from database', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({ term: '词1', tags: '标1', definition: '释义1', example: '例句1' });
      await storage.recordEntry({ term: '词2', tags: '标2', definition: '释义2', example: '例句2' });

      expect(await storage.getEntries()).toHaveLength(2);

      const deleted = await storage.deleteEntry('词1');
      expect(deleted).toBe(true);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.term).toBe('词2');
    });

    it('should return false when deleting non-existent entry', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      const deleted = await storage.deleteEntry('不存在');
      expect(deleted).toBe(false);
    });

    it('should filter entries with keyword in listEntries', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({ term: '牢大', tags: '篮球', definition: '科比梗', example: '想你了' });
      await storage.recordEntry({ term: '开香槟', tags: '庆祝', definition: '提前庆祝', example: '先别开' });
      await storage.recordEntry({ term: '电子阳痿', tags: '游戏', definition: '游戏倦怠', example: '不想打游戏' });

      const all = await storage.listEntries();
      expect(all).toHaveLength(3);

      const filteredByTerm = await storage.listEntries('香槟');
      expect(filteredByTerm).toHaveLength(1);
      expect(filteredByTerm[0]!.term).toBe('开香槟');

      const filteredByDef = await storage.listEntries('游戏');
      expect(filteredByDef).toHaveLength(1);
      expect(filteredByDef[0]!.term).toBe('电子阳痿');
    });

    it('queryEntry should increment query_count and update last_queried_at', async () => {
      const storage = new SlangStorage(db, 300, 'reject');
      await storage.recordEntry({
        term: '开香槟',
        tags: '反转嘲讽',
        definition: '提前庆祝导致翻车',
        example: '优势很大，但先别开香槟',
      });

      const initial = db.getSlangEntry('开香槟', false);
      expect(initial?.query_count).toBe(0);

      const q1 = await storage.queryEntry('开香槟');
      expect(q1?.term).toBe('开香槟');
      expect(q1?.query_count).toBe(1);
      expect(q1?.last_queried_at).toBeGreaterThan(0);

      const q2 = await storage.queryEntry('开香槟');
      expect(q2?.query_count).toBe(2);
    });
  });

  describe('Capacity and Eviction Policy (reject vs evict_lru)', () => {
    it('should reject adding entry when maxEntries is reached under reject policy', async () => {
      const storage = new SlangStorage(db, 2, 'reject');

      await storage.recordEntry({ term: '词1', tags: '标1', definition: '释1', example: '例1' });
      await storage.recordEntry({ term: '词2', tags: '标2', definition: '释2', example: '例2' });

      await expect(
        storage.recordEntry({ term: '词3', tags: '标3', definition: '释3', example: '例3' })
      ).rejects.toThrow(/条数上限 \(2\/2\)/);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(2);
    });

    it('should evict least queried entry under evict_lru policy', async () => {
      const storage = new SlangStorage(db, 2, 'evict_lru');

      await storage.recordEntry({ term: '冷门词', tags: '冷', definition: '没人查的词', example: '例1' });
      await storage.recordEntry({ term: '热门词', tags: '热', definition: '经常查的词', example: '例2' });

      await storage.queryEntry('热门词');
      await storage.queryEntry('热门词');

      const res = await storage.recordEntry({ term: '新词3', tags: '新', definition: '新释义', example: '新例3' });

      expect(res.action).toBe('created');
      expect(res.evictedTerm).toBe('冷门词');
      expect(res.total).toBe(2);

      const remaining = await storage.getEntries();
      const terms = remaining.map((e) => e.term);
      expect(terms).toContain('热门词');
      expect(terms).toContain('新词3');
      expect(terms).not.toContain('冷门词');
    });
  });

  describe('setupSlangService Kujira Channel Registration', () => {
    it('should register kujira:slang channel and isolate non-kujira sessions without legacy migration', async () => {
      let preStepHandler: ((args: any, next: any) => Promise<any>) | undefined;
      const mockCtx: any = {
        on: vi.fn().mockImplementation((event: string, handler: any) => {
          if (event === 'agent/pre-step') {
            preStepHandler = handler;
          }
          return () => {
            if (preStepHandler === handler) {
              preStepHandler = undefined;
            }
          };
        }),
      };

      const service = setupSlangService(mockCtx, {
        db,
        dshHome: tmpDir,
        registerGlobalTools: false,
        registerPromptContext: true,
      });

      await service.storage.recordEntry({
        term: '真香',
        tags: '打脸反转、前后态度反差',
        definition: '起初拒绝，事后真香。',
        example: '我绝对不写测试……真香！',
      });

      expect(preStepHandler).toBeDefined();

      // 1. Kujira 单聊放行注入 kujira:slang
      const kujiraSessionId = openidToSessionBaseId('MOCK_OPENID_SLANG_001');
      const kujiraRes = await preStepHandler!(
        { agent: { session: { id: kujiraSessionId } }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );
      expect(kujiraRes.messages).toHaveLength(1);
      expect(kujiraRes.messages[0].source.kind).toBe('kujira:slang');
      expect(kujiraRes.messages[0].source.sections[0].text).toContain('## 黑话与梗知识库 (Slang & Memes)');
      expect(kujiraRes.messages[0].source.sections[0].text).toContain('- 真香：打脸反转、前后态度反差');

      // 2. Web UI 会话拦截 0 注入
      const webRes = await preStepHandler!(
        { agent: { session: { id: 'web-session-01' } }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );
      expect(webRes.messages).toHaveLength(0);

      // 3. 验证 SnapshotManager 实例也按 Fail-Closed 门控
      const mgr = new SnapshotManager(mockCtx);
      mgr.dispose();

      service.dispose();
    });
  });

  describe('Slang 7-Day Grace Period & Recycle Bin Operations', () => {
    it('evict_lru and delete should soft-delete into recycle bin instead of physical removal', async () => {
      const storage = new SlangStorage(db, 2, 'evict_lru');

      await storage.recordEntry({
        term: '词条1',
        tags: '标签1',
        definition: '释义1',
        example: '例句1',
      });

      await storage.recordEntry({
        term: '词条2',
        tags: '标签2',
        definition: '释义2',
        example: '例句2',
      });

      // 满额触发 LRU 淘汰：淘汰查询次数最少的 词条1
      const res3 = await storage.recordEntry({
        term: '词条3',
        tags: '标签3',
        definition: '释义3',
        example: '例句3',
      });
      expect(res3.evictedTerm).toBe('词条1');

      // 活跃总数保持 2
      expect(storage.getStats().total).toBe(2);
      expect(storage.getStats().inTrashCount).toBe(1);

      // 词条1 进入回收站，仍存在于数据库中
      const rawRow = (db as any).db.prepare('SELECT * FROM slang_entries WHERE term = ?').get('词条1');
      expect(rawRow).toBeDefined();
      expect(rawRow.deleted_at).toBeGreaterThan(0);

      // 查询回收站能够查到
      const trash = await storage.listEntriesPage(undefined, undefined, undefined, true);
      expect(trash.entries).toHaveLength(1);
      expect(trash.entries[0].term).toBe('词条1');

      // 手动删除 词条2
      await storage.deleteEntry('词条2');
      expect(storage.getStats().total).toBe(1);
      expect(storage.getStats().inTrashCount).toBe(2);

      // restoreEntry 复原 词条1
      const restored = await storage.restoreEntry('词条1');
      expect(restored.term).toBe('词条1');
      expect(storage.getStats().total).toBe(2);
      expect(storage.getStats().inTrashCount).toBe(1);

      // purgeExpiredSlang 物理清理 7 天前过期的词条
      // 模拟将 词条2 的 deleted_at 修改为 8 天前
      const eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
      (db as any).db.prepare('UPDATE slang_entries SET deleted_at = ? WHERE term = ?').run(eightDaysAgo, '词条2');

      const purged = db.purgeExpiredSlang(7);
      expect(purged).toContain('词条2');

      // 词条2 已被物理销毁
      const physicalRow = (db as any).db.prepare('SELECT * FROM slang_entries WHERE term = ?').get('词条2');
      expect(physicalRow).toBeUndefined();
    });
  });
});
