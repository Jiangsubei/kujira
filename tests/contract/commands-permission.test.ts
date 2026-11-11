import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { isSlashCommand, handleSlashCommand } from '../../src/commands/index.js';
import { SessionManager } from '../../src/gateway/session.js';

describe('契约测试: Kujira 单聊两字中文斜杠命令与无 admins 开放指令契约 (Commands Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-cmd-'));
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

  it('契约 1: isSlashCommand 识别半角/全角斜杠命令，单聊任意用户可执行全部指令（已移除 admins 白名单）', async () => {
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);

    expect(isSlashCommand('你好小助手')).toBe(false);
    expect(isSlashCommand('/权限 编辑')).toBe(true);
    expect(isSlashCommand('/模型 deepseek-v4-flash')).toBe(true);
    expect(isSlashCommand('／状态')).toBe(true);

    const friendARes = await handleSlashCommand('/权限 编辑', {
      userId: 'user_a1b2c3d4e5f60001',
      session,
      ctx: booted.ctx,
    });
    expect(friendARes.handled).toBe(true);
    expect(friendARes.success).toBe(true);

    const fullWidthRes = await handleSlashCommand('／权限 只读', {
      userId: 'user_a1b2c3d4e5f60002',
      session,
      ctx: booted.ctx,
    });
    expect(fullWidthRes.handled).toBe(true);
    expect(fullWidthRes.success).toBe(true);

    const friendBRes = await handleSlashCommand('/权限 完全', {
      userId: 'user_deadbeef12345678',
      session,
      ctx: booted.ctx,
    });
    expect(friendBRes.handled).toBe(true);
    expect(friendBRes.success).toBe(true);
    expect(friendBRes.reply).toBe('权限模式已切换为：完全');
  });

  it('契约 2: /权限 命令仅支持中文参数（只读/编辑/完全），无参展示当前模式，严格按单聊会话隔离', async () => {
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
    const sessionB = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

    const resA = await handleSlashCommand('/权限 完全', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
    });
    expect(resA.success).toBe(true);
    expect(resA.reply).toBe('权限模式已切换为：完全');

    const resB = await handleSlashCommand('/权限 编辑', {
      userId: 'user_a1b2c3d4e5f60002',
      session: sessionB,
      ctx: booted.ctx,
    });
    expect(resB.success).toBe(true);
    expect(resB.reply).toBe('权限模式已切换为：编辑');

    const presetsSvc = booted.ctx.permissionPresets;
    expect(presetsSvc.current(sessionA)).toBe('danger-full-access');
    expect(presetsSvc.current(sessionB)).toBe('workspace-write');

    const queryA = await handleSlashCommand('/权限', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
    });
    expect(queryA.reply).toBe('当前权限模式：完全');

    const queryB = await handleSlashCommand('/权限', {
      userId: 'user_a1b2c3d4e5f60002',
      session: sessionB,
      ctx: booted.ctx,
    });
    expect(queryB.reply).toBe('当前权限模式：编辑');

    const invalidRes = await handleSlashCommand('/权限 yolo', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
    });
    expect(invalidRes.success).toBe(false);
    expect(invalidRes.error).toContain('无效的权限模式：yolo');
    expect(invalidRes.error).toContain('可用模式：只读、编辑、完全');
  });

  it('契约 3: /模型 普通命令仅落位当前 Kujira 单聊会话，无 emoji，不污染 Web UI 宿主全局默认', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
    const sessionB = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

    const hostDefaultBefore = (booted.ctx as any).agentDefaultModel?.currentSelection?.();

    const resA = await handleSlashCommand('/模型 deepseek-v4-pro', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resA.handled).toBe(true);
    expect(resA.success).toBe(true);
    expect(resA.reply).toContain('当前会话模型已切换为：deepseek-official / deepseek-v4-pro');
    expect(resA.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    const selA = sessionManager.getModelSelection(sessionA.id);
    expect(selA?.provider).toBe('deepseek-official');
    expect(selA?.model).toBe('deepseek-v4-pro');

    const selB = sessionManager.getModelSelection(sessionB.id);
    expect(selB?.model).not.toBe('deepseek-v4-pro');

    const hostDefaultAfter = (booted.ctx as any).agentDefaultModel?.currentSelection?.();
    if (hostDefaultBefore) {
      expect(hostDefaultAfter).toEqual(hostDefaultBefore);
    }
  });

  it('契约 3b: /模型 支持 -g 与 --全局 参数切换 Kujira 全局默认模型', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
    const sessionB = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

    const resGlobal = await handleSlashCommand('/模型 deepseek-v4-pro --全局', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resGlobal.handled).toBe(true);
    expect(resGlobal.success).toBe(true);
    expect(resGlobal.reply).toContain('Kujira 全局模型已切换为：deepseek-official / deepseek-v4-pro');
    expect(resGlobal.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    expect(sessionManager.getModelSelection(sessionA.id)?.model).toBe('deepseek-v4-pro');
    expect(sessionManager.getModelSelection(sessionB.id)?.model).toBe('deepseek-v4-pro');

    const resPrefix = await handleSlashCommand('/模型 -g deepseek-v4-flash', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resPrefix.success).toBe(true);
    expect(sessionManager.getModelSelection(sessionA.id)?.model).toBe('deepseek-v4-flash');
    expect(sessionManager.getModelSelection(sessionB.id)?.model).toBe('deepseek-v4-flash');
  });

  it('契约 3c: /模型 空参数查询呈现当前会话模型、Kujira 全局默认及帮助说明，无 emoji', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);

    const res = await handleSlashCommand('/模型', {
      userId: 'user_a1b2c3d4e5f60001',
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });

    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toContain('当前会话模型：');
    expect(res.reply).toContain('Kujira 全局默认：');
    expect(res.reply).toContain('可用模型列表：');
    expect(res.reply).toContain('--全局');
    expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('契约 4: /新建 开启全新单聊会话且保留历史归档', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const hash = 'a1b2c3d4e5f60001';
    const peer = `user_${hash}`;
    const sessionA = booted.ctx.sessions.create(`kujira-user-${hash}` as any);

    expect(sessionManager.peerToSessionId(peer)).toBe(`kujira-user-${hash}`);

    const res = await handleSlashCommand('/新建', {
      userId: peer,
      session: sessionA,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toBe('已开启新会话（原会话已保留归档，新消息将计入新会话）。');
    expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    expect(sessionManager.peerToSessionId(peer)).toBe(`kujira-user-${hash}-2`);
  });

  it('契约 5: /停止 命令停止当前生成，回复无 emoji', async () => {
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);

    let cancelCalledWith: any = null;
    const mockController = {
      cancel: async (req: any) => {
        cancelCalledWith = req;
        return { accepted: true };
      },
    };
    (booted.ctx as any).provide('sessionController', mockController);

    const res = await handleSlashCommand('/停止', {
      userId: 'user_a1b2c3d4e5f60001',
      session,
      ctx: booted.ctx,
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.reply).toBe('已停止当前生成。');
    expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    expect(cancelCalledWith).toEqual({ sessionId: session.id });
  });

  it('契约 6: 不再响应旧英文命令（如 /help, /model, /clear 等均报未知指令）', async () => {
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);

    const oldCommands = ['/help', '/model', '/clear', '/new', '/stop', '/ctx', '/mode', '/think', '/resume'];
    for (const cmd of oldCommands) {
      const res = await handleSlashCommand(cmd, {
        userId: 'user_a1b2c3d4e5f60001',
        session,
        ctx: booted.ctx,
      });
      expect(res.handled).toBe(true);
      expect(res.success).toBe(false);
      expect(res.error).toContain(`未知指令：${cmd}，输入 /帮助 查看可用指令`);
    }
  });

  it('契约 7: /会话 命令无参列出单聊历史会话，支持序号或标题切换，无 emoji', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const hash = 'a1b2c3d4e5f60003';
    const peer = `user_${hash}`;

    const a1 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a1.session);
    sessionManager.markSessionCleared(peer);
    const a2 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a2.session);
    sessionManager.markSessionCleared(peer);
    const a3 = await sessionManager.getOrCreateAgent(peer);
    await booted.ctx.sessions.flush(a3.session);
    const s1 = a1.session;
    const s3 = a3.session;

    sessionManager.setPeerName(peer, '阿鲸');

    const listRes = await handleSlashCommand('/会话', {
      userId: peer,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(listRes.handled).toBe(true);
    expect(listRes.success).toBe(true);
    expect(listRes.reply).toContain('历史会话列表');
    expect(listRes.reply).toContain(`kujira-user-${hash}-3`);
    expect(listRes.reply).toContain(`kujira-user-${hash}`);
    expect(listRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    const resume1Res = await handleSlashCommand('/会话 1', {
      userId: peer,
      session: s3,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resume1Res.success).toBe(true);
    expect(resume1Res.reply).toContain('已切换到会话：');
    expect(resume1Res.reply).toContain(`kujira-user-${hash}`);
    expect(sessionManager.peerToSessionId(peer)).toBe(`kujira-user-${hash}`);

    const resumeTitleRes = await handleSlashCommand('/会话 #2', {
      userId: peer,
      session: s1,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(resumeTitleRes.success).toBe(true);
    expect(resumeTitleRes.reply).toContain(`kujira-user-${hash}-2`);
    expect(sessionManager.peerToSessionId(peer)).toBe(`kujira-user-${hash}-2`);
  });

  it('契约 8: /用量 命令测量上下文用量明细，无 emoji', async () => {
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60004' as any);

    const tokenMeter = booted.ctx.get('tokenMeter') || (booted.ctx as any).tokenMeter;
    const originalMeasure = tokenMeter?.measure;
    if (tokenMeter) {
      tokenMeter.measure = () => ({
        totalTokens: 250000,
        surfaceTokens: 113000,
      });
    }

    const sessionProjections = booted.ctx.get('sessionProjections') || (booted.ctx as any).sessionProjections;
    const originalSnapshot = sessionProjections?.snapshot;
    if (sessionProjections) {
      sessionProjections.snapshot = () => ({
        asOfSeq: 1,
        values: {
          contextPressure: { contextWindow: 1000000 },
          contextBreakdown: {
            systemTokens: 1700,
            toolsTokens: 17000,
            messageTokens: 113000,
          },
        },
      });
    }

    try {
      const res = await handleSlashCommand('/用量', {
        userId: 'user_a1b2c3d4e5f60004',
        session,
        ctx: booted.ctx,
      });
      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      expect(res.reply).toContain('上下文已用：~250K / 1M (25%)');
      expect(res.reply).toContain('系统提示词：~1.7K');
      expect(res.reply).toContain('工具声明：~17K');
      expect(res.reply).toContain('对话消息：~113K');
      expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    } finally {
      if (tokenMeter && originalMeasure) tokenMeter.measure = originalMeasure;
      if (sessionProjections && originalSnapshot) sessionProjections.snapshot = originalSnapshot;
    }
  });

  it('契约 9: /帮助 命令输出全部两字中文指令，无 emoji', async () => {
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60005' as any);

    const res = await handleSlashCommand('/帮助', {
      userId: 'user_a1b2c3d4e5f60005',
      session,
      ctx: booted.ctx,
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    const reply = res.reply!;
    expect(reply).toContain('【快捷指令帮助】');
    expect(reply).toContain('/状态');
    expect(reply).toContain('/模型');
    expect(reply).toContain('/权限');
    expect(reply).toContain('/思考');
    expect(reply).toContain('/会话');
    expect(reply).toContain('/新建');
    expect(reply).toContain('/用量');
    expect(reply).toContain('/压缩');
    expect(reply).toContain('/停止');
    expect(reply).toContain('/帮助');
    expect(reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('契约 10: /思考 命令保留英文档位参数方便输入，无 emoji', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60010' as any);

    const queryRes = await handleSlashCommand('/思考', {
      userId: 'user_a1b2c3d4e5f60010',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(queryRes.success).toBe(true);
    expect(queryRes.reply).toContain('当前思考强度：');
    expect(queryRes.reply).toContain('支持的思考档位：');
    expect(queryRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    const setRes = await handleSlashCommand('/思考 max', {
      userId: 'user_a1b2c3d4e5f60010',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(setRes.success).toBe(true);
    expect(setRes.reply).toContain('当前会话思考深度已切换为：max (Max)');
    expect(setRes.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    const globalRes = await handleSlashCommand('/思考 low --全局', {
      userId: 'user_a1b2c3d4e5f60010',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(globalRes.success).toBe(true);
    expect(globalRes.reply).toContain('Kujira 全局思考深度已切换为：low (Low)');
  });

  it('契约 11: /状态 命令汇总网关连接状态、模型、思考等级、权限模式、上下文用量及运行状态', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60020' as any);

    sessionManager.setModelSelection(session.id, 'deepseek-official', 'deepseek-v4-pro', 'high');
    booted.ctx.permissionPresets.set(session, 'danger-full-access');

    let gatewayConnected = true;
    (booted.ctx as any).provide('kujira-gateway', {
      getStatus: () =>
        gatewayConnected
          ? { connected: true, ready: true, botId: '1000000001', botName: 'KujiraBot', reconnectAttempts: 0 }
          : { connected: false, ready: false, reconnectAttempts: 2 },
    });

    const idleRes = await handleSlashCommand('/状态', {
      userId: 'user_a1b2c3d4e5f60020',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(idleRes.handled).toBe(true);
    expect(idleRes.success).toBe(true);
    const idleReply = idleRes.reply!;
    expect(idleReply).toContain('【当前会话状态】');
    expect(idleReply).toContain('网关状态：已连接 (KujiraBot (1000000001))');
    expect(idleReply).toContain('运行状态：空闲');
    expect(idleReply).toContain('当前模型：deepseek-official / deepseek-v4-pro');
    expect(idleReply).toContain('思考等级：high');
    expect(idleReply).toContain('权限模式：完全');
    expect(idleReply).toContain('上下文用量：');
    expect(idleReply).toContain('会话标识：kujira-user-a1b2c3d4e5f60020 (版本: 1)');
    expect(idleReply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);

    gatewayConnected = false;
    const mockOutbound = {
      getActiveTurn: (_peer: string) => 3,
    };
    (sessionManager as any).setOutboundBridge?.(mockOutbound);

    const busyRes = await handleSlashCommand('/状态', {
      userId: 'user_a1b2c3d4e5f60020',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(busyRes.success).toBe(true);
    expect(busyRes.reply).toContain('网关状态：未连接 (重连尝试 2)');
    expect(busyRes.reply).toContain('运行状态：正在运行（轮次 #3）');
  });

  it('契约 12: /模型 优化：唯一模型 ID 智能匹配、空格多词匹配及供应商显式指定', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60030' as any);

    const res1 = await handleSlashCommand('/模型 deepseek-v4-flash', {
      userId: 'user_a1b2c3d4e5f60030',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res1.success).toBe(true);
    expect(sessionManager.getModelSelection(session.id)?.provider).toBe('deepseek-official');
    expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-v4-flash');

    const res2 = await handleSlashCommand('/模型 deepseek flash', {
      userId: 'user_a1b2c3d4e5f60030',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res2.success).toBe(true);
    expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-flash');

    const res3 = await handleSlashCommand('/模型 deepseek-official deepseek-v4-pro', {
      userId: 'user_a1b2c3d4e5f60030',
      session,
      ctx: booted.ctx,
      sessionManager,
    });
    expect(res3.success).toBe(true);
    expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-v4-pro');
  });

  it('契约 13: /思考 -g 与 /模型 -g 在存在离线或失效会话 (session not found) 时容错隔离，确保全局切换成功', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const sessionActive = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60040' as any);

    const staleSid = 'kujira-user-deadbeefdeadbeef';
    sessionManager.getOrCreateSelectionRef(staleSid);

    const selectModelMock = vi.fn(async (req: any) => {
      if (req.sessionId === staleSid) {
        throw new Error(`session "${staleSid}" not found`);
      }
      return { selected: req };
    });
    const sessionController = booted.ctx.get('sessionController') || (booted.ctx as any).sessionController;
    const originalSelectModel = sessionController?.selectModel;
    if (sessionController) {
      sessionController.selectModel = selectModelMock;
    } else {
      (booted.ctx as any).provide('sessionController', { selectModel: selectModelMock });
    }

    try {
      const thinkRes = await handleSlashCommand('/思考 high -g', {
        userId: 'user_a1b2c3d4e5f60040',
        session: sessionActive,
        ctx: booted.ctx,
        sessionManager,
      });

      expect(thinkRes.handled).toBe(true);
      expect(thinkRes.success).toBe(true);
      expect(thinkRes.reply).toContain('Kujira 全局思考深度已切换为：high (High)');
      expect(sessionManager.getKujiraDefaultModel().reasoningEffort).toBe('high');
      expect(sessionManager.getModelSelection(sessionActive.id)?.reasoningEffort).toBe('high');

      const modelRes = await handleSlashCommand('/模型 deepseek-v4-flash -g', {
        userId: 'user_a1b2c3d4e5f60040',
        session: sessionActive,
        ctx: booted.ctx,
        sessionManager,
      });

      expect(modelRes.handled).toBe(true);
      expect(modelRes.success).toBe(true);
      expect(modelRes.reply).toContain('Kujira 全局模型已切换为：deepseek-official / deepseek-v4-flash');
      expect(sessionManager.getKujiraDefaultModel().model).toBe('deepseek-v4-flash');
      expect(sessionManager.getModelSelection(sessionActive.id)?.model).toBe('deepseek-v4-flash');
    } finally {
      if (sessionController && originalSelectModel) {
        sessionController.selectModel = originalSelectModel;
      }
    }
  });
});
