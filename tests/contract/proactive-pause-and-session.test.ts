/**
 * tests/contract/proactive-pause-and-session.test.ts
 *
 * 契约测试: 主动能力的暂停 / 活跃会话 / 审批解耦语义
 *
 * 覆盖规范清单:
 * 1. 等待用户输入时跳过唤醒：时钟继续走、标志保留，消息累积到下一轮；
 * 2. 恢复后由下一轮 tick 一并处理，绝不丢失消息；
 * 3. 活跃会话门控：聚合与冷场搭话均对「无活跃会话」尝试 ensureSession 后投递；
 * 4. 审批解耦：聚合轮次登记真实发起人（可审批），冷场搭话与定时任务保持 Fail-Closed。
 */

import { describe, it, expect, vi } from 'vitest';
import { ProactiveManager } from '../../src/gateway/proactive.js';
import { resolveWakeupInitiator } from '../../src/approval/turn-initiator.js';

const PEER = 'user_a1b2c3d4e5f60708';
const PEER_B = 'user_b1b2c3d4e5f60708';
const MOCK_OPENID = 'A1B2C3D4E5F60708A1B2C3D4E5F60708';

const BASE_CONFIG = {
  aggregation_enabled: true,
  aggregation_interval_mins: 2,
  idle_reply_enabled: true,
  idle_reply_timeout_mins: 60,
};

const T0 = 1_000_000;

function makeOptions(overrides: Record<string, any> = {}) {
  const { config: configOverride, now, ...rest } = overrides;
  return {
    ...rest,
    config: { ...BASE_CONFIG, ...(configOverride || {}) },
    now: now ?? T0,
  };
}

describe('契约 1: 等待用户输入时跳过唤醒，消息累积到下一轮', () => {
  it('暂停期间时钟照走但绝不投递，标志完整保留', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    // 建立相位
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    // 连续三轮到点，全部因等待输入而跳过
    for (let i = 1; i <= 3; i += 1) {
      await manager.checkProactive(
        makeOptions({ dispatch, now: T0 + i * 120_000, isAwaitingUserInput: () => true })
      );
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.hasPendingMessage(PEER)).toBe(true);
  });

  it('恢复后下一轮 tick 立即处理累积消息（不额外等待）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, isAwaitingUserInput: () => true })
    );

    // 恢复：因暂停期间时钟持续推进，下一轮即到点
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 240_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('暂停期间新到消息与旧消息一并由恢复后的 tick 处理（不丢消息）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, isAwaitingUserInput: () => true })
    );

    // 暂停期间又来了新消息
    manager.recordMessage(PEER);
    expect(manager.hasPendingMessage(PEER)).toBe(true);

    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 240_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');
  });

  it('暂停对每个 peer 独立生效：A 等待时 B 照常处理', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    manager.recordMessage(PEER_B);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    await manager.checkProactive(
      makeOptions({
        dispatch,
        now: T0 + 120_000,
        isAwaitingUserInput: (peer: string) => peer === PEER,
      })
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).peer).toBe(PEER_B);
    expect(manager.hasPendingMessage(PEER)).toBe(true);
  });

  it('暂停期间冷场搭话同样被抑制', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleOnly = { aggregation_enabled: false, idle_reply_enabled: true, idle_reply_timeout_mins: 60 };

    await manager.checkProactive(
      makeOptions({
        config: idleOnly,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        isAwaitingUserInput: () => true,
        now: T0,
      })
    );

    expect(dispatch).not.toHaveBeenCalled();

    // 暂停不消耗冷场周期，解除后同一沉默可立即唤醒
    await manager.checkProactive(
      makeOptions({
        config: idleOnly,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('idle_reply');
  });
});

describe('契约 2: 活跃会话门控', () => {
  it('聚合：无活跃会话时尝试 ensureSession，成功则投递', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const ensureSession = vi.fn(async () => true);

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, hasActiveSession: () => false, ensureSession })
    );

    expect(ensureSession).toHaveBeenCalledWith(PEER);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');
  });

  it('聚合：无活跃会话且 ensureSession 失败时跳过，标志已消费', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const ensureSession = vi.fn(async () => false);

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, hasActiveSession: () => false, ensureSession })
    );

    expect(ensureSession).toHaveBeenCalledWith(PEER);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('冷场搭话：有 peer 记录但无会话 → 建会话后搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const ensureSession = vi.fn(async () => true);
    const idleOnly = { aggregation_enabled: false, idle_reply_enabled: true, idle_reply_timeout_mins: 60 };

    await manager.checkProactive(
      makeOptions({
        config: idleOnly,
        dispatch,
        knownPeers: () => [PEER],
        hasActiveSession: () => false,
        ensureSession,
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );

    expect(ensureSession).toHaveBeenCalledWith(PEER);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('idle_reply');
  });

  it('冷场搭话：会话已存在时不重复创建', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const ensureSession = vi.fn(async () => true);
    const idleOnly = { aggregation_enabled: false, idle_reply_enabled: true, idle_reply_timeout_mins: 60 };

    await manager.checkProactive(
      makeOptions({
        config: idleOnly,
        dispatch,
        knownPeers: () => [PEER],
        hasActiveSession: () => true,
        ensureSession,
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );

    expect(ensureSession).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('契约 3: 聚合轮次的审批发起人解耦', () => {
  it('聚合投递（aggregated）登记真实发起人，使轮内审批/提问可用', () => {
    expect(resolveWakeupInitiator('aggregated', MOCK_OPENID)).toBe(MOCK_OPENID);
    expect(resolveWakeupInitiator('aggregated', PEER)).toBe(PEER);
  });

  it('冷场搭话与定时任务保持 Fail-Closed（系统自发，无真实发起人）', () => {
    for (const trigger of ['idle_reply', 'scheduled', 'proactive', 'idle']) {
      expect(resolveWakeupInitiator(trigger, MOCK_OPENID)).toBeNull();
    }
  });

  it('聚合触发但身份为系统伪身份时同样拒绝锚定（防提权）', () => {
    for (const pseudo of ['system', 'agent', 'self', 'SYSTEM', '', '   ', undefined, null]) {
      expect(resolveWakeupInitiator('aggregated', pseudo as any)).toBeNull();
    }
  });
});
