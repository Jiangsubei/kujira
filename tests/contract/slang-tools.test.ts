import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SlangStorage } from '../../src/slang/storage.js';
import { MessageDatabase } from '../../src/storage/database.js';
import {
  createSlangToolDefinitions,
  querySlang,
  recordSlang,
  manageSlang,
} from '../../src/tools/slang/index.js';

describe('Slang Tools Contract Tests', () => {
  let tmpDir: string;
  let testDbPath: string;
  let db: MessageDatabase;
  let storage: SlangStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slang-tools-test-'));
    testDbPath = path.join(tmpDir, 'test_messages.sqlite');
    db = new MessageDatabase(testDbPath);
    storage = new SlangStorage(db, 300, 'reject');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Tool Definitions & Descriptions', () => {
    it('should create exactly 3 tool definitions: query_slang, record_slang, manage_slang', () => {
      const defs = createSlangToolDefinitions(storage);
      expect(defs).toHaveLength(3);
      const names = defs.map((d) => d.name);
      expect(names).toContain('query_slang');
      expect(names).toContain('record_slang');
      expect(names).toContain('manage_slang');
    });

    it('query_slang should have compliant natural language description and required term parameter', () => {
      const defs = createSlangToolDefinitions(storage);
      const queryDef = defs.find((d) => d.name === 'query_slang')!;

      expect(queryDef.description).not.toContain('#');
      expect(queryDef.description).not.toContain('社群');
      expect(queryDef.description).not.toContain('群专属规则');
      expect(queryDef.description).toContain('完整释义与典型使用例句');
      expect(queryDef.description).toContain('联网搜索');

      const params = queryDef.parameters as any;
      expect(params.properties.term).toBeDefined();
      expect(params.required).toContain('term');
    });

    it('record_slang should enforce 4 required parameters: term, tags, definition, example', () => {
      const defs = createSlangToolDefinitions(storage);
      const recordDef = defs.find((d) => d.name === 'record_slang')!;

      expect(recordDef.description).not.toContain('#');
      expect(recordDef.description).not.toContain('社群');
      expect(recordDef.description).not.toContain('群专属规则');
      expect(recordDef.description).toContain('记录并收录跨会话通用的网络梗');
      expect(recordDef.description).toContain('manage_slang');

      const params = recordDef.parameters as any;
      expect(params.properties.term).toBeDefined();
      expect(params.properties.tags).toBeDefined();
      expect(params.properties.definition).toBeDefined();
      expect(params.properties.example).toBeDefined();
      expect(params.properties.aliases).toBeUndefined();

      // 4 个核心参数必填校验
      expect(params.required).toContain('term');
      expect(params.required).toContain('tags');
      expect(params.required).toContain('definition');
      expect(params.required).toContain('example');
      // aliases 已废除
      expect(params.required).not.toContain('aliases');
    });

    it('manage_slang should have compliant natural language description and action enum', () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;

      expect(manageDef.description).not.toContain('#');
      expect(manageDef.description).not.toContain('社群');
      expect(manageDef.description).not.toContain('群专属规则');
      expect(manageDef.description).toContain('全局黑话知识库');
      expect(manageDef.description).toContain('record_slang');

      const params = manageDef.parameters as any;
      expect(params.properties.action).toBeDefined();
      expect(params.required).toContain('action');
      expect(params.properties.action.enum).toEqual(['list', 'edit', 'delete', 'restore']);
      expect(params.properties.term).toBeDefined();
      expect(params.properties.tags).toBeDefined();
      expect(params.properties.aliases).toBeUndefined();
      expect(params.properties.definition).toBeDefined();
      expect(params.properties.example).toBeDefined();
      expect(params.properties.keyword).toBeDefined();
      expect(params.properties.in_trash).toBeDefined();
      expect(params.properties.limit).toBeDefined();
    });
  });

  describe('querySlang Tool Execution', () => {
    beforeEach(async () => {
      await recordSlang(
        {
          term: '开香槟',
          tags: '反转嘲讽',
          definition: '提前庆祝导致翻车被打脸',
          example: '优势很大，但先别急着开香槟',
        },
        storage
      );
    });

    it('should query slang details by primary term and return complete definition and example', async () => {
      const res = await querySlang({ term: '开香槟' }, storage);
      expect(res.success).toBe(true);
      expect(res.entry?.term).toBe('开香槟');
      expect(res.message).toContain('核心释义: 提前庆祝导致翻车被打脸');
      expect(res.message).toContain('典型例句: 优势很大，但先别急着开香槟');
      expect(res.message).toContain('反转嘲讽');
    });

    it('should increment query_count on query', async () => {
      await querySlang({ term: '开香槟' }, storage);
      const res = await querySlang({ term: '开香槟' }, storage);
      expect(res.entry?.query_count).toBe(2);
    });

    it('should return error when term is not found', async () => {
      const res = await querySlang({ term: '未收录的词' }, storage);
      expect(res.success).toBe(false);
      expect(res.error).toContain('未收录词条');
      expect(res.error).toContain('联网搜索');
    });
  });

  describe('recordSlang Tool Execution', () => {
    it('should record new slang entry successfully with 4 required fields', async () => {
      const res = await recordSlang(
        {
          term: '牢大',
          tags: '科比梗',
          definition: '科比调侃用法',
          example: '想你了牢大',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('created');
      expect(res.entry?.term).toBe('牢大');
      expect(res.entry?.tags).toBe('科比梗');
      expect(res.total).toBe(1);
      expect(res.max_entries).toBe(300);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
    });

    it('should fail if any of the 4 required parameters is missing', async () => {
      const missingTags = await recordSlang(
        {
          term: '牢大',
          tags: '',
          definition: '科比调侃用法',
          example: '想你了牢大',
        },
        storage
      );
      expect(missingTags.success).toBe(false);
      expect(missingTags.error).toContain('词条标签（简要概述）不能为空');

      const missingExample = await recordSlang(
        {
          term: '牢大',
          tags: '标签',
          definition: '科比调侃用法',
          example: '',
        },
        storage
      );
      expect(missingExample.success).toBe(false);
      expect(missingExample.error).toContain('典型例句不能为空');
    });

    it('should update existing slang entry when recording same term', async () => {
      await recordSlang(
        { term: '开香槟', tags: '旧标签', definition: '旧释义', example: '旧例句' },
        storage
      );

      const res = await recordSlang(
        { term: '开香槟', tags: '新标签', definition: '提前庆祝半场开翻车', example: '别急着开香槟' },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('updated');
      expect(res.entry?.definition).toBe('提前庆祝半场开翻车');
      expect(res.entry?.tags).toBe('新标签');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].definition).toBe('提前庆祝半场开翻车');
    });

    it('should return error when capacity is exceeded under reject policy', async () => {
      const smallStorage = new SlangStorage(db, 1, 'reject');
      await recordSlang(
        {
          term: '词1',
          tags: '标1',
          definition: '释1',
          example: '例1',
        },
        smallStorage
      );

      const res = await recordSlang(
        {
          term: '词2',
          tags: '标2',
          definition: '释2',
          example: '例2',
        },
        smallStorage
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('条数上限 (1/1)');
    });
  });

  describe('manageSlang Tool Execution', () => {
    beforeEach(async () => {
      await recordSlang({ term: '牢大', tags: '科比', definition: '科比梗', example: '想你了' }, storage);
      await recordSlang({ term: '开香槟', tags: '反转', definition: '提前庆祝', example: '先别开' }, storage);
    });

    it('action=list should return all entries and stats', async () => {
      const res = await manageSlang({ action: 'list' }, storage);
      expect(res.success).toBe(true);
      expect(res.action).toBe('list');
      expect(res.total).toBe(2);
      expect(res.entries).toHaveLength(2);
      expect(res.max_entries).toBe(300);
    });

    it('action=list render function should output complete details of each entry to model', async () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;
      
      const res = await manageSlang({ action: 'list' }, storage);
      const parts = manageDef.output?.render ? (manageDef.output.render as any)({}, res) : [];
      const renderedText = parts[0]?.text || '';
      
      // 验证模型在上下文中能直接看到各词条的标题、标签、释义与例句，而非只有条数统计
      expect(renderedText).toContain('查询到 2 条黑话词条');
      expect(renderedText).toContain('【牢大】');
      expect(renderedText).toContain('标签: 科比');
      expect(renderedText).toContain('释义: 科比梗');
      expect(renderedText).toContain('例句: 想你了');
      expect(renderedText).toContain('【开香槟】');
      expect(renderedText).toContain('标签: 反转');
    });

    it('action=list with limit should restrict returned entries count', async () => {
      const res = await manageSlang({ action: 'list', limit: 1 }, storage);
      expect(res.success).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(res.total).toBe(1); // 本次返回 1 条
      expect(res.total_matched).toBe(2); // 匹配总数 2 条
      expect(res.has_more).toBe(true);
      expect(res.message).toContain('共 2 条黑话词条');
    });

    it('action=list with offset should return the correct page', async () => {
      const res = await manageSlang({ action: 'list', offset: 1, limit: 1 }, storage);
      expect(res.success).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(res.offset).toBe(1);
      expect(res.total).toBe(1);
      expect(res.total_matched).toBe(2);
      expect(res.has_more).toBe(false);
    });

    it('action=list with keyword should filter entries by term, tags or definition', async () => {
      // 1. 按标题搜
      const resByTerm = await manageSlang({ action: 'list', keyword: '香槟' }, storage);
      expect(resByTerm.success).toBe(true);
      expect(resByTerm.entries).toHaveLength(1);
      expect(resByTerm.entries![0].term).toBe('开香槟');

      // 2. 按标签反查
      const resByTag = await manageSlang({ action: 'list', keyword: '反转' }, storage);
      expect(resByTag.success).toBe(true);
      expect(resByTag.entries).toHaveLength(1);
      expect(resByTag.entries![0].term).toBe('开香槟');

      // 3. 按释义反查
      const resByDef = await manageSlang({ action: 'list', keyword: '提前庆祝' }, storage);
      expect(resByDef.success).toBe(true);
      expect(resByDef.entries).toHaveLength(1);
      expect(resByDef.entries![0].term).toBe('开香槟');
    });

    it('action=edit should update term definition, tags, and example', async () => {
      const res = await manageSlang(
        {
          action: 'edit',
          term: '牢大',
          tags: '篮球新标签',
          definition: '更新后的科比调侃梗',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('edit');
      expect(res.entry?.definition).toBe('更新后的科比调侃梗');
      expect(res.entry?.tags).toBe('篮球新标签');
      expect(res.entry?.example).toBe('想你了'); // 原例句保持

      const entries = await storage.getEntries();
      expect(entries.find((e) => e.term === '牢大')?.definition).toBe('更新后的科比调侃梗');
    });

    it('action=edit should fail if term is not found', async () => {
      const res = await manageSlang(
        {
          action: 'edit',
          term: '不存在的词',
          definition: 'xxx',
        },
        storage
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('未找到');
    });

    it('action=delete should remove entry', async () => {
      const res = await manageSlang(
        {
          action: 'delete',
          term: '牢大',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('delete');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].term).toBe('开香槟');
    });

    it('action=delete should fail if term is missing or not found', async () => {
      const res = await manageSlang({ action: 'delete' }, storage);
      expect(res.success).toBe(false);
      expect(res.error).toContain('必须提供目标黑话词条');

      const resNotFound = await manageSlang({ action: 'delete', term: '不存在的词' }, storage);
      expect(resNotFound.success).toBe(false);
      expect(resNotFound.error).toContain('未找到');
    });

    it('action=list with in_trash=true should list entries in 7-day recycle bin', async () => {
      // 1. 删除 '牢大'
      await manageSlang({ action: 'delete', term: '牢大' }, storage);

      // 2. 正常检索：仅返回活跃条目
      const activeList = await manageSlang({ action: 'list' }, storage);
      expect(activeList.entries).toHaveLength(1);
      expect(activeList.entries![0].term).toBe('开香槟');

      // 3. 回收站检索：返回处于 7 天后悔期的条目
      const trashList = await manageSlang({ action: 'list', in_trash: true }, storage);
      expect(trashList.entries).toHaveLength(1);
      expect(trashList.entries![0].term).toBe('牢大');
      expect(trashList.total_matched).toBe(1);

      // 4. 回收站空匹配提示
      const emptyTrashList = await manageSlang({ action: 'list', in_trash: true, keyword: '不匹配' }, storage);
      expect(emptyTrashList.message).toContain('回收站');
    });

    it('action=restore should recover a soft-deleted entry from recycle bin', async () => {
      // 1. 删除 '牢大' 进入回收站
      await manageSlang({ action: 'delete', term: '牢大' }, storage);
      expect(storage.getStats().total).toBe(1);

      // 2. 尝试重复 restore 活跃词条失败
      const failRestoreActive = await manageSlang({ action: 'restore', term: '开香槟' }, storage);
      expect(failRestoreActive.success).toBe(false);
      expect(failRestoreActive.error).toContain('未在回收站中找到');

      // 3. 从回收站成功复原
      const res = await manageSlang({ action: 'restore', term: '牢大' }, storage);
      expect(res.success).toBe(true);
      expect(res.action).toBe('restore');
      expect(res.entry?.term).toBe('牢大');
      expect(storage.getStats().total).toBe(2);

      // 4. 再次在活跃列表中可见
      const activeList = await manageSlang({ action: 'list' }, storage);
      expect(activeList.entries).toHaveLength(2);
    });

    it('record_slang should automatically restore entry if term exists in recycle bin', async () => {
      // 1. 删除 '牢大'
      await manageSlang({ action: 'delete', term: '牢大' }, storage);
      expect(storage.getStats().total).toBe(1);

      // 2. 重新用 record_slang 录入同名词条
      const res = await recordSlang(
        {
          term: '牢大',
          tags: '更新后的标签',
          definition: '更新后的核心释义',
          example: '更新后的典型例句',
        },
        storage
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('created');
      expect(res.entry.tags).toBe('更新后的标签');
      expect(storage.getStats().total).toBe(2);

      // 3. 回收站应为空
      const trashList = await manageSlang({ action: 'list', in_trash: true }, storage);
      expect(trashList.entries).toHaveLength(0);
    });
  });

  describe('DSH Lossless JSON 契约测试 (Lossless JSON Compliance)', () => {
    function assertNoUndefinedFields(obj: unknown, currentPath = ''): void {
      if (obj === undefined) {
        throw new Error(`Found undefined at path: "${currentPath}"`);
      }
      if (obj === null) return;
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => assertNoUndefinedFields(item, `${currentPath}[${idx}]`));
        return;
      }
      if (typeof obj === 'object') {
        for (const key of Object.keys(obj as Record<string, unknown>)) {
          const val = (obj as Record<string, unknown>)[key];
          const nextPath = currentPath ? `${currentPath}.${key}` : key;
          if (val === undefined) {
            throw new Error(`Found undefined field: "${nextPath}"`);
          }
          assertNoUndefinedFields(val, nextPath);
        }
      }
    }

    it('record_slang execute 输出严格符合 DSH Lossless JSON 约束 (递归绝无 undefined)', async () => {
      const defs = createSlangToolDefinitions(storage);
      const recordDef = defs.find((d) => d.name === 'record_slang')!;

      const result = await (recordDef as any).execute({
        term: '猫娘=猫粮',
        tags: '谐音梗、亲密调侃',
        definition: '猫娘与猫粮谐音',
        example: '你是一袋猫粮',
      });

      expect(result.success).toBe(true);
      assertNoUndefinedFields(result);
      // 未触发淘汰时，evicted_term 经过清洗后绝不存在
      expect(Object.prototype.hasOwnProperty.call(result, 'evicted_term')).toBe(false);
      // 无损 JSON 序列化幂等验证
      expect(JSON.stringify(result)).toBe(JSON.stringify(JSON.parse(JSON.stringify(result))));

      const failResult = await (recordDef as any).execute({
        term: '',
        tags: '测试',
        definition: '释义',
        example: '例句',
      });
      expect(failResult.success).toBe(false);
      assertNoUndefinedFields(failResult);
    });

    it('query_slang execute 输出严格符合 DSH Lossless JSON 约束', async () => {
      const defs = createSlangToolDefinitions(storage);
      const queryDef = defs.find((d) => d.name === 'query_slang')!;

      await recordSlang({ term: '牢大', tags: '科比', definition: '梗', example: '例' }, storage);

      // 1. 成功查询
      const resSuccess = await (queryDef as any).execute({ term: '牢大' });
      expect(resSuccess.success).toBe(true);
      assertNoUndefinedFields(resSuccess);

      // 2. 失败查询
      const resFail = await (queryDef as any).execute({ term: '未收录词' });
      expect(resFail.success).toBe(false);
      assertNoUndefinedFields(resFail);
    });

    it('manage_slang execute 输出严格符合 DSH Lossless JSON 约束 (list, edit, delete)', async () => {
      const defs = createSlangToolDefinitions(storage);
      const manageDef = defs.find((d) => d.name === 'manage_slang')!;

      await recordSlang({ term: '开香槟', tags: '梗', definition: '提前庆祝', example: '别急' }, storage);

      // 1. list
      const resList = await (manageDef as any).execute({ action: 'list' });
      expect(resList.success).toBe(true);
      assertNoUndefinedFields(resList);

      // 2. edit
      const resEdit = await (manageDef as any).execute({
        action: 'edit',
        term: '开香槟',
        definition: '提前庆祝结果翻车',
      });
      expect(resEdit.success).toBe(true);
      assertNoUndefinedFields(resEdit);

      // 3. delete 成功与失败
      const resDelOk = await (manageDef as any).execute({ action: 'delete', term: '开香槟' });
      expect(resDelOk.success).toBe(true);
      assertNoUndefinedFields(resDelOk);

      const resDel = await (manageDef as any).execute({ action: 'delete', term: '不存在的词' });
      expect(resDel.success).toBe(false);
      assertNoUndefinedFields(resDel);

      // 4. list (in_trash: true)
      const resTrashList = await (manageDef as any).execute({ action: 'list', in_trash: true });
      expect(resTrashList.success).toBe(true);
      assertNoUndefinedFields(resTrashList);

      // 5. restore 成功与失败
      const resRestore = await (manageDef as any).execute({ action: 'restore', term: '开香槟' });
      expect(resRestore.success).toBe(true);
      assertNoUndefinedFields(resRestore);

      const resRestoreFail = await (manageDef as any).execute({ action: 'restore', term: '开香槟' });
      expect(resRestoreFail.success).toBe(false);
      assertNoUndefinedFields(resRestoreFail);
    });
  });
});
