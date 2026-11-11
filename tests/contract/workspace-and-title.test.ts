import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import {
  SessionManager,
  formatFallbackSessionTitle,
  formatSessionVersionTag,
} from '../../src/gateway/session.js';
import { handleSessionCommand } from '../../src/commands/session/session-handler.js';
import { handleStatusCommand } from '../../src/commands/system/status-handler.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import type { WakeupPayload } from '../../src/types/index.js';

const OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(OPENID);
const SID = openidToSessionBaseId(OPENID);

const OPENID_B = '10000000000000000000000000000019';
const PEER_B = openidToPeer(OPENID_B);
const SID_B = openidToSessionBaseId(OPENID_B);

describe('Kujira 顶层工作区与原生 AI 会话标题契约测试', () => {
  let tmpHome: string;
  let ctx: Context;
  let sessionManager: SessionManager;
  let mockWorkspace: any;
  let mockWorkspaceRegistry: any;
  let mockSessionTitle: any;
  let mockAgents: any;
  let titleStore: Map<string, string>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-ws-title-'));
    ctx = new Context();
    titleStore = new Map();
    mockWorkspace = {
      path: path.resolve(tmpHome, 'workspace/kujira'),
      title: 'Kujira',
      attachSession: vi.fn().mockResolvedValue(undefined),
    };
    mockWorkspaceRegistry = {
      create: vi.fn().mockResolvedValue(mockWorkspace),
      archivedSessionIds: [],
    };
    mockSessionTitle = {
      rename: vi.fn(),
      get: vi.fn((session: any) => {
        const title = session?.id ? titleStore.get(session.id) : undefined;
        return title ? { title } : undefined;
      }),
    };
    mockAgents = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return {
          agent: {
            session: { id: opts.sessionId },
            followup: vi.fn(),
          },
          dispose: vi.fn(),
        };
      }),
      resume: vi.fn(),
      get: vi.fn(),
    };

    (ctx as any).workspaceRegistry = mockWorkspaceRegistry;
    (ctx as any).sessionTitle = mockSessionTitle;
    (ctx as any).agents = mockAgents;

    sessionManager = new SessionManager(ctx, tmpHome);
  });

  afterEach(async () => {
    await sessionManager.dispose().catch(() => {});
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('1. 会话轮次标签与默认回退标题 (formatSessionVersionTag / formatFallbackSessionTitle)', () => {
    it('初始版本 - #1 / 新会话 #1', () => {
      expect(formatSessionVersionTag(SID)).toBe('#1');
      expect(formatFallbackSessionTitle(SID)).toBe('新会话 #1');
    });

    it('带版本号 - /新建 后新会话 #3 / 新会话 #3', () => {
      expect(formatSessionVersionTag(`${SID}-3`)).toBe('#3');
      expect(formatFallbackSessionTitle(`${SID}-3`)).toBe('新会话 #3');
    });

    it('多轮归档后 - 新轮次 1 初始版本 #1 (1) / 新会话 #1 (1)', () => {
      expect(formatSessionVersionTag(`${SID}-r1-1`)).toBe('#1 (1)');
      expect(formatFallbackSessionTitle(`${SID}-r1-1`)).toBe('新会话 #1 (1)');
    });

    it('多轮归档后 - 新轮次 1 清空后版本 #2 (1) / 新会话 #2 (1)', () => {
      expect(formatSessionVersionTag(`${SID}-r1-2`)).toBe('#2 (1)');
      expect(formatFallbackSessionTitle(`${SID}-r1-2`)).toBe('新会话 #2 (1)');
    });

    it('多轮归档后 - 新轮次 2 初始版本 #1 (2) / 新会话 #1 (2)', () => {
      expect(formatSessionVersionTag(`${SID}-r2-1`)).toBe('#1 (2)');
      expect(formatFallbackSessionTitle(`${SID}-r2-1`)).toBe('新会话 #1 (2)');
    });
  });

  describe('2. 工作区统一注册与 CWD 统一收敛', () => {
    it('resolveCwd 统一返回 kujira 根工作区目录', () => {
      const expectedCwd = path.resolve(tmpHome, 'workspace/kujira');
      expect(sessionManager.resolveCwd(PEER)).toBe(expectedCwd);
      expect(sessionManager.resolveCwd(SID)).toBe(expectedCwd);
      expect(sessionManager.resolveCwd(`${SID}-2`)).toBe(expectedCwd);
    });

    it('注册工作区时统一创建标题为 Kujira 的顶级工作区，并 attachSession', async () => {
      const cwd = sessionManager.resolveCwd(PEER);
      await sessionManager.registerWorkspace(cwd, SID);

      expect(mockWorkspaceRegistry.create).toHaveBeenCalledWith(cwd, 'Kujira');
      expect(mockWorkspace.attachSession).toHaveBeenCalledWith(SID);
    });
  });

  describe('3. 会话创建与唤醒放行原生 AI 总结，/会话 与 /状态 正确展示 AI 标题', () => {
    it('创建单聊 Agent 与 dispatchWakeup 均不再调用 sessionTitle.rename 锁定标题', async () => {
      await sessionManager.getOrCreateAgent(PEER);

      expect(mockSessionTitle.rename).not.toHaveBeenCalled();
      expect(mockWorkspaceRegistry.create).toHaveBeenCalledWith(
        path.resolve(tmpHome, 'workspace/kujira'),
        'Kujira'
      );
      expect(mockWorkspace.attachSession).toHaveBeenCalledWith(SID);

      const payload: WakeupPayload = {
        peer: PEER,
        trigger: 'direct',
        from_user: OPENID,
        from_name: '张三丰',
        content: '你好呀，帮我设计单聊架构',
        timestamp: Date.now(),
      };

      await sessionManager.dispatchWakeup(payload);
      expect(mockSessionTitle.rename).not.toHaveBeenCalled();
      expect(sessionManager.getSessionTitle(SID)).toBeUndefined();

      // 模拟 DSH 原生 AI 总结产出标题
      titleStore.set(SID, 'QQ 单聊架构设计');
      expect(sessionManager.getSessionTitle(SID)).toBe('QQ 单聊架构设计');
      expect(sessionManager.getSessionDisplayName(SID)).toBe('QQ 单聊架构设计');
    });

    it('/状态 与 /会话 分别展示 AI 标题、轮次标签并在无标题时回退「新会话」', async () => {
      await sessionManager.getOrCreateAgent(PEER);
      titleStore.set(SID, '排查 WebSocket 重连');

      const statusRes = await handleStatusCommand('', {
        userId: PEER,
        session: { id: SID } as any,
        ctx,
        sessionManager,
      });
      expect(statusRes.success).toBe(true);
      expect(statusRes.reply).toContain('当前会话：排查 WebSocket 重连 (#1)');
      expect(statusRes.reply).toContain(`会话标识：${SID} (版本: 1)`);

      const listRes = await handleSessionCommand('', {
        userId: PEER,
        session: { id: SID } as any,
        ctx,
        sessionManager,
      });
      expect(listRes.success).toBe(true);
      expect(listRes.reply).toContain('排查 WebSocket 重连 (#1)');
      expect(listRes.reply).not.toContain('私聊:');

      titleStore.delete(SID);
      const fallbackStatus = await handleStatusCommand('', {
        userId: PEER,
        session: { id: SID } as any,
        ctx,
        sessionManager,
      });
      expect(fallbackStatus.reply).toContain('当前会话：新会话 (#1)');
    });
  });

  describe('4. DSH 0.2.x 工作区 candidateMatches 契约与未分组防掉落', () => {
    it('契约: peerToSessionId 严禁主动从 wsRegistry.sessionPaths 中删除会话，避免触发 DSH mutate 剔除掉入未分组', () => {
      const sessionPaths = new Map<string, string>();
      sessionPaths.set(SID_B, path.resolve(tmpHome, 'workspace/kujira'));
      const wsRegistry = {
        headers: new Map<string, any>([
          [SID_B, { id: SID_B, cwd: path.resolve(tmpHome, 'workspace/kujira') }],
        ]),
        sessionPaths,
        invalidSessionPaths: new Map<string, string>(),
        archivedSessionIds: [],
      };
      (ctx as any).workspaceRegistry = wsRegistry;

      sessionManager.peerToSessionId(PEER_B);

      expect(sessionPaths.has(SID_B)).toBe(true);
    });

    it('契约: 真实 DSH WorkspaceEntity 经历挂载与解绑操作后，父会话必须始终保留在 sessionIds 中', async () => {
      const canonicalPath = path.resolve(tmpHome, 'workspace/kujira');
      const sessionPaths = new Map<string, string>();
      sessionPaths.set(SID, canonicalPath);

      const candidateMatches = (id: string, p: string) =>
        sessionPaths.get(id) === p;

      const entity = {
        record: {
          path: canonicalPath,
          title: 'Kujira',
          sessionIds: [SID],
        },
        get path() {
          return this.record.path;
        },
        get sessionIds() {
          return this.record.sessionIds.filter((id: string) => candidateMatches(id, this.record.path));
        },
        async attachSession(sessionId: string) {
          if (!this.record.sessionIds.includes(sessionId)) {
            sessionPaths.set(sessionId, this.record.path);
          }
          await this.mutate((rec: any) =>
            rec.sessionIds.includes(sessionId) ? rec : { ...rec, sessionIds: [sessionId, ...rec.sessionIds] }
          );
        },
        async detachSession(sessionId: string) {
          await this.mutate((rec: any) =>
            rec.sessionIds.includes(sessionId)
              ? { ...rec, sessionIds: rec.sessionIds.filter((id: string) => id !== sessionId) }
              : rec
          );
        },
        async mutate(fn: (rec: any) => any) {
          const changed = fn(this.record);
          const filtered = changed.sessionIds.filter((id: string) => candidateMatches(id, changed.path));
          this.record = {
            ...changed,
            sessionIds: filtered,
          };
        },
      };

      expect(entity.sessionIds).toContain(SID);

      const reviewSessionId = `review-${SID}-123456`;
      await entity.attachSession(reviewSessionId);
      expect(entity.sessionIds).toContain(SID);
      expect(entity.sessionIds).toContain(reviewSessionId);

      await entity.detachSession(reviewSessionId);

      expect(entity.sessionIds).toContain(SID);
      expect(entity.sessionIds).not.toContain(reviewSessionId);
    });
  });
});
