import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SessionManager } from '../../src/gateway/session.js';
import { DEFAULT_NEW_MESSAGE_BEHAVIOR } from '../../src/constants/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const OPENID_1 = '10000000000000000000000000000001';
const OPENID_2 = '10000000000000000000000000000002';
const OPENID_3 = '10000000000000000000000000000003';
const PEER_1 = openidToPeer(OPENID_1);
const PEER_2 = openidToPeer(OPENID_2);
const PEER_3 = openidToPeer(OPENID_3);
const SID_1 = openidToSessionBaseId(OPENID_1);
const SID_2 = openidToSessionBaseId(OPENID_2);
const SID_3 = openidToSessionBaseId(OPENID_3);

describe('契约测试: 运行中新消息行为模式 (New Message Behavior: Steer vs Queue)', () => {
  let tmpHome: string;
  let mockCtx: any;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `dsh-msg-behavior-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpHome, { recursive: true });

    mockCtx = {
      get: vi.fn(),
      logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
      config: {},
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('契约 1: 默认配置下 (DEFAULT_NEW_MESSAGE_BEHAVIOR === steer)，dispatchWakeup 优先调用 agent.steer 进行及时插话', async () => {
    expect(DEFAULT_NEW_MESSAGE_BEHAVIOR).toBe('steer');

    const steerSpy = vi.fn();
    const followupSpy = vi.fn();

    const mockAgent: any = {
      status: 'running',
      steer: steerSpy,
      followup: followupSpy,
      session: { id: SID_1 },
    };

    mockCtx.get = vi.fn((key: string) => {
      if (key === 'agents') {
        return {
          get: () => mockAgent,
          create: vi.fn().mockResolvedValue({ agent: mockAgent }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgent }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: PEER_1,
      from_user: OPENID_1,
      from_name: '测试用户1',
      content: '请中途插话处理',
      timestamp: Date.now(),
    });

    expect(userMsg).toBeDefined();
    expect(steerSpy).toHaveBeenCalledTimes(1);
    expect(steerSpy).toHaveBeenCalledWith(userMsg);
    expect(followupSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 2: 当通过 kujira-bridge-config 显式配置 new_message_behavior 为 queue 时，dispatchWakeup 调用 agent.followup 加入队列', async () => {
    const steerSpy = vi.fn();
    const followupSpy = vi.fn();

    const mockAgent: any = {
      status: 'running',
      steer: steerSpy,
      followup: followupSpy,
      session: { id: SID_2 },
    };

    mockCtx.get = vi.fn((key: string) => {
      if (key === 'kujira-bridge-config') {
        return () => ({ new_message_behavior: 'queue' });
      }
      if (key === 'agents') {
        return {
          get: () => mockAgent,
          create: vi.fn().mockResolvedValue({ agent: mockAgent }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgent }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: PEER_2,
      from_user: OPENID_2,
      from_name: '测试用户2',
      content: '排队等待处理',
      timestamp: Date.now(),
    });

    expect(userMsg).toBeDefined();
    expect(followupSpy).toHaveBeenCalledTimes(1);
    expect(followupSpy).toHaveBeenCalledWith(userMsg);
    expect(steerSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 3: 若 agent 实例未提供 steer 方法，自动降级调用 agent.followup', async () => {
    const followupSpy = vi.fn();

    const mockAgentWithoutSteer: any = {
      status: 'running',
      followup: followupSpy,
      session: { id: SID_3 },
    };

    mockCtx.config = {
      new_message_behavior: 'steer',
    };

    mockCtx.get = vi.fn((key: string) => {
      if (key === 'agents') {
        return {
          get: () => mockAgentWithoutSteer,
          create: vi.fn().mockResolvedValue({ agent: mockAgentWithoutSteer }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgentWithoutSteer }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'quote',
      peer: PEER_3,
      from_user: OPENID_3,
      from_name: '测试用户3',
      content: '无 steer 方法降级测试',
      timestamp: Date.now(),
    });

    expect(userMsg).toBeDefined();
    expect(followupSpy).toHaveBeenCalledTimes(1);
    expect(followupSpy).toHaveBeenCalledWith(userMsg);

    await sessionManager.dispose();
  });

  it('契约 4: 聚合批次（trigger=aggregated）即便 agent 运行中且配置 steer，也强制 followup 排队，绝不打断当前轮', async () => {
    const steerSpy = vi.fn();
    const followupSpy = vi.fn();

    const mockAgent: any = {
      status: 'running',
      steer: steerSpy,
      followup: followupSpy,
      session: { id: SID_1 },
    };

    mockCtx.config = { new_message_behavior: 'steer' };
    mockCtx.get = vi.fn((key: string) => {
      if (key === 'agents') {
        return {
          get: () => mockAgent,
          create: vi.fn().mockResolvedValue({ agent: mockAgent }),
          resume: vi.fn().mockResolvedValue({ agent: mockAgent }),
        };
      }
      return undefined;
    });

    const sessionManager = new SessionManager(mockCtx, tmpHome);

    const userMsg = await sessionManager.dispatchWakeup({
      trigger: 'aggregated',
      peer: PEER_1,
      from_user: OPENID_1,
      from_name: '',
      content: '[消息聚合]',
      timestamp: Date.now(),
      is_system: false,
      aggregated_messages: [{ short_id: 'msg_1', content: '在吗', time: Date.now() }],
    });

    expect(userMsg).toBeDefined();
    expect(steerSpy).not.toHaveBeenCalled();
    expect(followupSpy).toHaveBeenCalledTimes(1);
    expect(followupSpy).toHaveBeenCalledWith(userMsg);

    await sessionManager.dispose();
  });
});
