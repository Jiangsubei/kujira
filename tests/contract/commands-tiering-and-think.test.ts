import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { handleSlashCommand } from '../../src/commands/index.js';
import { SessionManager } from '../../src/gateway/session.js';
import type { BridgePluginConfig } from '../../src/types/index.js';

describe('契约测试: 斜杠命令权限分层与 /思考 -默认 重构 (Commands Tiering & Think Default Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-cmd-tier-'));
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

  describe('一、斜杠命令权限分层', () => {
    it('契约 1: admins 为空（1 对 1 模式）时，所有命令（含 /权限、/模型 -默认、/思考 -默认）全量放行', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
      const peer = 'user_a1b2c3d4e5f60001';

      const permRes = await handleSlashCommand('/权限 完全', {
        userId: peer,
        session,
        ctx: booted.ctx,
        sessionManager,
        admins: [],
      });
      expect(permRes.handled).toBe(true);
      expect(permRes.success).toBe(true);
      expect(permRes.reply).toBe('权限模式已切换为：完全');

      const modelRes = await handleSlashCommand('/模型 deepseek-v4-pro -默认', {
        userId: peer,
        session,
        ctx: booted.ctx,
        sessionManager,
        config: { admins: [] },
      });
      expect(modelRes.handled).toBe(true);
      expect(modelRes.success).toBe(true);
      expect(sessionManager.getConfiguredDefaultModel()?.model).toBe('deepseek-v4-pro');

      const thinkRes = await handleSlashCommand('/思考 low -默认', {
        userId: peer,
        session,
        ctx: booted.ctx,
        sessionManager,
        admins: [],
      });
      expect(thinkRes.handled).toBe(true);
      expect(thinkRes.success).toBe(true);
      expect(sessionManager.getConfiguredDefaultModel()?.reasoningEffort).toBe('low');
    });

    it('契约 2: admins 非空（支持多管理员）时，管理员可执行全部管理员受限指令', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const admin1 = 'user_a1b2c3d4e5f60001';
      const admin2 = 'user_a1b2c3d4e5f60002';
      const admins = [admin1, admin2];

      const session1 = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
      const session2 = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

      const permRes1 = await handleSlashCommand('/权限 编辑', {
        userId: admin1,
        session: session1,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(permRes1.success).toBe(true);
      expect(permRes1.reply).toBe('权限模式已切换为：编辑');

      const permQuery2 = await handleSlashCommand('/权限', {
        userId: admin2,
        session: session2,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(permQuery2.success).toBe(true);
      expect(permQuery2.reply).toContain('当前权限模式：');

      const modelRes2 = await handleSlashCommand('/模型 deepseek-v4-pro -默认', {
        userId: admin2,
        session: session2,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(modelRes2.success).toBe(true);
      expect(sessionManager.getConfiguredDefaultModel()?.model).toBe('deepseek-v4-pro');

      const thinkRes1 = await handleSlashCommand('/思考 max -默认', {
        userId: admin1,
        session: session1,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(thinkRes1.success).toBe(true);
      expect(sessionManager.getConfiguredDefaultModel()?.reasoningEffort).toBe('max');
    });

    it('契约 3: admins 非空时，非管理员执行普通指令及不带 -默认 的 /模型、/思考 均正常放行且不做角色内容裁剪', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const adminPeer = 'user_a1b2c3d4e5f60001';
      const userPeer = 'user_a1b2c3d4e5f60099';
      const admins = [adminPeer];

      const adminSession = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
      const userSession = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60099' as any);

      // 注入停止控制器，确保 /停止 可完整执行
      (booted.ctx as any).provide('sessionController', {
        cancel: async () => ({ accepted: true }),
      });

      // 1. /帮助 返回内容不做角色裁剪（管理员与普通用户完全一致）
      const adminHelp = await handleSlashCommand('/帮助', {
        userId: adminPeer,
        session: adminSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      const userHelp = await handleSlashCommand('/帮助', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(userHelp.handled).toBe(true);
      expect(userHelp.success).toBe(true);
      expect(userHelp.reply).toBe(adminHelp.reply);

      // 2. /状态、/用量、/停止、/会话、/新建、/压缩 全部放行
      const statusRes = await handleSlashCommand('/状态', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(statusRes.handled).toBe(true);
      expect(statusRes.success).toBe(true);
      expect(statusRes.reply).toContain('【当前会话状态】');

      const usageRes = await handleSlashCommand('/用量', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(usageRes.handled).toBe(true);
      expect(usageRes.error).not.toBe('权限不足：该指令仅限管理员使用');

      const stopRes = await handleSlashCommand('/停止', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(stopRes.handled).toBe(true);
      expect(stopRes.success).toBe(true);

      const sessionListRes = await handleSlashCommand('/会话', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(sessionListRes.handled).toBe(true);
      expect(sessionListRes.error).not.toBe('权限不足：该指令仅限管理员使用');

      const compactRes = await handleSlashCommand('/压缩', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(compactRes.handled).toBe(true);
      expect(compactRes.error).not.toBe('权限不足：该指令仅限管理员使用');

      const newRes = await handleSlashCommand('/新建', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(newRes.handled).toBe(true);
      expect(newRes.success).toBe(true);

      // 3. 不带 -默认 的 /模型 与 /思考 全员放行且内容不裁剪
      sessionManager.setModelSelection(adminSession.id, 'deepseek-official', 'deepseek-v4-flash', 'high');
      sessionManager.setModelSelection(userSession.id, 'deepseek-official', 'deepseek-v4-flash', 'high');
      const adminModelList = await handleSlashCommand('/模型', {
        userId: adminPeer,
        session: adminSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      const userModelList = await handleSlashCommand('/模型', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(userModelList.success).toBe(true);
      expect(userModelList.reply).toBe(adminModelList.reply);

      const userModelSwitch = await handleSlashCommand('/模型 deepseek-v4-pro', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(userModelSwitch.success).toBe(true);
      expect(sessionManager.getModelSelection(userSession.id)?.model).toBe('deepseek-v4-pro');

      sessionManager.setModelSelection(adminSession.id, 'deepseek-official', 'deepseek-v4-pro', 'high');
      const adminThinkList = await handleSlashCommand('/思考', {
        userId: adminPeer,
        session: adminSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      const userThinkList = await handleSlashCommand('/思考', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(userThinkList.success).toBe(true);
      expect(userThinkList.reply).toBe(adminThinkList.reply);

      const userThinkSwitch = await handleSlashCommand('/思考 low', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(userThinkSwitch.success).toBe(true);
      expect(sessionManager.getModelSelection(userSession.id)?.reasoningEffort).toBe('low');

      // /思考 默认（无前导横杠）仅恢复当前会话默认，不是 -默认，非管理员放行
      const userThinkReset = await handleSlashCommand('/思考 默认', {
        userId: userPeer,
        session: userSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(userThinkReset.success).toBe(true);
      expect(sessionManager.getModelSelection(userSession.id)?.reasoningEffort).toBeUndefined();
    });

    it('契约 4: admins 非空时，非管理员执行 /权限、/模型 ... -默认、/思考 ... -默认 均被拦截且不产生副作用', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const adminPeer = 'user_a1b2c3d4e5f60001';
      const nonAdminPeer = 'user_a1b2c3d4e5f60099';
      const admins = [adminPeer];

      const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60099' as any);
      booted.ctx.permissionPresets.set(session, 'read-only');
      sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'high');
      sessionManager.setModelSelection(session.id, 'deepseek-official', 'deepseek-v4-pro', 'high');

      const blockedCommands = [
        '/权限',
        '/权限 完全',
        '／权限 编辑',
        '/模型 deepseek-v4-flash -默认',
        '/模型 -默认 deepseek-v4-flash',
        '／模型 deepseek-v4-flash -默认',
        '/思考 low -默认',
        '/思考 默认 -默认',
        '／思考 max -默认',
      ];

      for (const cmd of blockedCommands) {
        const res = await handleSlashCommand(cmd, {
          userId: nonAdminPeer,
          session,
          ctx: booted.ctx,
          sessionManager,
          admins,
        });
        expect(res).toEqual({
          handled: true,
          success: false,
          error: '权限不足：该指令仅限管理员使用',
        });
      }

      // 确认无任何副作用
      expect(booted.ctx.permissionPresets.current(session)).toBe('read-only');
      expect(sessionManager.getConfiguredDefaultModel()).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      });
      expect(sessionManager.getModelSelection(session.id)?.model).toBe('deepseek-v4-pro');
      expect(sessionManager.getModelSelection(session.id)?.reasoningEffort).toBe('high');

      // userId 缺省时回退通过 sessionIdToPeer 识别发起人
      const fallbackBlocked = await handleSlashCommand('/权限 完全', {
        userId: '',
        session,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(fallbackBlocked).toEqual({
        handled: true,
        success: false,
        error: '权限不足：该指令仅限管理员使用',
      });

      const adminSession = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60001' as any);
      const fallbackAllowed = await handleSlashCommand('/权限 完全', {
        userId: '',
        session: adminSession,
        ctx: booted.ctx,
        sessionManager,
        admins,
      });
      expect(fallbackAllowed.success).toBe(true);
    });

    it('契约 5: 支持从 kujira-bridge-config 服务实时读取 admins 并随配置热更新立即生效，且遵守优先级', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const user1 = 'user_a1b2c3d4e5f60001';
      const user2 = 'user_a1b2c3d4e5f60002';
      const session2 = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60002' as any);

      let liveConfig: BridgePluginConfig = { admins: [user1] };
      (booted.ctx as any).provide('kujira-bridge-config', () => liveConfig);

      // 1. 初始仅 user1 为管理员 → user2 被拦截
      const blocked = await handleSlashCommand('/权限', {
        userId: user2,
        session: session2,
        ctx: booted.ctx,
        sessionManager,
      });
      expect(blocked.success).toBe(false);
      expect(blocked.error).toBe('权限不足：该指令仅限管理员使用');

      // 2. 热更新将 user2 加入 admins → 立即放行
      liveConfig = { admins: [user1, user2] };
      const allowedAfterUpdate = await handleSlashCommand('/权限', {
        userId: user2,
        session: session2,
        ctx: booted.ctx,
        sessionManager,
      });
      expect(allowedAfterUpdate.success).toBe(true);

      // 3. 热更新清空 admins（1 对 1 模式）→ 任意用户放行
      liveConfig = { admins: [] };
      const strangerSession = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60088' as any);
      const allowedOneToOne = await handleSlashCommand('/权限 编辑', {
        userId: 'user_a1b2c3d4e5f60088',
        session: strangerSession,
        ctx: booted.ctx,
        sessionManager,
      });
      expect(allowedOneToOne.success).toBe(true);

      // 4. 优先级：context.admins > context.config.admins > kujira-bridge-config
      liveConfig = { admins: [user1] };
      const overrideByConfig = await handleSlashCommand('/权限', {
        userId: user2,
        session: session2,
        ctx: booted.ctx,
        sessionManager,
        config: { admins: [user2] },
      });
      expect(overrideByConfig.success).toBe(true);

      const overrideByAdmins = await handleSlashCommand('/权限', {
        userId: user2,
        session: session2,
        ctx: booted.ctx,
        sessionManager,
        config: { admins: [user2] },
        admins: [user1],
      });
      expect(overrideByAdmins.success).toBe(false);
      expect(overrideByAdmins.error).toBe('权限不足：该指令仅限管理员使用');
    });
  });

  describe('二、/思考 -默认 重构契约', () => {
    it('契约 6: /思考 空参帮助文案移除 -g / --全局 / --global，对齐 -默认 语法并展示新建会话默认', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60011' as any);
      sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'low');

      const res = await handleSlashCommand('/思考', {
        userId: 'user_a1b2c3d4e5f60011',
        session,
        ctx: booted.ctx,
        sessionManager,
      });

      expect(res.handled).toBe(true);
      expect(res.success).toBe(true);
      expect(res.reply).toContain('当前模型：');
      expect(res.reply).toContain('当前思考强度：');
      expect(res.reply).toContain('新建会话默认：deepseek-official / deepseek-v4-pro (思考: low)');
      expect(res.reply).toContain('- 仅当前会话：/思考 <档位>（例如：/思考 low 或 /思考 max）');
      expect(res.reply).toContain('- 恢复模型默认：/思考 default');
      expect(res.reply).toContain('- 设为新建会话默认：在末尾追加 -默认');
      expect(res.reply).not.toContain('-g');
      expect(res.reply).not.toContain('--全局');
      expect(res.reply).not.toContain('--global');
      expect(res.reply).not.toContain('所有会话全局生效');
      expect(res.reply).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it('契约 7: /思考 默认 仅恢复当前会话；/思考 low -默认 仅更新当前会话与新建会话默认，绝不改写其他活跃会话；/思考 默认 -默认 重置新建会话默认', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const sessionA = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60012' as any);
      const sessionB = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60013' as any);

      sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'high');
      sessionManager.setModelSelection(sessionA.id, 'deepseek-official', 'deepseek-v4-pro', 'max');
      sessionManager.setModelSelection(sessionB.id, 'deepseek-official', 'deepseek-v4-flash', 'off');

      const selectModelSpy = vi.fn(async (req: any) => ({ selected: req }));
      const sessionController =
        booted.ctx.get('sessionController') || (booted.ctx as any).sessionController;
      const originalSelectModel = sessionController?.selectModel;
      if (sessionController) {
        sessionController.selectModel = selectModelSpy;
      } else {
        (booted.ctx as any).provide('sessionController', { selectModel: selectModelSpy });
      }

      try {
        // 1. /思考 默认 → 仅恢复 sessionA 为模型默认 (undefined)，不修改新建会话默认
        const resetCurRes = await handleSlashCommand('/思考 默认', {
          userId: 'user_a1b2c3d4e5f60012',
          session: sessionA,
          ctx: booted.ctx,
          sessionManager,
        });
        expect(resetCurRes.success).toBe(true);
        expect(resetCurRes.reply).toContain('提示：仅对当前会话生效；设为新建会话默认请追加 -默认。');
        expect(sessionManager.getModelSelection(sessionA.id)?.reasoningEffort).toBeUndefined();
        expect(sessionManager.getConfiguredDefaultModel()?.reasoningEffort).toBe('high');
        expect(sessionManager.getModelSelection(sessionB.id)?.reasoningEffort).toBe('off');

        selectModelSpy.mockClear();

        // 2. /思考 low -默认 → 更新 sessionA 和新建会话默认，绝不触碰 sessionB
        const setDefaultRes = await handleSlashCommand('/思考 low -默认', {
          userId: 'user_a1b2c3d4e5f60012',
          session: sessionA,
          ctx: booted.ctx,
          sessionManager,
        });
        expect(setDefaultRes.success).toBe(true);
        expect(setDefaultRes.reply).toContain('当前会话思考深度已切换为：low (Low)');
        expect(setDefaultRes.reply).toContain('已设为新建会话默认思考深度');
        expect(sessionManager.getModelSelection(sessionA.id)?.reasoningEffort).toBe('low');
        expect(sessionManager.getConfiguredDefaultModel()).toEqual({
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'low',
        });
        expect(sessionManager.getModelSelection(sessionB.id)?.reasoningEffort).toBe('off');
        expect(selectModelSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: sessionB.id })
        );

        // 3. /思考 默认 -默认 → 同时将 sessionA 与新建会话默认思考深度重置为模型默认 (undefined)
        const resetDefaultRes = await handleSlashCommand('/思考 默认 -默认', {
          userId: 'user_a1b2c3d4e5f60012',
          session: sessionA,
          ctx: booted.ctx,
          sessionManager,
        });
        expect(resetDefaultRes.success).toBe(true);
        expect(sessionManager.getModelSelection(sessionA.id)?.reasoningEffort).toBeUndefined();
        expect(sessionManager.getConfiguredDefaultModel()).toEqual({
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
        });
      } finally {
        if (sessionController && originalSelectModel) {
          sessionController.selectModel = originalSelectModel;
        }
      }
    });

    it('契约 8: 已配置不同的新建会话默认模型时，/思考 ... -默认 保留原默认模型仅更新其思考深度；不兼容时拒绝覆盖并明确报错', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60014' as any);
      const peer = 'user_a1b2c3d4e5f60014';

      // 场景 A：默认模型为 deepseek-v4-pro，当前会话为 deepseek-v4-flash，默认模型支持 low → 保留 pro 仅更新思考深度
      sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'high');
      sessionManager.setModelSelection(session.id, 'deepseek-official', 'deepseek-v4-flash', 'max');

      const compatRes = await handleSlashCommand('/思考 low -默认', {
        userId: peer,
        session,
        ctx: booted.ctx,
        sessionManager,
      });
      expect(compatRes.success).toBe(true);
      expect(compatRes.reply).toContain('当前会话思考深度已切换为：low (Low)');
      expect(compatRes.reply).toContain('deepseek-official / deepseek-v4-pro');
      expect(sessionManager.getModelSelection(session.id)).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'low',
      });
      expect(sessionManager.getConfiguredDefaultModel()).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'low',
      });

      // 场景 B & C：自定义 mock llm.resolveModelInfo 验证不支持思考/不支持指定档位的默认模型拒绝覆盖
      const llm = booted.ctx.get('llm') || (booted.ctx as any).llm;
      const originalResolveModelInfo = llm?.resolveModelInfo;
      const mockedResolveModelInfo = async (provider: string, model: string) => {
        if (provider === 'custom-provider' && model === 'no-think-model') {
          return { id: model, provider, reasoning: undefined };
        }
        if (provider === 'custom-provider' && model === 'limited-think-model') {
          return {
            id: model,
            provider,
            reasoning: {
              defaultEffort: 'low',
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
              ],
            },
          };
        }
        if (typeof originalResolveModelInfo === 'function') {
          return originalResolveModelInfo.call(llm, provider, model);
        }
        return undefined;
      };
      if (llm) {
        llm.resolveModelInfo = mockedResolveModelInfo;
      }

      try {
        // 场景 B：默认模型不支持深度思考
        sessionManager.setConfiguredDefaultModel('custom-provider', 'no-think-model');
        sessionManager.setModelSelection(session.id, 'deepseek-official', 'deepseek-v4-flash', 'high');

        const noThinkRes = await handleSlashCommand('/思考 low -默认', {
          userId: peer,
          session,
          ctx: booted.ctx,
          sessionManager,
        });
        expect(noThinkRes.handled).toBe(true);
        expect(noThinkRes.success).toBe(false);
        expect(noThinkRes.error).toContain('custom-provider / no-think-model');
        expect(noThinkRes.error).toContain('不支持深度思考');
        expect(noThinkRes.error).toContain('/模型 <模型> -默认');
        // 未覆盖默认模型，也未改写当前会话
        expect(sessionManager.getConfiguredDefaultModel()).toEqual({
          provider: 'custom-provider',
          model: 'no-think-model',
        });
        expect(sessionManager.getModelSelection(session.id)?.reasoningEffort).toBe('high');

        // 场景 C：默认模型支持思考但不支持目标档位 max
        sessionManager.setConfiguredDefaultModel('custom-provider', 'limited-think-model', 'low');

        const unsupportedEffortRes = await handleSlashCommand('/思考 max -默认', {
          userId: peer,
          session,
          ctx: booted.ctx,
          sessionManager,
        });
        expect(unsupportedEffortRes.handled).toBe(true);
        expect(unsupportedEffortRes.success).toBe(false);
        expect(unsupportedEffortRes.error).toContain('custom-provider / limited-think-model');
        expect(unsupportedEffortRes.error).toContain('[max]');
        expect(sessionManager.getConfiguredDefaultModel()).toEqual({
          provider: 'custom-provider',
          model: 'limited-think-model',
          reasoningEffort: 'low',
        });
        expect(sessionManager.getModelSelection(session.id)?.reasoningEffort).toBe('high');
      } finally {
        if (llm && originalResolveModelInfo) {
          llm.resolveModelInfo = originalResolveModelInfo;
        }
      }
    });

    it('契约 9: 旧参数 -g / --全局 / --global 不再作为全局开关生效', async () => {
      const sessionManager = new SessionManager(booted.ctx, tmpHome);
      const session = booted.ctx.sessions.create('kujira-user-a1b2c3d4e5f60015' as any);
      sessionManager.setConfiguredDefaultModel('deepseek-official', 'deepseek-v4-pro', 'high');
      sessionManager.setModelSelection(session.id, 'deepseek-official', 'deepseek-v4-pro', 'high');

      for (const legacyCmd of ['/思考 low -g', '/思考 low --全局', '/思考 low --global']) {
        const res = await handleSlashCommand(legacyCmd, {
          userId: 'user_a1b2c3d4e5f60015',
          session,
          ctx: booted.ctx,
          sessionManager,
        });
        expect(res.handled).toBe(true);
        expect(res.success).toBe(false);
        expect(res.error).toContain('无效的思考深度');
      }

      expect(sessionManager.getModelSelection(session.id)?.reasoningEffort).toBe('high');
      expect(sessionManager.getConfiguredDefaultModel()?.reasoningEffort).toBe('high');
    });
  });
});
