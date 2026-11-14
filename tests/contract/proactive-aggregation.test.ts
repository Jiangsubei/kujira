/**
 * tests/contract/proactive-aggregation.test.ts
 *
 * 契约测试: 单聊消息聚合回复与冷场主动搭话 (Kujira Proactive Aggregation & Idle Reply)
 *
 * 仿生时序与事件驱动基线：
 * - **纯内存消息池**：池只装尚未投递的真实入站消息，投递成功后清空；
 * - **Peer 独立事件驱动**：彻底废弃全局固定周期时钟，每 Peer 独立维护时钟与下限锁定状态；
 * - **温和折减与下限锁定**：周期内新消息温和折减 25% 剩余时间；一旦触及底限锁定，后续新消息绝不推迟；
 * - **高热度秒回**：开启 instant_reply_enabled 且高活跃度时支持即刻唤醒；
 * - **仿生潜水主动搭话**：在随机区间 [T_idle_min, T_idle_max] 内采样潜水目标时刻唤醒。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ProactiveManager,
  shouldPoolInbound,
  type CompletedTurnSummary,
} from '../../src/gateway/proactive.js';
import { formatSystemEventPrompt } from '../../src/gateway/system-event-hub.js';
import { formatWakeupPrompt } from '../../src/gateway/external-prompt.js';
import { DEFAULT_BASE_CONFIG } from '../../src/constants/index.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';

const PEER = 'user_a1b2c3d4e5f60708';
const PEER_B = 'user_b1b2c3d4e5f60708';

const BASE_CONFIG = {
  aggregation_enabled: true,
  aggregation_min_seconds: 10,
  aggregation_max_seconds: 60,
  idle_reply_enabled: true,
  idle_reply_min_mins: 30,
  idle_reply_max_mins: 120,
  proactive_attitude: 'balanced' as const,
  instant_reply_enabled: false,
};

/** T0：基准时刻。时序以此起算。 */
const T0 = 1_000_000;

/** 构造一条入池消息（池只收集未投递的真实入站消息） */
function msg(text = '测试消息', time = T0) {
  return { content: text, time };
}

function makeOptions(overrides: Record<string, any> = {}) {
  const { config: configOverride, now, ...rest } = overrides;
  return {
    ...rest,
    config: { ...BASE_CONFIG, ...(configOverride || {}) },
    now: now ?? T0,
  };
}

describe('契约 1: 内存消息池按序收集周期内未投递消息', () => {
  it('入站消息按时间顺序入池，内容原样保留（含短 ID / 引用 / 附件）', () => {
    const manager = new ProactiveManager();
    const first = { short_id: 'msg_1', content: '在吗', time: T0 };
    const second = {
      short_id: 'msg_2',
      content: '那个接口一直 403',
      time: T0 + 1000,
      quoted: { text: '前文' },
      attachments: ['[图片: /tmp/a.png]'],
    };

    manager.recordMessage(PEER, first, 'OPENID_1');
    manager.recordMessage(PEER, second, 'OPENID_1');

    expect(manager.hasPendingMessage(PEER)).toBe(true);
    expect(manager.getPendingMessages(PEER)).toEqual([first, second]);
    expect(manager.getLastFromUser(PEER)).toBe('OPENID_1');
  });

  it('按 peer 严格隔离', () => {
    const manager = new ProactiveManager();
    manager.recordMessage(PEER, msg());

    expect(manager.hasPendingMessage(PEER)).toBe(true);
    expect(manager.hasPendingMessage(PEER_B)).toBe(false);
    expect(manager.getPendingMessages(PEER_B)).toEqual([]);
  });

  it('快照是副本，外部修改不影响池内状态', () => {
    const manager = new ProactiveManager();
    manager.recordMessage(PEER, msg('原始内容'));

    const snapshot = manager.getPendingMessages(PEER);
    snapshot[0]!.content = '被外部改写';

    expect(manager.getPendingMessages(PEER)[0]!.content).toBe('原始内容');
  });
});

describe('契约 2: 基于 Peer 独立的事件驱动仿生时序器与动态折减', () => {
  it('首条入站事件驱动启动时序器，采样 [min, max] 设定 targetWakeupAt 与 floorWakeupAt', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    // rng 返回 0.5，平衡偏好下 (10 + 50 * 0.5) = 35s = 35_000ms
    manager.recordMessage(PEER, msg('测试消息', T0), undefined, { rng: () => 0.5 });

    const timing = manager.getPeerTiming(PEER);
    expect(timing).not.toBeNull();
    expect(timing!.cycleStartTime).toBe(T0);
    expect(timing!.floorWakeupAt).toBe(T0 + 10_000);
    expect(timing!.targetWakeupAt).toBe(T0 + 35_000);
    expect(timing!.isFloorLocked).toBe(false);

    // 未到点（30秒后），不触发唤醒
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 30_000 }));
    expect(dispatch).not.toHaveBeenCalled();

    // 到点（35秒后），触发一次聚合唤醒并清空时钟与池
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 35_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('aggregated_messages');
    expect(event.peer).toBe(PEER);
    expect(event.reason).toBe('period');
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0].content).toBe('测试消息');

    expect(manager.hasPendingMessage(PEER)).toBe(false);
    expect(manager.getPeerTiming(PEER)?.cycleStartTime).toBeNull();
    expect(manager.getPeerTiming(PEER)?.targetWakeupAt).toBeNull();
  });

  it('周期内追加新消息执行温和折减 25% 剩余时间', async () => {
    const manager = new ProactiveManager();
    // 初始采样 target = T0 + 35_000, floor = T0 + 10_000
    manager.recordMessage(PEER, msg('第一条', T0), undefined, { rng: () => 0.5 });

    // 在 T0 + 5_000 追加新消息：距目标尚余 30_000ms，折减 25% 后余 22_500ms
    // 新目标时刻 = T0 + 5_000 + 22_500 = T0 + 27_500
    manager.recordMessage(PEER, msg('第二条', T0 + 5_000));

    const timing = manager.getPeerTiming(PEER);
    expect(timing!.targetWakeupAt).toBe(T0 + 27_500);
    expect(timing!.floorWakeupAt).toBe(T0 + 10_000);
    expect(timing!.isFloorLocked).toBe(false);
  });

  it('触底下限锁定：多次折减触及底限后锁定，后续持续追加绝不推迟', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    // 初始采样设定一个较紧凑的初始等待：T0 + 14_000, floor = T0 + 10_000
    manager.recordMessage(PEER, msg('第一条', T0), undefined, { rng: () => 0.08 });
    expect(manager.getPeerTiming(PEER)!.targetWakeupAt).toBe(T0 + 14_000);
    expect(manager.getPeerTiming(PEER)!.isFloorLocked).toBe(false);

    // 在 T0 + 2_000 追加：余 12_000ms，折减 25% 剩 9_000ms，新目标 = T0 + 11_000
    manager.recordMessage(PEER, msg('第二条', T0 + 2_000));
    expect(manager.getPeerTiming(PEER)!.targetWakeupAt).toBe(T0 + 11_000);
    expect(manager.getPeerTiming(PEER)!.isFloorLocked).toBe(false);

    // 在 T0 + 4_000 追加：余 7_000ms，折减 25% 剩 5_250ms，新目标 = T0 + 9_250 <= floor (T0 + 10_000)
    // 触底锁定！
    manager.recordMessage(PEER, msg('第三条', T0 + 4_000));
    const timingLocked = manager.getPeerTiming(PEER);
    expect(timingLocked!.isFloorLocked).toBe(true);
    expect(timingLocked!.targetWakeupAt).toBe(T0 + 10_000);

    // 触底锁定后，用户继续连发消息（在 T0 + 6_000, T0 + 8_000）：绝不推迟，目标时刻锁定不动！
    manager.recordMessage(PEER, msg('第四条', T0 + 6_000));
    manager.recordMessage(PEER, msg('第五条', T0 + 8_000));
    const timingAfter = manager.getPeerTiming(PEER);
    expect(timingAfter!.isFloorLocked).toBe(true);
    expect(timingAfter!.targetWakeupAt).toBe(T0 + 10_000);
    expect(manager.getPendingMessages(PEER)).toHaveLength(5);

    // 未到底限时刻（T0 + 9_999）不投递
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 9_999 }));
    expect(dispatch).not.toHaveBeenCalled();

    // 到底限时刻（T0 + 10_000）立即自然释放投递全部 5 条消息
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 10_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.messages).toHaveLength(5);
    expect(manager.hasPendingMessage(PEER)).toBe(false);
  });

  it('秒回机制：开启 instant_reply_enabled 且高活跃度时触发秒回（targetWakeupAt = now）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const instantConfig = {
      ...BASE_CONFIG,
      instant_reply_enabled: true,
      proactive_attitude: 'enthusiastic' as const,
    };

    // 模拟连聊高热度微观时延 2 秒，宏观动量 1.0
    const recentTurns: CompletedTurnSummary[] = [
      { inboundAt: T0 - 2000, lastBotOutboundAt: T0 - 4000, messageCount: 3 },
    ];
    manager.recordMessage(PEER, msg('热聊消息', T0), undefined, {
      config: instantConfig,
      lastBotOutboundAt: T0 - 2000,
      recentTurns,
      rng: () => 0.1, // 保证命中秒回判定
    });

    const timing = manager.getPeerTiming(PEER);
    expect(timing!.targetWakeupAt).toBe(T0);
    expect(timing!.isFloorLocked).toBe(true);

    // checkProactive 在当前时刻即可触发投递，突破硬底线
    await manager.checkProactive(makeOptions({ config: instantConfig, dispatch, now: T0 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).reason).toBe('period');
  });

  it('秒回机制：关闭 instant_reply_enabled 时即使高活跃度也走常规等待', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const configNoInstant = {
      ...BASE_CONFIG,
      instant_reply_enabled: false,
    };

    manager.recordMessage(PEER, msg('消息', T0), undefined, {
      config: configNoInstant,
      lastBotOutboundAt: T0 - 1000,
      rng: () => 0.1,
    });

    const timing = manager.getPeerTiming(PEER);
    // 不秒回，targetWakeupAt 严格 >= floorWakeupAt (T0 + 10_000)
    expect(timing!.targetWakeupAt).toBeGreaterThanOrEqual(T0 + 10_000);

    // 在 T0 调用不触发
    await manager.checkProactive(makeOptions({ config: configNoInstant, dispatch, now: T0 }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('按 Peer 严格隔离独立时钟与下限锁定状态', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    // Peer A 收到消息启动时钟
    manager.recordMessage(PEER, msg('A1', T0), undefined, { rng: () => 0.5 });
    expect(manager.getPeerTiming(PEER)?.targetWakeupAt).toBe(T0 + 35_000);
    // Peer B 此时池空无时序状态
    expect(manager.getPeerTiming(PEER_B)).toBeNull();

    // Peer B 在 T0 + 10_000 收到消息，独立启动时钟（基于 T0 + 10_000）
    manager.recordMessage(PEER_B, msg('B1', T0 + 10_000), undefined, { rng: () => 0.5 });
    expect(manager.getPeerTiming(PEER_B)?.targetWakeupAt).toBe(T0 + 10_000 + 35_000);

    // Peer A 到点 T0 + 35_000 投递，Peer B 仍未到点
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 35_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).peer).toBe(PEER);
    expect(manager.hasPendingMessage(PEER)).toBe(false);
    expect(manager.hasPendingMessage(PEER_B)).toBe(true);
  });

  it('池为空时空转 tick 不唤醒且不消耗任何资源', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('契约 3: 等待用户输入时跳过唤醒，但消息保留到下一轮', () => {
  it('暂停期间到点不唤醒，标志保留', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg());
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, isAwaitingUserInput: () => true })
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.hasPendingMessage(PEER)).toBe(true);
  });

  it('恢复后下一轮 tick 处理累积的新消息', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg());
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, isAwaitingUserInput: () => true })
    );

    // 恢复后下一轮
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 240_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');
  });

  it('暂停对每个 peer 独立生效', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg());
    manager.recordMessage(PEER_B, msg());
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
  });
});

describe('契约 4: 活跃会话门控', () => {
  it('聚合：无活跃会话时不唤醒，标志保留', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg());
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, hasActiveSession: () => false })
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.hasPendingMessage(PEER)).toBe(true);
  });

  it('会话恢复后由后续 tick 处理', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg());
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, hasActiveSession: () => false })
    );
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 240_000, hasActiveSession: () => true })
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('未提供 hasActiveSession 时默认放行（向后兼容）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg());
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('契约 5: 冷场主动搭话', () => {
  it('开关关闭时沉默再久也不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = { ...BASE_CONFIG, aggregation_enabled: false, idle_reply_enabled: false };

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 10 * 3600 * 1000,
        now: T0,
      })
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('仿生潜水搭话在 [T_idle_min, T_idle_max] 内随机采样，未达目标时刻不搭话，达到则触发一次', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_min_mins: 30,
      idle_reply_max_mins: 120,
    };
    // rng 返回 0 采样下限 30 分钟 (1,800,000ms)
    // 用户最后发信于 T0
    const humanAt = T0;
    const opts = (now: number) =>
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => humanAt,
        now,
        rng: () => 0,
      });

    // 沉默 29 分钟：未达目标时刻
    await manager.checkProactive(opts(T0 + 29 * 60 * 1000));
    expect(dispatch).not.toHaveBeenCalled();

    // 沉默满 30 分钟：达到潜水目标时刻，触发搭话
    await manager.checkProactive(opts(T0 + 30 * 60 * 1000));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('idle_reply');
    expect(event.idleMinutes).toBe(30);
  });

  it('未满一个采样冷场周期不重复唤醒；满一个周期且用户仍无入站则再次唤醒', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_min_mins: 60,
      idle_reply_max_mins: 60,
    };
    const periodMs = 60 * 60 * 1000;
    const opts = (now: number) =>
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now,
      });

    await manager.checkProactive(opts(T0));
    await manager.checkProactive(opts(T0 + periodMs - 1));
    expect(dispatch).toHaveBeenCalledTimes(1);

    await manager.checkProactive(opts(T0 + periodMs));
    expect(dispatch).toHaveBeenCalledTimes(2);

    await manager.checkProactive(opts(T0 + 2 * periodMs - 1));
    expect(dispatch).toHaveBeenCalledTimes(2);

    await manager.checkProactive(opts(T0 + 2 * periodMs));
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.every((call) => (call[0] as any).kind === 'idle_reply')).toBe(true);
  });

  it('recordMessage 不得缩短冷场周期：冷却未满时即便沉默起点仍超阈值也不提前再唤醒', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_min_mins: 60,
      idle_reply_max_mins: 60,
    };
    const opts = (now: number) =>
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now,
      });

    await manager.checkProactive(opts(T0));
    manager.recordMessage(PEER, msg());
    await manager.checkProactive(opts(T0 + 1000));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('人类新入站把沉默起点前移后，须重新沉默满一个周期才再唤醒', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_min_mins: 60,
      idle_reply_max_mins: 60,
    };
    const periodMs = 60 * 60 * 1000;
    const humanAt = T0 + 10 * 60 * 1000;

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);

    manager.recordMessage(PEER, msg());

    // 距上次唤醒已满一个周期，但新的入站沉默只有 50 分钟
    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => humanAt,
        now: T0 + periodMs,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);

    // 从新入站时刻再沉默满一个周期
    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => humanAt,
        now: humanAt + periodMs,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('有待处理新消息时优先聚合，绝不叠加搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg(), undefined, { rng: () => 0 });
    await manager.checkProactive(
      makeOptions({
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );
    // 未到点（10s）
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0 + 10_000,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');
  });

  it('无任何 peer 记录时不搭话（绝不骚扰从未出现过的 User）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    await manager.checkProactive(
      makeOptions({ dispatch, knownPeers: () => [], lastHumanMessageAt: () => null, now: T0 })
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('有 peer 记录但无活跃会话 → 尝试建立会话后搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const ensureSession = vi.fn(async () => true);
    const idleConfig = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_min_mins: 60,
      idle_reply_max_mins: 60,
    };

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
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

  it('建立会话失败则不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_min_mins: 60,
      idle_reply_max_mins: 60,
    };

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        hasActiveSession: () => false,
        ensureSession: () => false,
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );
    expect(dispatch).not.toHaveBeenCalled();

    // 失败不消耗冷场周期，下一轮巡检可立即重试
    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        hasActiveSession: () => false,
        ensureSession: () => true,
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0 + 1000,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('idle_reply');
  });
});

describe('契约 6: 两个开关完全解耦', () => {
  it('仅开聚合：不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const config = {
      ...BASE_CONFIG,
      aggregation_enabled: true,
      aggregation_min_seconds: 10,
      aggregation_max_seconds: 60,
      idle_reply_enabled: false,
    };

    manager.recordMessage(PEER, msg(), undefined, { rng: () => 0 });
    await manager.checkProactive(makeOptions({ config, dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ config, dispatch, now: T0 + 10_000 }));
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');

    await manager.checkProactive(
      makeOptions({
        config,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => 0,
        now: T0 + 10 * 3600 * 1000,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('仅开搭话：聚合不触发，冷场照常搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const config = {
      ...BASE_CONFIG,
      aggregation_enabled: false,
      idle_reply_enabled: true,
      idle_reply_min_mins: 60,
      idle_reply_max_mins: 60,
    };

    manager.recordMessage(PEER, msg());
    await manager.checkProactive(makeOptions({ config, dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ config, dispatch, now: T0 + 10 * 3600 * 1000 }));
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({
        config,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0 + 10 * 3600 * 1000,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('idle_reply');
  });
});

describe('契约 7: 聚合提示词逐条列出消息，保留 read_chat_history 可选回溯', () => {
  const PERIOD_TS = new Date(2026, 10, 13, 14, 5, 0).getTime();
  const MESSAGES = [
    { short_id: 'msg_12', content: '在吗', time: PERIOD_TS - 60_000 },
    {
      short_id: 'msg_13',
      content: '那个接口一直 403',
      time: PERIOD_TS - 30_000,
      quoted: { short_id: 'msg_10', time: PERIOD_TS - 90_000, text: '前文' },
      attachments: ['[图片: /tmp/a.png]'],
    },
  ];

  it('周期投递：逐条列出短 ID、时间、引用与附件，且提示 read_chat_history 可选回溯', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      messages: MESSAGES,
      reason: 'period',
      intervalMinutes: 2,
      timestamp: PERIOD_TS,
    });

    expect(prompt).toContain('系统事件');
    expect(prompt).toMatch(/2026-11-13 14:05:00/);
    expect(prompt).toMatch(/1\.\s*\[msg_12\]/);
    expect(prompt).toMatch(/2\.\s*\[msg_13\]/);
    // 纯文本消息：正文与消息头同一行，与正常直接入站消息的格式一致
    expect(prompt).toMatch(/1\. \[msg_12\] \[2026-11-13 14:04:00\] 在吗/);
    expect(prompt).not.toMatch(/\[msg_12\][^\n]*\n\s*在吗/);
    // 带引用/附件的消息：消息头独占一行，引用、附件、正文依次另起行
    expect(prompt).toMatch(/2\. \[msg_13\] \[2026-11-13 14:04:30\]\n/);
    expect(prompt).toContain('在吗');
    expect(prompt).toContain('那个接口一直 403');
    expect(prompt).toContain('[引用回复:');
    expect(prompt).toContain('[图片: /tmp/a.png]');
    expect(prompt).toContain('read_chat_history');
    expect(prompt).toContain('[结束]');

    // 绝不泄露 peer、长锚点或渠道前缀
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain(PEER);
    expect(prompt).not.toContain('ROBOT1.0');
    expect(prompt).not.toContain('群聊');
  });

  it('turn_end 投递：使用「上一轮处理期间」语义并引导避免重复回复', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      messages: MESSAGES,
      reason: 'turn_end',
      timestamp: PERIOD_TS,
    });

    expect(prompt).toContain('上一轮处理期间');
    expect(prompt).toMatch(/你上一条回复覆盖|已经回应过/);
    expect(prompt).toContain('直接输出 [结束]');
    expect(prompt).toContain('read_chat_history');
  });

  it('无消息的历史调用仍回落到「有新消息待查看」提示', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      intervalMinutes: 2,
      timestamp: PERIOD_TS,
    });

    expect(prompt).toContain('系统事件');
    expect(prompt).toContain('read_chat_history');
    expect(prompt).toContain('[结束]');
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain(PEER);
    expect(prompt).not.toContain('ROBOT1.0');
    expect(prompt).not.toContain('[msg_');
  });

  it('冷场搭话提示词为系统事件语义，不含真实用户消息内容', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'idle_reply',
      peer: PEER,
      idleMinutes: 60,
      timestamp: PERIOD_TS,
    });

    expect(prompt).toContain('系统事件');
    expect(prompt).toContain('60');
    expect(prompt).toMatch(/send_qq_message/);
    expect(prompt).toMatch(/read_chat_history/);
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain(PEER);
    expect(prompt).toMatch(/\[结束\]/);
  });
});

describe('契约 8: 唤醒提示词统一入口正确分派两类新事件', () => {
  it('aggregated / idle_reply 均经 formatWakeupPrompt 分派到系统事件格式化', () => {
    const aggregated = formatWakeupPrompt({
      peer: PEER,
      trigger: 'aggregated',
      from_user: '',
      from_name: '',
      content: '',
      timestamp: 1_000_000,
      is_system: true,
      system_event: { kind: 'aggregated_messages', peer: PEER, intervalMinutes: 2 },
    });
    expect(aggregated).toContain('read_chat_history');
    expect(aggregated).not.toContain('[QQ私聊]');

    const idle = formatWakeupPrompt({
      peer: PEER,
      trigger: 'idle_reply',
      from_user: '',
      from_name: '',
      content: '',
      timestamp: 1_000_000,
      is_system: true,
      system_event: { kind: 'idle_reply', peer: PEER, idleMinutes: 60 },
    });
    expect(idle).toContain('系统事件');
    expect(idle).not.toContain('[QQ私聊]');
  });
});

describe('契约 10: 投递成功后清空，失败保留，投递期间新到不被误清', () => {
  it('dispatch 抛错时整批保留，下一次 tick 重试成功后才清空', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {
      throw new Error('boom');
    });
    manager.recordMessage(PEER, msg('第一条'));

    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(manager.hasPendingMessage(PEER)).toBe(true);

    dispatch.mockImplementation(async () => {});
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 240_000 }));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(manager.hasPendingMessage(PEER)).toBe(false);
  });

  it('投递期间新到的消息不被误清，留待下一次投递', async () => {
    const manager = new ProactiveManager();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batches: string[][] = [];
    const dispatch = vi.fn(async (event: any) => {
      batches.push(event.messages.map((m: any) => m.content));
      await gate;
    });

    manager.recordMessage(PEER, msg('第一条'));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    const delivering = manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));
    // 投递进行中，用户又发来一条
    manager.recordMessage(PEER, msg('第二条'));
    release();
    await delivering;

    expect(batches).toEqual([['第一条']]);
    expect(manager.getPendingMessages(PEER).map((m) => m.content)).toEqual(['第二条']);
  });

  it('tick 投递进行中触发 turn/end flush：单飞，绝不重复投递同一批', async () => {
    const manager = new ProactiveManager();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batches: string[][] = [];
    const dispatch = vi.fn(async (event: any) => {
      batches.push(event.messages.map((m: any) => m.content));
      await gate;
    });

    manager.recordMessage(PEER, msg('第一条'));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    const ticking = manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));
    const flushed = await manager.flushPendingMessages(PEER, makeOptions({ dispatch }));

    expect(flushed).toBe(false);
    release();
    await ticking;

    expect(batches).toHaveLength(1);
    expect(manager.hasPendingMessage(PEER)).toBe(false);
  });

  it('fromUser 透传池内最后一位真实发送者', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg('第一条'), 'OPENID_A');
    manager.recordMessage(PEER, msg('第二条'), 'OPENID_B');

    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));

    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.fromUser).toBe('OPENID_B');
  });
});

describe('契约 11: 运行中不打断，turn/end flush 排队消息', () => {
  it('tick 到点但 agent 正在运行 → 不投递，池完整保留', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg('运行中到达的消息'));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, isAgentRunning: () => true })
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.hasPendingMessage(PEER)).toBe(true);
  });

  it('flushPendingMessages 以 turn_end 语义投递并清空', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg('上一轮期间的补充'), 'OPENID_A');
    const delivered = await manager.flushPendingMessages(PEER, makeOptions({ dispatch }));

    expect(delivered).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('aggregated_messages');
    expect(event.reason).toBe('turn_end');
    expect(event.messages).toHaveLength(1);
    expect(manager.hasPendingMessage(PEER)).toBe(false);
  });

  it('flush 在等待用户输入或聚合关闭时原样保留池', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER, msg('待恢复'));

    const awaiting = await manager.flushPendingMessages(
      PEER,
      makeOptions({ dispatch, isAwaitingUserInput: () => true })
    );
    expect(awaiting).toBe(false);

    const disabled = await manager.flushPendingMessages(
      PEER,
      makeOptions({ dispatch, config: { aggregation_enabled: false } })
    );
    expect(disabled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.hasPendingMessage(PEER)).toBe(true);
  });
});

describe('契约 12: 入站分流决策（聚合关闭 / 空闲入池 / 运行中 steer 插话 / 运行中 queue 入池）', () => {
  it('聚合关闭：永不入池，保持原有即时唤醒链路', () => {
    expect(
      shouldPoolInbound({ aggregationEnabled: false, behavior: 'steer', isAgentRunning: false })
    ).toBe(false);
    expect(
      shouldPoolInbound({ aggregationEnabled: false, behavior: 'queue', isAgentRunning: true })
    ).toBe(false);
  });

  it('聚合开启 + 空闲：无论 steer/queue 均入池等周期 tick', () => {
    for (const behavior of ['steer', 'queue'] as const) {
      expect(
        shouldPoolInbound({ aggregationEnabled: true, behavior, isAgentRunning: false })
      ).toBe(true);
    }
  });

  it('聚合开启 + 运行中：steer 即时插话不入池，queue 入池等 turn/end', () => {
    expect(
      shouldPoolInbound({ aggregationEnabled: true, behavior: 'steer', isAgentRunning: true })
    ).toBe(false);
    expect(
      shouldPoolInbound({ aggregationEnabled: true, behavior: 'queue', isAgentRunning: true })
    ).toBe(true);
  });
});

describe('契约 9: 配置项四方同源与默认值', () => {
  const PROACTIVE_KEYS = [
    'aggregation_enabled',
    'aggregation_min_seconds',
    'aggregation_max_seconds',
    'idle_reply_enabled',
    'idle_reply_min_mins',
    'idle_reply_max_mins',
    'proactive_attitude',
    'instant_reply_enabled',
  ] as const;

  it('8 个仿生主动能力配置键在 Schema 与 DEFAULT_BASE_CONFIG 中同时存在且默认值一致', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    const parsed = BridgeConfigSchema({});
    const unwrap = (val: any) => (typeof val?.get === 'function' ? val.get() : val);

    for (const key of PROACTIVE_KEYS) {
      expect(schemaShape[key]).toBeDefined();
      expect(schemaShape[key]?.meta?.volatile).toBe(true);
      expect(unwrap((parsed as any)[key])).toEqual((DEFAULT_BASE_CONFIG as any)[key]);
    }
  });

  it('默认值：聚合关闭 / [10s, 60s] / 搭话关闭 / [30m, 120m] / balanced / instant_reply 关闭', () => {
    expect(DEFAULT_BASE_CONFIG.aggregation_enabled).toBe(false);
    expect(DEFAULT_BASE_CONFIG.aggregation_min_seconds).toBe(10);
    expect(DEFAULT_BASE_CONFIG.aggregation_max_seconds).toBe(60);
    expect(DEFAULT_BASE_CONFIG.idle_reply_enabled).toBe(false);
    expect(DEFAULT_BASE_CONFIG.idle_reply_min_mins).toBe(30);
    expect(DEFAULT_BASE_CONFIG.idle_reply_max_mins).toBe(120);
    expect(DEFAULT_BASE_CONFIG.proactive_attitude).toBe('balanced');
    expect(DEFAULT_BASE_CONFIG.instant_reply_enabled).toBe(false);
  });

  it('旧版过渡期字段与未知 proactive_* 键已彻底剔除或不受理', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    for (const dead of [
      'aggregation_interval_mins',
      'idle_reply_timeout_mins',
      'proactive_reply_enabled',
      'proactive_interval_mins',
      'proactive_buffer_size',
      'proactive_idle_enabled',
      'proactive_idle_timeout_mins',
      'proactive_night_dnd',
    ]) {
      expect(schemaShape[dead]).toBeUndefined();
    }
  });
});
