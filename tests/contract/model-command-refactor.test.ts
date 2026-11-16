import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { handleSlashCommand } from '../../src/commands/index.js';
import { SessionManager } from '../../src/gateway/session.js';

describe('契约测试: /模型 命令重构与新建会话默认模型闭环 (Model Command Refactor Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-model-refactor-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: /模型 [模型名] 仅切换当前单聊会话，不修改新建会话默认模型，不影响其他会话', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
    const sessionB = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

    const defaultBefore = sessionManager.getConfiguredDefaultModel();

    const resA = await handleSlashCommand('/模型 deepseek-v4-pro', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    expect(resA.handled).toBe(true);
    expect(resA.success).toBe(true);
    expect(resA.reply).toContain('当前会话模型已切换为：deepseek-official / deepseek-v4-pro');
    expect(resA.reply).not.toContain('Kujira 全局模型已切换为');
    expect(resA.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    // 会话 A 生效
    expect(sessionManager.getModelSelection(sessionA.id)?.model).toBe('deepseek-v4-pro');
    // 会话 B 不受影响
    expect(sessionManager.getModelSelection(sessionB.id)?.model).not.toBe('deepseek-v4-pro');
    // 默认模型配置未被更改
    expect(sessionManager.getConfiguredDefaultModel()).toEqual(defaultBefore);
  });

  it('契约 2: /模型 [模型名] -默认 切换当前会话并持久化记录为新建会话默认，且不暴力批量改写其他会话', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
    const sessionB = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

    // 先给 sessionB 设定一个特定模型
    sessionManager.setModelSelection(sessionB.id, 'deepseek-official', 'deepseek-v4-flash');

    const resA = await handleSlashCommand('/模型 deepseek-v4-pro -默认', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    expect(resA.handled).toBe(true);
    expect(resA.success).toBe(true);
    expect(resA.reply).toContain('当前会话模型已切换为：deepseek-official / deepseek-v4-pro');
    expect(resA.reply).toContain('已设为新建会话默认模型');
    expect(resA.reply).not.toContain('范围：已同步切换所有单聊会话');

    // 默认模型已持久化为 deepseek-v4-pro
    const configuredDefault = sessionManager.getConfiguredDefaultModel();
    expect(configuredDefault?.provider).toBe('deepseek-official');
    expect(configuredDefault?.model).toBe('deepseek-v4-pro');

    // 当前会话 A 已切为 deepseek-v4-pro
    expect(sessionManager.getModelSelection(sessionA.id)?.model).toBe('deepseek-v4-pro');
    // 会话 B 保持其自身的 flash，没有被暴力批量篡改
    expect(sessionManager.getModelSelection(sessionB.id)?.model).toBe('deepseek-v4-flash');
  });

  it('契约 3: /模型 无参数展示当前会话模型与新建会话默认，彻底移除宿主全局/Kujira 全局等内部噪音，并展示 -默认 切换提示', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);

    // 设置默认模型
    sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'high');

    const res = await handleSlashCommand('/模型', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toContain('当前会话模型：');
    expect(res.reply).toContain('新建会话默认：deepseek-official / deepseek-v4-pro');
    expect(res.reply).not.toContain('Kujira 全局默认：');
    expect(res.reply).not.toContain('宿主全局默认：');
    expect(res.reply).not.toContain('--全局');
    expect(res.reply).not.toMatch(/\s-g(\s|$)/);
    expect(res.reply).toContain('-默认');
    expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('契约 4: 下一次新建会话 (/新建 或清空重置) 时自动应用用户配置的默认模型，且思考等级继承作为 Feature 保持不变', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const hash = 'a1b2c3d4e5f60001';
    const peer = `user_${hash}`;
    const sessionA = booted.ctx.sessions.create(`kujira-user-${hash}` as any);

    // 设置默认模型为 deepseek-v4-pro
    sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'high');

    // 当前旧会话切到 flash，但思考等级设为 low
    sessionManager.setModelSelection(sessionA.id, 'deepseek-official', 'deepseek-v4-flash', 'low');

    // 用户执行 /新建 开启新会话
    const newRes = await handleSlashCommand('/新建', {
      userId: `user_${hash}`,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(newRes.handled).toBe(true);
    expect(newRes.success).toBe(true);

    const nextSid = sessionManager.peerToSessionId(peer);
    expect(nextSid).not.toBe(sessionA.id);

    // 新会话的模型应该自动对齐配置的默认模型 deepseek-v4-pro，而不是继承旧会话的 flash
    const nextSel = sessionManager.getModelSelection(nextSid);
    expect(nextSel?.model).toBe('deepseek-v4-pro');
    // 思考等级继承作为 Feature 保持：继承旧会话设置好的 low
    expect(nextSel?.reasoningEffort).toBe('low');
  });

  it('契约 5: 新建会话时若配置的默认模型已删除或不存在，推送文本 "选择的模型已删除或不存在"，不盲目回退', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const hash = 'a1b2c3d4e5f60002';
    const peer = `user_${hash}`;
    const sessionA = booted.ctx.sessions.create(`kujira-user-${hash}` as any);

    // 配置一个已被删除/不存在的默认模型
    sessionManager.setConfiguredDefaultModel('removed-provider', 'ghost-model-v1', 'high');

    const sentReplies: Array<{ peer: string; text: string }> = [];
    const mockBridge = {
      sendTextReply: vi.fn(async (targetPeer: string, text: string) => {
        sentReplies.push({ peer: targetPeer, text });
        return { ok: true, data: {} };
      }),
      trackInboundContext: vi.fn(),
    };
    sessionManager.setOutboundBridge(mockBridge as any);

    // 执行 /新建 开启新会话
    await handleSlashCommand('/新建', {
      userId: `user_${hash}`,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    // 验证向 QQ 端推送了关于默认模型已删除或不存在的明确通知
    const hasWarnReply = sentReplies.some((r) =>
      r.text.includes('选择的模型已删除或不存在')
    );
    expect(hasWarnReply).toBe(true);
  });
});
