import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import {
  registerKujiraQuestionChannel,
  KujiraQuestionProvider,
  KujiraApprovalResponder,
} from '../../src/approval/index.js';
import { registerConfigRoute, CONFIG_ROUTE_PATH } from '../../src/server/routes.js';
import { isKujiraSession, sessionIdToPeer } from '../../src/gateway/session/id-resolver.js';
import { openidToSessionBaseId } from '../../src/utils/peer.js';
import * as KujiraPlugin from '../../src/index.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

describe('阶段 1 契约测试：生命周期与 P0 装配契约 (Lifecycle & Assembly P0)', () => {
  describe('A4/A5: 提问与审批 waterfall 先手契约 (prepend: true)', () => {
    it('A5: 宿主提问处理者先注册且不 next() 时，Kujira 仍能通过 prepend 优先认领单聊会话', async () => {
      const ctx = new Context();

      // 1. 模拟宿主 answerer 先注册，且无条件认领全部提问（不调用 next）
      let hostHandledCount = 0;
      ctx.on('user-questions/request', async () => {
        hostHandledCount += 1;
        return { answers: [{ id: 'q1', selected: ['host-default-answer'] }] };
      });

      // 2. 插件注册 KujiraQuestionChannel（不覆盖 isKujiraSession，直接验证默认单聊识别）
      let kujiraHandledCount = 0;
      const fakeProvider = {
        ask: async () => {
          kujiraHandledCount += 1;
          return { answers: [{ id: 'q1', selected: ['kujira-qq-answer'] }] };
        },
      } as unknown as KujiraQuestionProvider;

      const unregister = registerKujiraQuestionChannel(ctx, {
        questionProvider: fakeProvider,
      });

      // 3. Kujira 单聊会话提问：Kujira 必须先手认领，绝不能被宿主截胡
      const qqReq = {
        agent: { id: MOCK_SESSION_ID, session: { id: MOCK_SESSION_ID } },
        questions: [{ id: 'q1', question: 'QQ问题' }],
      };
      const qqRes = await (ctx as any).waterfall(
        'user-questions/request',
        qqReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(kujiraHandledCount).toBe(1);
      expect(hostHandledCount).toBe(0);
      expect(qqRes).toEqual({ answers: [{ id: 'q1', selected: ['kujira-qq-answer'] }] });

      // 4. 非 Kujira 会话提问：Kujira 通过 next() 委派，宿主成功处理
      const webReq = {
        agent: { id: 'web-session-1', session: { id: 'web-session-1' } },
        questions: [{ id: 'q1', question: 'Web问题' }],
      };
      const webRes = await (ctx as any).waterfall(
        'user-questions/request',
        webReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(kujiraHandledCount).toBe(1);
      expect(hostHandledCount).toBe(1);
      expect(webRes).toEqual({ answers: [{ id: 'q1', selected: ['host-default-answer'] }] });

      unregister();
    });

    it('A4: 宿主审批处理者先注册且不 next() 时，Kujira 仍能通过 prepend 优先认领单聊审批', async () => {
      const ctx = new Context();

      // 1. 模拟宿主审批 answerer 先注册，且无条件处理任何审批（不调用 next）
      let hostApprovalHandled = false;
      ctx.on('approval/request', async () => {
        hostApprovalHandled = true;
        return 'allowed-once';
      });

      // 2. 模拟 Kujira 审批处理者（直接验证 KujiraApprovalResponder 导出可用）
      let kujiraApprovalHandled = false;
      const fakeResponder = {
        handleApprovalRequest: async () => {
          kujiraApprovalHandled = true;
          return 'rejected';
        },
      } as unknown as KujiraApprovalResponder;

      // 按照 { prepend: true } 注册审批
      const unregister = (ctx as any).on(
        'approval/request',
        async (req: any, next: any) => {
          const sessionId = req.agent?.session?.id;
          if (!sessionId || !isKujiraSession(sessionId)) {
            return next ? next() : 'unavailable';
          }
          const peer = sessionIdToPeer(sessionId);
          return await fakeResponder.handleApprovalRequest({
            peer,
            sessionId,
            toolName: req.toolName,
            reason: req.reason,
          });
        },
        { prepend: true }
      );

      // 3. Kujira 单聊会话审批：Kujira 必须先手认领
      const qqReq = {
        agent: { session: { id: MOCK_SESSION_ID } },
        toolName: 'bash',
        reason: 'execute command',
      };
      const qqRes = await (ctx as any).waterfall(
        'approval/request',
        qqReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(kujiraApprovalHandled).toBe(true);
      expect(hostApprovalHandled).toBe(false);
      expect(qqRes).toBe('rejected');

      // 4. Web 会话审批：委派给宿主
      kujiraApprovalHandled = false;
      hostApprovalHandled = false;
      const webReq = {
        agent: { session: { id: 'web-session-2' } },
        toolName: 'bash',
        reason: 'execute command',
      };
      const webRes = await (ctx as any).waterfall(
        'approval/request',
        webReq as any,
        () => Promise.reject(new Error('no answerer'))
      );
      expect(kujiraApprovalHandled).toBe(false);
      expect(hostApprovalHandled).toBe(true);
      expect(webRes).toBe('allowed-once');

      unregister();
    });
  });

  describe('A6/A11: 生命周期就绪、配置自愈与卸载清理', () => {
    let tmpHome: string;
    let originalDshHome: string | undefined;

    beforeEach(async () => {
      originalDshHome = process.env.DSH_HOME;
      tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-lifecycle-'));
      process.env.DSH_HOME = tmpHome;
    });

    afterEach(async () => {
      if (originalDshHome !== undefined) {
        process.env.DSH_HOME = originalDshHome;
      } else {
        delete process.env.DSH_HOME;
      }
      if (tmpHome) {
        await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('A6: 存在 appReady 服务时通过 onReady 触发配置自愈；不存在时兜底触发', async () => {
      const patchDir = path.join(tmpHome, 'profiles', 'desktop');
      const patchFile = path.join(patchDir, 'cordis.patch.yml');
      await fsp.mkdir(patchDir, { recursive: true });

      const staleYaml = [
        '- insert:',
        '    - id: kujira',
        '      name: kujira',
        '      config:',
        '        ws_port: 8080',
        "        ws_token: 'legacy-token'",
        '        face_enabled: true',
        '        slang_enabled: false',
        '        face_store_max: 120',
        '',
      ].join('\n');

      // 场景 1: 带有 0.2.1 appReady 服务的环境
      await fsp.writeFile(patchFile, staleYaml, 'utf8');
      const ctx1 = new Context();
      let readyCallback: (() => void) | undefined;
      const appReadyService = {
        onReady: vi.fn((cb: () => void) => {
          readyCallback = cb;
          return () => {};
        }),
      };
      ctx1.provide('appReady', appReadyService);

      const fork1 = ctx1.plugin(KujiraPlugin.apply, {});
      await fork1;

      expect(appReadyService.onReady).toHaveBeenCalled();
      // 在 onReady 触发前尚未执行自愈清洗
      expect(fs.readFileSync(patchFile, 'utf8')).toContain('ws_port');

      // 触发 onReady：立即清洗过期字段并保留合法配置
      readyCallback?.();
      const healedContent1 = fs.readFileSync(patchFile, 'utf8');
      expect(healedContent1).not.toContain('ws_port');
      expect(healedContent1).not.toContain('ws_token');
      expect(healedContent1).not.toContain('face_enabled');
      expect(healedContent1).not.toContain('slang_enabled');
      expect(healedContent1).toContain('face_store_max: 120');

      await fork1.dispose();

      // 场景 2: 无 appReady 服务的单测/独立环境，自动兜底调用自愈
      await fsp.writeFile(patchFile, staleYaml, 'utf8');
      const ctx2 = new Context();
      const fork2 = ctx2.plugin(KujiraPlugin.apply, {});
      await fork2;

      const healedContent2 = fs.readFileSync(patchFile, 'utf8');
      expect(healedContent2).not.toContain('ws_port');
      expect(healedContent2).not.toContain('ws_token');
      expect(healedContent2).not.toContain('face_enabled');
      expect(healedContent2).not.toContain('slang_enabled');
      expect(healedContent2).toContain('face_store_max: 120');

      await fork2.dispose();
    });

    it('A6/A11: 插件卸载 (fiber.dispose / ctx.effect) 时完整注销 REST 路由并移除进程监听器', async () => {
      const ctx = new Context();

      let unregisterCalled = false;
      const mockWebServer = {
        register: vi.fn(() => () => {
          unregisterCalled = true;
        }),
      };
      ctx.provide('webServer', mockWebServer);

      const sigintCountBefore = process.listenerCount('SIGINT');
      const sigtermCountBefore = process.listenerCount('SIGTERM');
      const beforeExitCountBefore = process.listenerCount('beforeExit');

      const fork = ctx.plugin(KujiraPlugin.apply, {});
      await fork;

      expect(mockWebServer.register).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'exact',
          path: CONFIG_ROUTE_PATH,
        })
      );
      expect(process.listenerCount('SIGINT')).toBe(sigintCountBefore + 1);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermCountBefore + 1);
      expect(process.listenerCount('beforeExit')).toBe(beforeExitCountBefore + 1);

      // 执行插件销毁
      await fork.dispose();

      // 断言: 路由已被注销
      expect(unregisterCalled).toBe(true);
      // 断言: 进程监听器已被全部移除，不泄漏
      expect(process.listenerCount('SIGINT')).toBe(sigintCountBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermCountBefore);
      expect(process.listenerCount('beforeExit')).toBe(beforeExitCountBefore);
    });

    it('A11: webServer 重复注册抛出异常时安全捕获，且返回的 disposer 仍能安全注销', () => {
      const ctx = new Context();
      let unregisterCalled = false;
      const mockWebServer = {
        register: vi
          .fn()
          .mockImplementationOnce(() => () => {
            unregisterCalled = true;
          })
          .mockImplementationOnce(() => {
            throw new Error(`webserver: duplicate exact route "${CONFIG_ROUTE_PATH}"`);
          }),
      };
      ctx.provide('webServer', mockWebServer);

      // 第一次注册成功
      const unregister1 = registerConfigRoute(ctx, () => ({}) as any, async () => {}, {
        dshHome: tmpHome,
      });
      expect(mockWebServer.register).toHaveBeenCalledTimes(1);

      // 第二次注册模拟重复注册，不应抛出异常
      let unregister2: (() => void) | undefined;
      expect(() => {
        unregister2 = registerConfigRoute(ctx, () => ({}) as any, async () => {}, {
          dshHome: tmpHome,
        });
      }).not.toThrow();

      // 清理
      unregister1();
      unregister2?.();
      expect(unregisterCalled).toBe(true);
    });
  });
});
