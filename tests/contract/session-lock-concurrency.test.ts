import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import {
  SessionManager,
  SessionAlreadyOwnedError,
  RemoteError,
} from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const PEER_1 = openidToPeer('10000000000000000000000000000001');
const SID_1 = openidToSessionBaseId('10000000000000000000000000000001');
const PEER_2 = openidToPeer('10000000000000000000000000000002');
const SID_2 = openidToSessionBaseId('10000000000000000000000000000002');
const PEER_3 = openidToPeer('10000000000000000000000000000003');
const SID_3 = openidToSessionBaseId('10000000000000000000000000000003');
const PEER_4 = openidToPeer('10000000000000000000000000000004');
const SID_4 = openidToSessionBaseId('10000000000000000000000000000004');
const PEER_5 = openidToPeer('10000000000000000000000000000012');
const SID_5 = openidToSessionBaseId('10000000000000000000000000000012');

describe('契约测试: DSH 会话排他锁、退避重试、live agent 复用不抢占与 Web UI 只读守护 (Session Lock & Concurrency Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let db: MessageDatabase | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-lock-concurrency-'));
  });

  afterEach(async () => {
    if (db) {
      db.close();
      db = null;
    }
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 捕获 SessionAlreadyOwnedError 进行 3 次退避重试，耗尽后抛出明确提示且绝不调用 agents.create', async () => {
    const ctx = new Context();
    let resumeAttempts = 0;
    let createAttempts = 0;

    const mockAgents = {
      get: vi.fn().mockReturnValue(undefined),
      resume: vi.fn().mockImplementation(async (opts: any) => {
        resumeAttempts++;
        throw new SessionAlreadyOwnedError(opts.resumeSessionId);
      }),
      create: vi.fn().mockImplementation(async () => {
        createAttempts++;
        return { agent: { session: { id: 'test' } }, dispose: async () => {} };
      }),
    };
    (ctx as any).agents = mockAgents;

    const sessionManager = new SessionManager(ctx, tmpHome, undefined, {
      retryDelays: [10, 20, 30],
    });

    await expect(sessionManager.getOrCreateAgent(PEER_1)).rejects.toThrow(
      new RegExp(`会话 ${SID_1} 当前正被其他控制台或任务占用（排他锁冲突）`)
    );

    expect(resumeAttempts).toBe(3);
    expect(createAttempts).toBe(0);
    expect(mockAgents.create).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 2: 前置重试捕获 SessionAlreadyOwnedError，后续重试锁释放成功恢复会话', async () => {
    const ctx = new Context();
    let resumeAttempts = 0;
    const fakeSession = { id: SID_2 };
    const fakeAgent = { session: fakeSession, cancel: vi.fn() };
    const fakeHandle = { agent: fakeAgent, dispose: vi.fn() };

    const mockAgents = {
      get: vi.fn().mockReturnValue(undefined),
      resume: vi.fn().mockImplementation(async (opts: any) => {
        resumeAttempts++;
        if (resumeAttempts < 3) {
          throw new SessionAlreadyOwnedError(opts.resumeSessionId);
        }
        return fakeHandle;
      }),
      create: vi.fn(),
    };
    (ctx as any).agents = mockAgents;

    const sessionManager = new SessionManager(ctx, tmpHome, undefined, {
      retryDelays: [10, 20, 30],
    });

    const agent = await sessionManager.getOrCreateAgent(PEER_2);
    expect(agent).toBe(fakeAgent);
    expect(resumeAttempts).toBe(3);
    expect(sessionManager.hasActiveHandle(SID_2)).toBe(true);
    expect(sessionManager.getActiveHandle(SID_2)).toBe(fakeHandle);
    expect(mockAgents.create).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 3: 内存中存在 live agent（bare Agent，无 handle）时只复用：绝不 cancel 在途回合、绝不重建会话', async () => {
    const ctx = new Context();
    const oldCancelMock = vi.fn();
    const fakeLiveAgent = {
      id: SID_3,
      session: { id: SID_3 },
      status: 'running',
      cancel: oldCancelMock,
      followup: vi.fn(),
    };

    const agentStore = new Map<string, any>([[SID_3, fakeLiveAgent]]);

    const mockAgents = {
      get: vi.fn().mockImplementation((id: string) => agentStore.get(id)),
      resume: vi.fn(),
      create: vi.fn(),
    };
    (ctx as any).agents = mockAgents;

    const sessionManager = new SessionManager(ctx, tmpHome, undefined, {
      retryDelays: [10, 20, 30],
    });

    expect(sessionManager.hasActiveHandle(SID_3)).toBe(false);

    const agent = await sessionManager.getOrCreateAgent(PEER_3);

    expect(agent).toBe(fakeLiveAgent);
    expect(oldCancelMock).not.toHaveBeenCalled();
    expect(mockAgents.resume).not.toHaveBeenCalled();
    expect(mockAgents.create).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 4: Web UI 只读锁定与拦截守护：QQ Kujira 独占活跃时拒绝 Web prompt 并返回标准 RemoteError', async () => {
    const ctx = new Context();
    const fakeAgent = { id: SID_4, session: { id: SID_4 }, cancel: vi.fn() };
    const fakeHandle = { agent: fakeAgent, dispose: vi.fn() };

    (ctx as any).agents = {
      get: vi.fn().mockReturnValue(undefined),
      resume: vi.fn().mockResolvedValue(fakeHandle),
      create: vi.fn(),
    };

    const originalPromptMock = vi.fn().mockResolvedValue({ accepted: true });
    const mockSessionController = {
      prompt: originalPromptMock,
    };
    (ctx as any).sessionController = mockSessionController;

    const sessionManager = new SessionManager(ctx, tmpHome);

    const preResult = await mockSessionController.prompt({
      sessionId: SID_4,
      content: [{ type: 'text', text: 'hi from web' }],
    });
    expect(preResult).toEqual({ accepted: true });
    expect(originalPromptMock).toHaveBeenCalledTimes(1);

    await sessionManager.getOrCreateAgent(PEER_4);
    expect(sessionManager.hasActiveHandle(SID_4)).toBe(true);

    let thrownError: any = null;
    try {
      await mockSessionController.prompt({
        sessionId: SID_4,
        content: [{ type: 'text', text: 'hi again from web' }],
      });
    } catch (err: any) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError).toBeInstanceOf(RemoteError);
    expect(thrownError.code).toBe('session/agent-busy');
    expect(thrownError.isDSHRemoteError).toBe(true);
    expect(thrownError.message).toContain('该会话当前正由 QQ Kujira 独占使用中，Web 端处于只读监视模式');
    expect(originalPromptMock).toHaveBeenCalledTimes(1);

    await sessionManager.releaseActiveHandle(SID_4);
    expect(sessionManager.hasActiveHandle(SID_4)).toBe(false);

    const postResult = await mockSessionController.prompt({
      sessionId: SID_4,
      content: [{ type: 'text', text: 'hi after qq released' }],
    });
    expect(postResult).toEqual({ accepted: true });
    expect(originalPromptMock).toHaveBeenCalledTimes(2);

    await sessionManager.dispose();
  });

  it('契约 5: 真实装配路径下 SessionManager 守卫 sessionController.prompt 拦截闭环验证', async () => {
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    const sessionManager = new SessionManager(booted.ctx, tmpHome);

    const realPromptMock = vi.fn().mockResolvedValue({ accepted: true });
    (booted.ctx as any).sessionController = {
      prompt: realPromptMock,
    };
    sessionManager.guardSessionController();

    const agent = await sessionManager.getOrCreateAgent(PEER_5);
    expect(agent.session.id).toBe(SID_5);
    expect(sessionManager.hasActiveHandle(SID_5)).toBe(true);

    await expect(
      (booted.ctx as any).sessionController.prompt({
        sessionId: SID_5,
        content: [{ type: 'text', text: 'interception test' }],
      })
    ).rejects.toThrow(RemoteError);

    await sessionManager.dispose();
  });
});
