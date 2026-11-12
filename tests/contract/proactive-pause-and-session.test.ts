/**
 * tests/contract/proactive-pause-and-session.test.ts
 *
 * 契约测试: 主动能力的三项关键语义 (Pause / Active Session / Approval Decoupling)
 *
 * 覆盖规范清单:
 * 1. 等待用户输入时暂停计时：提问或审批挂起期间，聚合窗口与冷场计时双双冻结；
 * 2. 恢复后重置计时：用户回答/审批完成后，从此刻重新累计完整窗口，绝不立即误触发；
 * 3. 暂停不丢消息：暂停期间到达的消息照常入池，恢复后一并投递；
 * 4. 活跃会话判定：仅当该 peer 存在当前活跃会话时才参与巡检，无活跃会话的 peer 一律跳过；
 * 5. 审批解耦：聚合轮次登记真实发起人（可审批），冷场搭话与定时任务保持 Fail-Closed。
 */

import { describe, it, expect, vi } from 'vitest';
import { ProactiveManager } from '../../src/gateway/proactive.js';
import { resolveWakeupInitiator } from '../../src/approval/turn-initiator.js';
import type { AggregatedMessage } from '../../src/types/wakeup.js';

const PEER = 'user_a1b2c3d4e5f60708';
const PEER_B = 'user_b1b2c3d4e5f60708';
const MOCK_OPENID = 'A1B2C3D4E5F60708A1B2C3D4E5F60708';

function msg(shortId: string, content: string, time: number): AggregatedMessage {
  return { short_id: shortId, content, time };
}

const BASE_CONFIG = {
  aggregation_enabled: true,
  aggregation_interval_mins: 2,
  idle_reply_enabled: true,
  idle_reply_timeout_mins: 60,
};

function makeOptions(overrides: Record<string, any> = {}) {
  return {
    config: { ...BASE_CONFIG, ...(overrides.config || {}) },
    now: overrides.now ?? 1_000_000,
    ...overrides,
  };
}

describe('契约 1: 等待用户输入时暂停计时', () => {
  it('提问/审批挂起期间聚合窗口冻结：即使远超窗口时长也绝不投递', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_11', '在吗', now), BASE_CONFIG);

    // 挂起状态：多轮巡检（远超 2 分钟窗口）均不得投递
    const awaiting = () => true;
    await manager.checkProactive(
      makeOptions({ now: now + 5 * 60 * 1000, dispatch, isAwaitingUserInput: awaiting })
    );
    await manager.checkProactive(
      makeOptions({ now: now + 30 * 60 * 1000, dispatch, isAwaitingUserInput: awaiting })
    );
    expect(dispatch).not.toHaveBeenCalled();

    // 恢复：从恢复时刻重新累计完整窗口
    await manager.checkProactive(
      makeOptions({ now: now + 31 * 60 * 1000, dispatch, isAwaitingUserInput: () => false })
    );
    expect(dispatch).not.toHaveBeenCalled(); // 刚恢复，窗口才刚开始

    await manager.checkProactive(
      makeOptions({ now: now + 33 * 60 * 1000, dispatch, isAwaitingUserInput: () => false })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');
  });

  it('提问/审批挂起期间冷场计时同样冻结，绝不在等用户时主动搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordHumanMessage(PEER, now);

    // 挂起期间沉默远超 60 分钟阈值
    await manager.checkProactive(
      makeOptions({ now: now + 120 * 60 * 1000, dispatch, isAwaitingUserInput: () => true })
    );
    expect(dispatch).not.toHaveBeenCalled();

    // 恢复后需重新累计 60 分钟，而非立即触发
    await manager.checkProactive(
      makeOptions({ now: now + 121 * 60 * 1000, dispatch, isAwaitingUserInput: () => false })
    );
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({ now: now + 181 * 60 * 1000, dispatch, isAwaitingUserInput: () => false })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('idle_reply');
  });

  it('暂停期间到达的消息照常入池，恢复后一次性投递（绝不因暂停而丢消息）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_21', '第一条', now), BASE_CONFIG);
    await manager.checkProactive(
      makeOptions({ now: now + 5 * 60 * 1000, dispatch, isAwaitingUserInput: () => true })
    );

    // 暂停期间继续来消息
    manager.recordMessage(PEER, msg('msg_22', '第二条', now + 6 * 60 * 1000), BASE_CONFIG);
    expect(manager.getPendingMessages(PEER)).toHaveLength(2);

    // 恢复后满窗口一次性投递两条
    await manager.checkProactive(
      makeOptions({ now: now + 9 * 60 * 1000, dispatch, isAwaitingUserInput: () => false })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.messages).toHaveLength(2);
    expect(event.messages.map((m: any) => m.short_id)).toEqual(['msg_21', 'msg_22']);
  });

  it('暂停对每个 peer 独立生效：A 在等待时 B 照常巡检', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_31', 'A 的消息', now), BASE_CONFIG);
    manager.recordMessage(PEER_B, msg('msg_32', 'B 的消息', now), BASE_CONFIG);

    await manager.checkProactive(
      makeOptions({
        now: now + 3 * 60 * 1000,
        dispatch,
        isAwaitingUserInput: (peer: string) => peer === PEER,
      })
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.peer).toBe(PEER_B);
  });
});

describe('契约 2: 活跃会话判定门控', () => {
  it('无活跃会话的 peer 一律跳过，绝不向已归档/不存在的会话投递', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_41', '在吗', now), BASE_CONFIG);
    manager.recordHumanMessage(PEER_B, now);

    await manager.checkProactive(
      makeOptions({
        now: now + 120 * 60 * 1000,
        dispatch,
        hasActiveSession: () => false,
      })
    );

    expect(dispatch).not.toHaveBeenCalled();
    // 池内消息保留，待会话恢复活跃后再投递
    expect(manager.getPendingMessages(PEER)).toHaveLength(1);
  });

  it('活跃会话恢复后，池内保留的消息照常投递', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_51', '在吗', now), BASE_CONFIG);

    await manager.checkProactive(
      makeOptions({ now: now + 3 * 60 * 1000, dispatch, hasActiveSession: () => false })
    );
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({ now: now + 4 * 60 * 1000, dispatch, hasActiveSession: () => true })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).peer).toBe(PEER);
  });

  it('未提供 hasActiveSession 时保持向后兼容（默认放行，不阻断既有调用方）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_61', '在吗', now), BASE_CONFIG);
    await manager.checkProactive(makeOptions({ now: now + 3 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('契约 3: 聚合轮次的审批发起人解耦', () => {
  it('聚合投递（aggregated）应登记真实发起人，使聚合轮次内可正常审批', () => {
    expect(resolveWakeupInitiator('aggregated', MOCK_OPENID)).toBe(MOCK_OPENID);
    expect(resolveWakeupInitiator('aggregated', PEER)).toBe(PEER);
  });

  it('冷场搭话与定时任务仍保持 Fail-Closed（系统自发，无真实发起人）', () => {
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
