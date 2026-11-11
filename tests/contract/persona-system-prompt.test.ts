/**
 * tests/contract/persona-system-prompt.test.ts
 * 契约测试: Kujira System Prompt 动态段注入、非空保底与单聊 Markdown 行为准则
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { registerKujiraDynamicPrompt } from '../../src/prompt/dynamic.js';
import { isExplicitNonQQSession } from '../../src/prompt/snapshot.js';
import { DEFAULT_BEHAVIOR, DEFAULT_PERSONA } from '../../src/constants/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

describe('契约测试: System Prompt 动态段注入与非空保底 (System Prompt Context Contract)', () => {
  let ctx: Context;
  const peerA = openidToPeer('MOCK_OPENID_PERSONA_01');
  const sessionIdA = openidToSessionBaseId('MOCK_OPENID_PERSONA_01');

  beforeEach(async () => {
    ctx = new Context();
    await (ctx.plugin(SystemPrompt as any, {}) as any);
  });

  afterEach(async () => {
    if (ctx) {
      await (ctx as any).parallel?.('dispose').catch(() => {});
      await (ctx as any).fiber?.dispose?.().catch(() => {});
    }
  });

  it('契约 1: 人格与行为准则必须注入 kujira:* 动态快照通道而非静态段或全局 context', async () => {
    const customPersona = '你是一个傲娇但热心的单聊助手。';
    const customBehavior = '使用简洁明了的 Markdown 列表回答。';

    const unregister = registerKujiraDynamicPrompt(
      ctx,
      () => customPersona,
      () => customBehavior
    );

    // 1. 断言: 静态段 sections 中不包含 kujira / napcat (保护静态 KV Cache)
    const assembly = await ctx.systemPrompt.assemble();
    const staticSection = assembly.sections.find(
      (s: any) => s.name.includes('kujira') || s.name.includes('napcat')
    );
    expect(staticSection).toBeUndefined();

    // 2. 断言: 全局 systemPrompt.context 不包含 kujira / napcat
    const globalCtx = assembly.contexts.find(
      (c: any) => c.name.includes('kujira') || c.name.includes('napcat')
    );
    expect(globalCtx).toBeUndefined();

    // 3. 断言: 通过 snapshotManager 独立通道注入，且旧 napcat:* 通道不存在
    const manager = (ctx as any).snapshotManager;
    expect(manager).toBeDefined();
    expect(manager.getProvider('napcat:persona')).toBeUndefined();
    expect(manager.getProvider('napcat:behavior')).toBeUndefined();

    const personaText = manager.getProvider('kujira:persona')?.provide(null, {
      session: { id: sessionIdA },
    });
    expect(personaText).toBe('## 人格设定 (Persona)\n\n你是一个傲娇但热心的单聊助手。');

    const behaviorText = manager.getProvider('kujira:behavior')?.provide(null, {
      peer: peerA,
    });
    expect(behaviorText).toContain('## 行为准则 (Behavior Guidelines)');
    expect(behaviorText).toContain('使用简洁明了的 Markdown 列表回答。');
    expect(behaviorText).toContain('记忆工具规则');

    unregister();
  });

  it('契约 2: 独立快照通道空文本保底与 DEFAULT_BEHAVIOR Markdown 规范', async () => {
    const unregister = registerKujiraDynamicPrompt(
      ctx,
      () => '',
      () => ''
    );

    const manager = (ctx as any).snapshotManager;
    expect(manager).toBeDefined();

    const personaText = manager.getProvider('kujira:persona')?.provide(null, {});
    expect(personaText).toContain(DEFAULT_PERSONA);

    const behaviorText = manager.getProvider('kujira:behavior')?.provide(null, {});
    expect(behaviorText.length).toBeGreaterThan(0);
    expect(behaviorText).toContain(DEFAULT_BEHAVIOR);
    // Kujira 单聊支持原生 Markdown (msg_type=2)
    expect(behaviorText).toContain('Markdown');
    expect(behaviorText).not.toContain('严禁使用 Markdown');

    unregister();
  });

  it('契约 3: 非 Kujira 会话（Web UI / 旧群聊）触发 persona/behavior 通道时静默返回空串', async () => {
    const unregister = registerKujiraDynamicPrompt(
      ctx,
      () => '自定义人设',
      () => '自定义准则'
    );

    const manager = (ctx as any).snapshotManager;
    expect(isExplicitNonQQSession({ session: { id: 'web-session-01' } })).toBe(true);
    expect(manager.getProvider('kujira:persona')?.provide(null, { session: { id: 'web-session-01' } })).toBe('');
    expect(manager.getProvider('kujira:behavior')?.provide(null, { session: { id: 'qq-group-1000000001' } })).toBe('');
    expect(manager.getProvider('kujira:persona')?.provide(null, { session: { id: sessionIdA } })).toContain('自定义人设');

    unregister();
  });
});
