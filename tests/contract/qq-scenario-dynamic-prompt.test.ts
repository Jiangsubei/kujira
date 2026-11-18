/**
 * 契约测试: QQ 单聊会话专属动态提示词干净度与多通道独立快照边界 (QQ Scenario Clean Contract)
 *
 * 说明：本单模块测试直接基于真实 Cordis Context + @deepseek-ai/dsh-system-prompt + setupSnapshotHub 验证，
 * 不依赖尚未在后续批次改造的 src/index.ts / src/boot.ts 全量插件入口。
 *
 * 验证规则:
 * 1. 契约 1: 在 Kujira 单聊会话 (kujira-user-* / user_*) 下，systemPrompt.contexts 严禁注入 qq_scenario / memory / behavior_persona；
 * 2. 契约 2: 在旧群聊格式 (qq-group-* / group_*) 下，同样不注入 qq_scenario 且 SnapshotManager 严格拦截 0 注入；
 * 3. 契约 3: 在非 Kujira 会话（web-*、review-* 沙箱、空上下文）下，不注入任何通道快照；
 * 4. 契约 4: 校验 setupSnapshotHub 仅在 snapshotManager 上注册 6 个 kujira:* 原子通道，绝不污染 systemPrompt；
 * 5. 契约 5: registerQQScenarioDynamicPrompt 安全兼容（返回 noop disposer 且不产生任何脏注入）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { registerQQScenarioDynamicPrompt } from '../../src/prompt/dynamic.js';
import { setupSnapshotHub, type SnapshotManager } from '../../src/prompt/snapshot.js';
import { MemoryStorage } from '../../src/memory/storage.js';
import { SlangStorage } from '../../src/slang/storage.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

describe('契约测试: Kujira 会话提示词干净度与通道隔离验证 (QQ Scenario Clean Contract)', () => {
  let tmpHome: string;
  let ctx: Context;
  let db: MessageDatabase;
  let slangStorage: SlangStorage;
  let memoryStorage: MemoryStorage;
  let snapshotManager: SnapshotManager;

  const peerA = openidToPeer('MOCK_OPENID_SCENARIO_01');
  const sessionIdA = openidToSessionBaseId('MOCK_OPENID_SCENARIO_01');

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-qq-prompt-'));
    ctx = new Context();
    await (ctx.plugin(SystemPrompt as any, {}) as any);

    db = new MessageDatabase(path.join(tmpHome, 'messages.sqlite'));
    db.init();
    memoryStorage = new MemoryStorage(path.join(tmpHome, 'memory'), tmpHome);
    slangStorage = new SlangStorage(db);

    snapshotManager = setupSnapshotHub({
      ctx,
      db,
      memoryStorage,
      slangStorage,
      getPersona: () => '默认测试人设',
      getBehavior: () => '',
    });
  });

  afterEach(async () => {
    try {
      snapshotManager?.dispose();
    } catch {}
    try {
      db?.close();
    } catch {}
    if (ctx) {
      await (ctx as any).parallel?.('dispose').catch(() => {});
      await (ctx as any).fiber?.dispose?.().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 在 Kujira 单聊会话 (kujira-user-* / user_*) 下，systemPrompt 严禁注入 qq_scenario，且 pre-step 正常放行', async () => {
    const assemblyUser = await ctx.systemPrompt.assemble({
      session: { id: sessionIdA },
    } as any);

    expect(assemblyUser.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();
    const fullPromptText = assemblyUser.contexts.map((c: any) => c.text || '').join('\n');
    expect(fullPromptText).not.toContain('# 如何发送消息');
    expect(fullPromptText).not.toContain('除工具调用外不要输出任何回复文本');

    const assemblyPeerUser = await ctx.systemPrompt.assemble({
      peer: peerA,
    } as any);
    expect(assemblyPeerUser.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();

    // 运行时 pre-step 放行 kujira:* 通道
    const preStepRes = await snapshotManager.handlePreStep(
      { agent: { session: { id: `${sessionIdA}-r1-1` } }, messages: [] },
      async () => ({ kind: 'enter', messages: [] })
    );
    expect(preStepRes.messages.some((m: any) => m.source?.kind === 'kujira:persona')).toBe(true);
    expect(preStepRes.messages.some((m: any) => m.source?.kind === 'kujira:behavior')).toBe(true);
  });

  it('契约 2: 在旧群聊格式 (qq-group-* / group_*) 下，严禁注入 qq_scenario 且 SnapshotManager 阻断 0 注入', async () => {
    const assemblyGroup = await ctx.systemPrompt.assemble({
      session: { id: 'qq-group-1000000001-1' },
    } as any);
    expect(assemblyGroup.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();

    const preStepGroup = await snapshotManager.handlePreStep(
      { agent: { session: { id: 'qq-group-1000000001-1' } }, messages: [] },
      async () => ({ kind: 'enter', messages: [] })
    );
    expect(preStepGroup.messages).toHaveLength(0);

    const preStepLegacyPeer = await snapshotManager.handlePreStep(
      { agent: { session: { id: 'group_1000000001' } }, messages: [] },
      async () => ({ kind: 'enter', messages: [] })
    );
    expect(preStepLegacyPeer.messages).toHaveLength(0);
  });

  it('契约 3: 在非 Kujira 会话（web-*、review-* 沙箱、空上下文）下，严禁注入 qq_scenario 或任何通道快照', async () => {
    const assemblyWeb = await ctx.systemPrompt.assemble({
      session: { id: 'web-session-42' },
    } as any);
    expect(assemblyWeb.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();

    const assemblyReview = await ctx.systemPrompt.assemble({
      session: { id: `review-${peerA}` },
    } as any);
    expect(assemblyReview.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();

    const assemblyEmpty = await ctx.systemPrompt.assemble();
    expect(assemblyEmpty.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();

    for (const id of ['web-session-42', `review-${peerA}`, 'desktop-main', 'default', '']) {
      const res = await snapshotManager.handlePreStep(
        { agent: { session: { id } }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );
      expect(res.messages).toHaveLength(0);
    }
  });

  it('契约 4: 校验提示词上下文中不包含 qq_scenario/memory/behavior_persona 段，6 大原子通道均以 kujira:* 命名', () => {
    const contextMap = (ctx.systemPrompt as any).layers.merge(undefined, (l: any) => l.contexts);
    expect(contextMap.get('napcat:qq_scenario')).toBeUndefined();
    expect(contextMap.get('kujira:qq_scenario')).toBeUndefined();
    expect(contextMap.get('napcat:memory')).toBeUndefined();
    expect(contextMap.get('kujira:memory')).toBeUndefined();
    expect(contextMap.get('napcat:behavior_persona')).toBeUndefined();
    expect(contextMap.get('kujira:behavior_persona')).toBeUndefined();

    expect(snapshotManager.getProvider('kujira:persona')).toBeDefined();
    expect(snapshotManager.getProvider('kujira:behavior')).toBeDefined();
    expect(snapshotManager.getProvider('kujira:session_rules')).toBeDefined();
    expect(snapshotManager.getProvider('kujira:user_profiles')).toBeDefined();
    expect(snapshotManager.getProvider('kujira:slang')).toBeDefined();
    expect(snapshotManager.getProvider('kujira:face_summary')).toBeDefined();
  });

  it('契约 5: registerQQScenarioDynamicPrompt 安全兼容性闭环 (Disposer Contract)', async () => {
    const disposer = registerQQScenarioDynamicPrompt(ctx);
    expect(typeof disposer).toBe('function');

    const asm = await ctx.systemPrompt.assemble({
      session: { id: sessionIdA },
    } as any);
    expect(asm.contexts.find((c: any) => c.name.includes('qq_scenario'))).toBeUndefined();

    disposer();
  });
});
