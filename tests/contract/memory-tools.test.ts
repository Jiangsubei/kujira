/**
 * tests/contract/memory-tools.test.ts
 *
 * 契约测试: Memory Agent 工具集 (read_memory, create_memory, edit_memory)
 * - 严格单聊强隔离：'session' 与 'user' 均以当前单聊 user_<hash> 为物理主键；
 * - 工具参数表绝不暴露 peer / user_id / qq，execute 忽略显式传入的跨会话标识；
 * - Fail-Closed：拒绝 default / user_default / web-* / review-* / group_* / qq-group-*。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import {
  MemoryTools,
  createMemoryToolDefinitions,
  normalizeStrictUserPeer,
  resolveContextPeer,
} from '../../src/tools/memory/index.js';

/** 递归检查对象是否包含 undefined 字段 (DSH Lossless JSON 契约) */
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

describe('契约测试: Memory Agent 工具集（单聊强隔离）', () => {
  let tmpDir: string;
  let storage: MemoryStorage;
  let tools: MemoryTools;
  let emitMock: ReturnType<typeof vi.fn>;

  const PEER_A = 'user_a1b2c3d4e5f60718';
  const PEER_B = 'user_b2c3d4e5f6071829';

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-memtools-test-'));
    storage = new MemoryStorage(tmpDir);
    emitMock = vi.fn();
    tools = new MemoryTools(storage, { emit: emitMock } as any);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: read_memory 读取单聊 session 与 user 记忆（不存在返回空串，绝不回退 default）', async () => {
    await storage.writeSessionMemory(PEER_A, '- 互动约定：晚上十点后轻声说话');
    await storage.writeUserProfile(PEER_A, '- 偏好：喜欢 TypeScript 和简短回答');

    // 1. 读已存在 session
    const resSession = await tools.readMemory({ type: 'session' }, PEER_A);
    expect(resSession.success).toBe(true);
    expect(resSession.type).toBe('session');
    expect(resSession.target).toBe(PEER_A);
    expect(resSession.content).toBe('- 互动约定：晚上十点后轻声说话');
    expect(resSession.message).toBe(`成功读取 Session 记忆 (${PEER_A})`);

    // 2. 读已存在 user
    const resUser = await tools.readMemory({ type: 'user' }, PEER_A);
    expect(resUser.success).toBe(true);
    expect(resUser.type).toBe('user');
    expect(resUser.target).toBe(PEER_A);
    expect(resUser.content).toBe('- 偏好：喜欢 TypeScript 和简短回答');
    expect(resUser.message).toBe(`成功读取用户画像 (${PEER_A})`);

    // 3. 读不存在的 session -> 返回 content: ''，不报错，提示使用 create_memory
    const resEmptySession = await tools.readMemory({ type: 'session' }, 'user_not_exist');
    expect(resEmptySession.success).toBe(true);
    expect(resEmptySession.type).toBe('session');
    expect(resEmptySession.target).toBe('user_not_exist');
    expect(resEmptySession.content).toBe('');
    expect(resEmptySession.message).toBe(
      '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。'
    );

    // 4. 读不存在的 user（即使 user/default.md 存在内容，也绝不回退 default）
    await storage.writeUserProfile('default', '禁止泄漏的默认兜底画像');
    await storage.writeSessionMemory('default', '禁止泄漏的默认会话');
    const resEmptyUser = await tools.readMemory({ type: 'user' }, PEER_B);
    expect(resEmptyUser.success).toBe(true);
    expect(resEmptyUser.type).toBe('user');
    expect(resEmptyUser.target).toBe(PEER_B);
    expect(resEmptyUser.content).toBe('');
    expect(resEmptyUser.message).toBe(
      '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。'
    );

    // 5. 验证 read_memory ToolDefinition 的 render 输出
    const toolDefs = createMemoryToolDefinitions(tools);
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const renderFn = (readTool.output as any)?.render;
    expect(typeof renderFn).toBe('function');

    const renderedNotEmpty = renderFn({}, resSession);
    expect(renderedNotEmpty[0].text).toContain(`成功读取 Session 记忆 (${PEER_A})`);
    expect(renderedNotEmpty[0].text).toContain('晚上十点后轻声说话');

    const renderedEmpty = renderFn({}, resEmptySession);
    expect(renderedEmpty[0].text).toContain(
      '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。'
    );
    expect(renderedEmpty[0].text).not.toContain('成功读取');
  });

  it('契约 2: create_memory 首次创建、防覆盖护栏与 memory/change 事件发射', async () => {
    // 1. 创建 user 画像 -> 落盘在 user/<peer>.md 且发射 peer: PEER_A
    const resCreateUser = await tools.createMemory(
      {
        type: 'user',
        content: '- 偏好：日常使用 Windows，喜欢直接给结论',
      },
      PEER_A
    );
    expect(resCreateUser.success).toBe(true);
    expect(resCreateUser.type).toBe('user');
    expect(resCreateUser.target).toBe(PEER_A);
    expect(await storage.readUserProfileRaw(PEER_A)).toBe(
      '- 偏好：日常使用 Windows，喜欢直接给结论'
    );
    expect(emitMock).toHaveBeenCalledWith(
      'memory/change',
      expect.objectContaining({
        type: 'user',
        peer: PEER_A,
        action: 'create',
      })
    );

    // 2. 创建 session 规则 -> 落盘在 session/<peer>.md 且发射 peer: PEER_A
    const resCreateSession = await tools.createMemory(
      {
        type: 'session',
        content: '- 约定：技术讨论用列表呈现',
      },
      PEER_A
    );
    expect(resCreateSession.success).toBe(true);
    expect(resCreateSession.type).toBe('session');
    expect(resCreateSession.target).toBe(PEER_A);
    expect(await storage.readSessionMemoryRaw(PEER_A)).toBe('- 约定：技术讨论用列表呈现');
    expect(emitMock).toHaveBeenCalledWith(
      'memory/change',
      expect.objectContaining({
        type: 'session',
        peer: PEER_A,
        action: 'create',
      })
    );

    // 3. 已存在时防覆盖护栏
    const resDup = await tools.createMemory(
      {
        type: 'user',
        content: '试图覆盖',
      },
      PEER_A
    );
    expect(resDup.success).toBe(false);
    expect(resDup.message).toBe('目标记忆已存在，请使用 edit_memory 修改，不要重复创建。');

    // 4. 空白内容拦截
    const resBlank = await tools.createMemory(
      {
        type: 'session',
        content: '   \n  ',
      },
      PEER_B
    );
    expect(resBlank.success).toBe(false);
    expect(resBlank.message).toBe('创建内容不能为空。');
  });

  it('契约 3: edit_memory 唯一匹配、删除语义、异常校验与并发锁安全', async () => {
    // 1. 不存在时提示 create_memory
    const resMissing = await tools.editMemory(
      {
        type: 'session',
        old_string: '旧内容',
        new_string: '新内容',
      },
      PEER_A
    );
    expect(resMissing.success).toBe(false);
    expect(resMissing.message).toBe('目标记忆不存在，请先 create_memory 创建。');

    await storage.writeSessionMemory(PEER_A, '- 规则 A：早睡早起\n- 规则 B：喝水\n- 重复词：喝水');

    // 2. old_string 找不到
    const resNotFound = await tools.editMemory(
      {
        type: 'session',
        old_string: '不存在的条目',
        new_string: '新内容',
      },
      PEER_A
    );
    expect(resNotFound.success).toBe(false);
    expect(resNotFound.message).toContain('old_string 未在当前记忆中找到');

    // 3. old_string 出现多次
    const resMulti = await tools.editMemory(
      {
        type: 'session',
        old_string: '喝水',
        new_string: '多喝热水',
      },
      PEER_A
    );
    expect(resMulti.success).toBe(false);
    expect(resMulti.message).toContain('old_string 出现 2 次');

    // 4. 唯一替换成功并发射事件
    const resReplace = await tools.editMemory(
      {
        type: 'session',
        old_string: '- 规则 A：早睡早起',
        new_string: '- 规则 A：十一点前休息',
      },
      PEER_A
    );
    expect(resReplace.success).toBe(true);
    expect(emitMock).toHaveBeenCalledWith(
      'memory/change',
      expect.objectContaining({
        type: 'session',
        peer: PEER_A,
        action: 'edit',
      })
    );

    // 5. 省略 new_string 触发删除语义
    const resDelete = await tools.editMemory(
      {
        type: 'session',
        old_string: '\n- 重复词：喝水',
      },
      PEER_A
    );
    expect(resDelete.success).toBe(true);
    expect(await storage.readSessionMemoryRaw(PEER_A)).toBe('- 规则 A：十一点前休息\n- 规则 B：喝水');

    // 6. 并发编辑同一文件不丢写
    await storage.writeUserProfile(PEER_A, '- 项1：旧值1\n- 项2：旧值2');
    const [e1, e2] = await Promise.all([
      tools.editMemory({ type: 'user', old_string: '旧值1', new_string: '新值1' }, PEER_A),
      tools.editMemory({ type: 'user', old_string: '旧值2', new_string: '新值2' }, PEER_A),
    ]);
    expect(e1.success).toBe(true);
    expect(e2.success).toBe(true);
    const merged = await storage.readUserProfileRaw(PEER_A);
    expect(merged).toContain('新值1');
    expect(merged).toContain('新值2');
  });

  it('契约 4: 单聊强隔离 — Schema 绝不暴露 peer/user_id，execute 忽略外部跨会话参数', async () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;

    for (const def of [readTool, createTool, editTool]) {
      const props = (def.parameters as any).properties;
      expect(props.peer).toBeUndefined();
      expect(props.user_id).toBeUndefined();
      expect(props.qq).toBeUndefined();
    }

    const execCtx = {
      agent: {
        session: { id: 'kujira-user-a1b2c3d4e5f60718-r2-1' },
      },
    };

    // 尝试传入恶意 peer / user_id，必须被忽略且仅写入当前上下文 PEER_A
    const createRes = (await createTool.execute(
      {
        type: 'user',
        content: '- 偏好：黑咖啡',
        peer: PEER_B,
        user_id: 'other_user',
      } as any,
      execCtx as any
    )) as any;
    expect(createRes.success).toBe(true);
    expect(createRes.target).toBe(PEER_A);
    expect(await storage.existsUserProfile(PEER_A)).toBe(true);
    expect(await storage.existsUserProfile(PEER_B)).toBe(false);
    expect(await storage.existsUserProfile('other_user')).toBe(false);

    const editRes = (await editTool.execute(
      {
        type: 'user',
        old_string: '黑咖啡',
        new_string: '美式咖啡',
        peer: PEER_B,
      } as any,
      execCtx as any
    )) as any;
    expect(editRes.success).toBe(true);
    expect(editRes.target).toBe(PEER_A);

    const readRes = (await readTool.execute(
      {
        type: 'user',
        peer: PEER_B,
      } as any,
      execCtx as any
    )) as any;
    expect(readRes.success).toBe(true);
    expect(readRes.target).toBe(PEER_A);
    expect(readRes.content).toBe('- 偏好：美式咖啡');
  });

  it('契约 5: Fail-Closed 门禁 — 拒绝 default / web-* / review-* / group_* / qq-group-* 与无上下文调用', async () => {
    expect(normalizeStrictUserPeer('kujira-user-a1b2c3d4e5f60718')).toBe(PEER_A);
    expect(normalizeStrictUserPeer('kujira-user-a1b2c3d4e5f60718-r3-4-deadbeef')).toBe(PEER_A);
    expect(normalizeStrictUserPeer(PEER_A)).toBe(PEER_A);

    expect(normalizeStrictUserPeer('default')).toBeNull();
    expect(normalizeStrictUserPeer('user_default')).toBeNull();
    expect(normalizeStrictUserPeer('web-session-1')).toBeNull();
    expect(normalizeStrictUserPeer('review-default-100')).toBeNull();
    expect(normalizeStrictUserPeer('qq-group-8000000001')).toBeNull();
    expect(normalizeStrictUserPeer('group_8000000001')).toBeNull();
    expect(normalizeStrictUserPeer('')).toBeNull();
    expect(normalizeStrictUserPeer(undefined)).toBeNull();

    expect(resolveContextPeer({ agent: { session: { id: 'kujira-user-a1b2c3d4e5f60718-r1-0' } } })).toBe(
      PEER_A
    );
    expect(resolveContextPeer({ session: { id: 'user_b2c3d4e5f6071829' } })).toBe(PEER_B);
    expect(resolveContextPeer({ agent: { session: { id: 'default' } } })).toBeNull();
    expect(resolveContextPeer({ agent: { session: { id: 'qq-group-8000000001-1' } } })).toBeNull();
    expect(resolveContextPeer({})).toBeNull();

    const toolDefs = createMemoryToolDefinitions(tools);
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;

    for (const badCtx of [
      undefined,
      {},
      { agent: { session: { id: 'default' } } },
      { agent: { session: { id: 'web-main' } } },
      { agent: { session: { id: 'review-default-123' } } },
      { agent: { session: { id: 'qq-group-8000000001' } } },
      { peer: 'group_8000000001' },
    ]) {
      const r1 = (await readTool.execute({ type: 'session' }, badCtx as any)) as any;
      const r2 = (await createTool.execute(
        { type: 'user', content: '不应写入' },
        badCtx as any
      )) as any;
      const r3 = (await editTool.execute(
        { type: 'session', old_string: 'a', new_string: 'b' },
        badCtx as any
      )) as any;
      expect(r1.success).toBe(false);
      expect(r1.message).toContain('禁止跨会话或 default 兜底访问');
      expect(r2.success).toBe(false);
      expect(r2.message).toContain('禁止跨会话或 default 兜底访问');
      expect(r3.success).toBe(false);
      expect(r3.message).toContain('禁止跨会话或 default 兜底访问');
    }

    const defaultExists = await fsp
      .access(storage.getUserProfilePath('default'))
      .then(() => true)
      .catch(() => false);
    expect(defaultExists).toBe(false);
  });

  it('契约 6: getPromptSnapshotSync 无头自动补 ### 标题，已有 # 保留原样，且兼容 kujira-user-<hash>', () => {
    storage.writeSessionMemorySync('user_headless', '互动约定：纯文本约定，无任何标题');
    storage.writeUserProfileSync('user_headless', '偏好：直接看代码');
    expect(storage.getPromptSnapshotSync('user_headless')).toBe(
      '### Session 记忆（user_headless）\n互动约定：纯文本约定，无任何标题\n\n### 用户画像\n偏好：直接看代码'
    );
    expect(storage.getPromptSnapshotSync('kujira-user-headless-r1-2')).toBe(
      '### Session 记忆（user_headless）\n互动约定：纯文本约定，无任何标题\n\n### 用户画像\n偏好：直接看代码'
    );

    storage.writeSessionMemorySync('user_headed', '# 明确自定义标题\n约定：已有大标题');
    storage.writeUserProfileSync('user_headed', '# 自定义画像头\n偏好：猫猫');
    const headedSnapshot = storage.getPromptSnapshotSync('user_headed');
    expect(headedSnapshot).toBe('# 明确自定义标题\n约定：已有大标题\n\n# 自定义画像头\n偏好：猫猫');
    expect(headedSnapshot).not.toContain('### Session 记忆');
    expect(headedSnapshot).not.toContain('### 用户画像');
  });

  it('契约 7: 写入端容量硬上限门禁与动态 limits getter (user <= 2200, session <= 2200)', async () => {
    const resOverUser = await tools.createMemory(
      {
        type: 'user',
        content: 'A'.repeat(2201),
      },
      PEER_A
    );
    expect(resOverUser.success).toBe(false);
    expect(resOverUser.message).toContain('超出上限 (2200 字符)');
    expect(resOverUser.message).toContain('本次创建未写入');
    expect(await storage.existsUserProfile(PEER_A)).toBe(false);

    const resOverSession = await tools.createMemory(
      {
        type: 'session',
        content: 'B'.repeat(2201),
      },
      PEER_A
    );
    expect(resOverSession.success).toBe(false);
    expect(resOverSession.message).toContain('超出上限 (2200 字符)');
    expect(resOverSession.message).toContain('本次创建未写入');
    expect(await storage.existsSessionMemory(PEER_A)).toBe(false);

    const normalUser = await tools.createMemory(
      {
        type: 'user',
        content: '偏好：日常使用 Linux，喜欢简短回答',
      },
      PEER_A
    );
    expect(normalUser.success).toBe(true);

    const resEditOver = await tools.editMemory(
      {
        type: 'user',
        old_string: '喜欢简短回答',
        new_string: 'C'.repeat(2200),
      },
      PEER_A
    );
    expect(resEditOver.success).toBe(false);
    expect(resEditOver.message).toContain('超出上限 (2200 字符)');
    expect(resEditOver.message).toContain('本次编辑未落盘');
    expect(resEditOver.message).toContain('还需再缩减');
    expect(await storage.readUserProfileRaw(PEER_A)).toContain('喜欢简短回答');

    // 动态 limits getter 验证
    let dynamicUserLimit = 100;
    let dynamicSessionLimit = 200;
    const dynamicTools = new MemoryTools(storage, undefined, {
      getUserProfileLimit: () => dynamicUserLimit,
      getSessionLimit: () => dynamicSessionLimit,
    });

    const dynOver = await dynamicTools.createMemory(
      { type: 'user', content: 'X'.repeat(105) },
      'user_dyn_1'
    );
    expect(dynOver.success).toBe(false);
    expect(dynOver.message).toContain('超出上限 (100 字符)');

    dynamicUserLimit = 500;
    const dynOk = await dynamicTools.createMemory(
      { type: 'user', content: 'X'.repeat(105) },
      'user_dyn_1'
    );
    expect(dynOk.success).toBe(true);

    const dynSessionOver = await dynamicTools.createMemory(
      { type: 'session', content: 'Y'.repeat(201) },
      'user_dyn_1'
    );
    expect(dynSessionOver.success).toBe(false);
    expect(dynSessionOver.message).toContain('超出上限 (200 字符)');
  });

  it('契约 8: 工具定义描述包含单聊强隔离、黑话分流与禁流水账约束，且不含群聊与 Markdown 标题', () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;

    for (const def of [createTool, editTool, readTool]) {
      expect(def.description).not.toContain('#');
      expect(def.description).not.toContain('群');
      expect(def.description).toContain('单聊');
    }

    expect(createTool.description).toContain('单行');
    expect(createTool.description).toContain('record_slang');
    expect(createTool.description).toContain('edit_memory');
    expect(createTool.description).toContain('严禁');

    expect(editTool.description).toContain('manage_slang');
    expect(editTool.description).toContain('单行');
    expect(readTool.description).toContain('edit_memory');
    expect(readTool.description).toContain('old_string');
  });

  it('契约 9: DSH Lossless JSON 合规性验证（成功与失败分支绝无 undefined 字段）', async () => {
    const toolDefs = createMemoryToolDefinitions(tools);
    const readTool = toolDefs.find((t) => t.name === 'read_memory')!;
    const createTool = toolDefs.find((t) => t.name === 'create_memory')!;
    const editTool = toolDefs.find((t) => t.name === 'edit_memory')!;

    const execCtx = { session: { id: 'kujira-user-a1b2c3d4e5f60718' } };

    const results = [
      await readTool.execute({ type: 'user' }, execCtx as any),
      await createTool.execute({ type: 'user', content: '- 偏好：绿茶' }, execCtx as any),
      await readTool.execute({ type: 'user' }, execCtx as any),
      await editTool.execute(
        { type: 'user', old_string: '绿茶', new_string: '乌龙茶' },
        execCtx as any
      ),
      await editTool.execute({ type: 'user', old_string: '- 偏好：乌龙茶' }, execCtx as any),
      await createTool.execute({ type: 'session', content: '' }, execCtx as any),
      await readTool.execute({ type: 'session' }, {} as any),
    ];

    for (const res of results) {
      assertNoUndefinedFields(res);
      expect(JSON.stringify(res)).toBe(JSON.stringify(JSON.parse(JSON.stringify(res))));
    }
  });
});
