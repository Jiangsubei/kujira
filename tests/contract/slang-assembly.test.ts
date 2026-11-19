/**
 * tests/contract/slang-assembly.test.ts
 * 契约测试: 黑话系统装配与运行时接线闭环 (Kujira 单聊隔离)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SlangStorage } from '../../src/slang/storage.js';
import { setupSlangService } from '../../src/slang/index.js';
import { setupSnapshotHub } from '../../src/prompt/snapshot.js';
import { registerAgentTools, resetGlobalToolContext } from '../../src/tools/index.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { MediaStorageManager } from '../../src/storage/media.js';
import {
  computeOpenidHash16,
  openidToPeer,
  openidToSessionBaseId,
} from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_HASH = computeOpenidHash16(MOCK_OPENID);
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

function expectLosslessJson(value: unknown, trail = 'root'): void {
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => expectLosslessJson(item, `${trail}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      expect(v, `${trail}.${k} must not be undefined`).not.toBeUndefined();
      expectLosslessJson(v, `${trail}.${k}`);
    }
  }
}

describe('契约测试: 黑话系统装配与运行时接线闭环 (Slang Assembly Contract)', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let mediaManager: MediaStorageManager;
  let registeredTools: Map<string, any>;
  let mockToolsService: any;
  let registeredPrompts: Map<string, any>;
  let mockSystemPrompt: any;
  let mockCtx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-slang-assembly-'));
    db = new MessageDatabase(path.join(tmpDir, 'test.db'));
    db.init();
    mediaManager = new MediaStorageManager({ dshHome: tmpDir, db });

    registeredTools = new Map();
    mockToolsService = {
      register: vi.fn().mockImplementation((def: any) => {
        registeredTools.set(def.name, def);
        return () => {
          registeredTools.delete(def.name);
        };
      }),
      get: (name: string) => registeredTools.get(name),
    };

    registeredPrompts = new Map();
    mockSystemPrompt = {
      context: vi.fn().mockImplementation((opts: any) => {
        registeredPrompts.set(opts.name, opts);
        return () => {
          registeredPrompts.delete(opts.name);
        };
      }),
    };

    mockCtx = {
      get: (name: string) => {
        if (name === 'tools') return mockToolsService;
        if (name === 'systemPrompt') return mockSystemPrompt;
        return undefined;
      },
      on: vi.fn(),
    };
  });

  afterEach(() => {
    resetGlobalToolContext();
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: setupSnapshotHub 配合 setupSlangService 正确注册 kujira:slang (order 45)，非 Kujira 会话 Fail-Closed 隔离、单聊 kujira-user-<hash16> 放行', async () => {
    const service = setupSlangService(mockCtx, {
      db,
      dshHome: tmpDir,
      registerGlobalTools: false,
      registerPromptContext: false,
    });

    const hub = setupSnapshotHub({
      ctx: mockCtx,
      db,
      slangStorage: service.storage,
    });

    const slangProvider = hub.getProvider('kujira:slang');
    expect(slangProvider).toBeDefined();
    expect(slangProvider?.order).toBe(45);

    // 1. 非 Kujira 会话 (Web / Desktop / Review / Default): 严格 Fail-Closed 隔离，绝不注入黑话快照
    for (const nonKujiraSessionId of ['web-session-123', 'desktop-main', 'review-task-1', 'default']) {
      const nonKujiraArgs = {
        agent: { session: { id: nonKujiraSessionId } },
        messages: [{ role: 'user', content: [{ type: 'text', text: '非 Kujira 用户' }] }],
      };
      const res = await hub.handlePreStep(nonKujiraArgs, async () => ({
        kind: 'enter',
        messages: nonKujiraArgs.messages,
      }));
      expect(res.messages).toHaveLength(1);
      expect(slangProvider?.text?.({ agent: { session: { id: nonKujiraSessionId } } })).toBe('');
    }

    // 2. Kujira 单聊会话下，未添加词条时 Prompt 为空，不产生快照
    const kujiraSession = { peer: MOCK_PEER, userId: MOCK_HASH };
    const kujiraAssembleCtx = { agent: { session: { id: `${MOCK_SESSION_ID}-2` } } };
    expect(slangProvider?.provide(kujiraSession, kujiraAssembleCtx)).toBe('');

    // 3. 添加词条后，包含 L1 索引与 query_slang 指引
    await service.storage.recordEntry({
      term: '牢大',
      tags: '科比、坠机调侃',
      definition: '科比梗详细释义',
      example: '想你了牢大',
    });

    const activePrompt = slangProvider?.provide(kujiraSession, kujiraAssembleCtx);
    expect(activePrompt).toContain('黑话与梗知识库 (Slang & Memes)');
    expect(activePrompt).toContain('query_slang');
    expect(activePrompt).toContain('- 牢大：科比、坠机调侃');

    // 非 Kujira 会话在词条存在后仍被 Fail-Closed 彻底拦截
    const webResAfter = await hub.handlePreStep(
      { agent: { session: { id: 'web-session-123' } }, messages: [] },
      async () => ({ kind: 'enter', messages: [] })
    );
    expect(webResAfter.messages).toHaveLength(0);

    // 4. Kujira 单聊会话下 pre-step 正确生成 kujira:slang 独立快照消息，且未变动时不再注入
    const kujiraArgs = {
      agent: { session: { id: MOCK_SESSION_ID } },
      messages: [],
    };
    const kujiraRes = await hub.handlePreStep(kujiraArgs, async () => ({ kind: 'enter', messages: [] }));
    const slangMsg = kujiraRes.messages.find((m: any) => m.source?.kind === 'kujira:slang');
    expect(slangMsg).toBeDefined();
    expect(slangMsg.source.form).toBe('snapshot');

    // 第二轮内容无变动，0 条快照注入
    const kujiraRes2 = await hub.handlePreStep(kujiraArgs, async () => ({ kind: 'enter', messages: [] }));
    expect(kujiraRes2.messages).toHaveLength(0);

    hub.dispose();
    service.dispose();
    expect(hub.getProvider('kujira:slang')).toBeUndefined();
  });

  it('契约 2: registerAgentTools 无条件常驻装配 query_slang、record_slang 与 manage_slang 并可执行', async () => {
    const storage = new SlangStorage(db, 300, 'reject');
    const unregister = registerAgentTools(mockCtx, {
      db,
      mediaManager,
      dshHome: tmpDir,
      slangStorage: storage,
      configGetter: () => ({}),
    });

    const queryTool = registeredTools.get('query_slang');
    const recordTool = registeredTools.get('record_slang');
    const manageTool = registeredTools.get('manage_slang');

    expect(queryTool).toBeDefined();
    expect(recordTool).toBeDefined();
    expect(manageTool).toBeDefined();

    // 验证经注册工具 execute 闭环写入、查询与列表均遵循 Lossless JSON
    const recRes = await recordTool.execute(
      {
        term: '绝绝子',
        tags: '夸张赞叹句式',
        definition: '表示极度赞叹或调侃',
        example: '这顿饭真是绝绝子',
      },
      { agent: { session: { id: MOCK_SESSION_ID } } }
    );
    expectLosslessJson(recRes);
    expect(recRes.success).toBe(true);
    expect(recRes.action).toBe('created');

    const qRes = await queryTool.execute(
      { term: '绝绝子' },
      { agent: { session: { id: MOCK_SESSION_ID } } }
    );
    expectLosslessJson(qRes);
    expect(qRes.success).toBe(true);
    expect(qRes.entry.term).toBe('绝绝子');

    const listRes = await manageTool.execute(
      { action: 'list' },
      { agent: { session: { id: MOCK_SESSION_ID } } }
    );
    expectLosslessJson(listRes);
    expect(listRes.success).toBe(true);
    expect(listRes.total).toBe(1);

    unregister();
    expect(registeredTools.has('query_slang')).toBe(false);
    expect(registeredTools.has('record_slang')).toBe(false);
    expect(registeredTools.has('manage_slang')).toBe(false);
  });
});
