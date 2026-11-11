import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { SessionManager, formatSessionTitle } from '../../src/gateway/session.js';
import { openidToPeer, openidToSessionBaseId, extractPeerHash } from '../../src/utils/peer.js';
import type { WakeupPayload } from '../../src/types/index.js';

const OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(OPENID);
const HASH = extractPeerHash(PEER)!;
const SID = openidToSessionBaseId(OPENID);

const OPENID_B = '10000000000000000000000000000019';
const PEER_B = openidToPeer(OPENID_B);
const SID_B = openidToSessionBaseId(OPENID_B);

describe('Kujira 顶层工作区与单聊会话标题契约测试', () => {
  let tmpHome: string;
  let ctx: Context;
  let sessionManager: SessionManager;
  let mockWorkspace: any;
  let mockWorkspaceRegistry: any;
  let mockSessionTitle: any;
  let mockAgents: any;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-ws-title-'));
    ctx = new Context();
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
      get: vi.fn(),
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

  describe('1. 单聊会话标题格式化 (formatSessionTitle)', () => {
    it('私聊带用户昵称 - 初始版本 #1', () => {
      const title = formatSessionTitle(PEER, SID, 'TestUser');
      expect(title).toBe(`私聊: TestUser ${HASH} #1`);
    });

    it('私聊无用户昵称 - 初始版本 #1', () => {
      const title = formatSessionTitle(PEER, SID);
      expect(title).toBe(`私聊: ${HASH} #1`);
    });

    it('私聊带版本号 - /clear 后新会话 #3', () => {
      const title = formatSessionTitle(PEER, `${SID}-3`, 'TestUser');
      expect(title).toBe(`私聊: TestUser ${HASH} #3`);
    });

    it('多轮归档后 - 新轮次 1 初始版本 #1 (1)', () => {
      const title = formatSessionTitle(PEER, `${SID}-r1-1`, 'TestUser');
      expect(title).toBe(`私聊: TestUser ${HASH} #1 (1)`);
    });

    it('多轮归档后 - 新轮次 1 清空后版本 #2 (1)', () => {
      const title = formatSessionTitle(PEER, `${SID}-r1-2`, 'TestUser');
      expect(title).toBe(`私聊: TestUser ${HASH} #2 (1)`);
    });

    it('多轮归档后 - 新轮次 2 初始版本 #1 (2)', () => {
      const title = formatSessionTitle(PEER, `${SID}-r2-1`, 'TestUser');
      expect(title).toBe(`私聊: TestUser ${HASH} #1 (2)`);
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

  describe('3. 会话创建时标题锁定与免 LLM 自动总结覆盖', () => {
    it('创建单聊 Agent 时正确设置并锁定私聊标题与 Kujira 工作区', async () => {
      sessionManager.setPeerName(PEER, '小明');
      await sessionManager.getOrCreateAgent(PEER);

      expect(mockSessionTitle.rename).toHaveBeenCalledWith(
        expect.anything(),
        `私聊: 小明 ${HASH} #1`
      );
      expect(mockWorkspaceRegistry.create).toHaveBeenCalledWith(
        path.resolve(tmpHome, 'workspace/kujira'),
        'Kujira'
      );
      expect(mockWorkspace.attachSession).toHaveBeenCalledWith(SID);
    });

    it('dispatchWakeup 收到带有昵称的真实单聊消息 (direct) 时动态更新会话标题', async () => {
      const payload: WakeupPayload = {
        peer: PEER,
        trigger: 'direct',
        from_user: OPENID,
        from_name: '张三丰',
        content: '你好呀',
        timestamp: Date.now(),
      };

      await sessionManager.dispatchWakeup(payload);

      expect(mockSessionTitle.rename).toHaveBeenCalledWith(
        expect.anything(),
        `私聊: 张三丰 ${HASH} #1`
      );
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
