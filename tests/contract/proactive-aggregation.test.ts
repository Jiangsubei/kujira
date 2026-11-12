/**
 * tests/contract/proactive-aggregation.test.ts
 *
 * 契约测试: 单聊消息聚合回复与冷场主动搭话 (Kujira Proactive Aggregation & Idle Reply)
 *
 * 设计基线（最终对齐版）：
 * - **不维护消息池**：数据库是唯一可信源，管理器只维护「是否有新消息」布尔标志；
 * - **不向模型喂消息**：系统事件只说「有新消息」，模型自调 read_chat_history；
 * - **自由周期时钟**：相位来自启用时刻，不因消息/投递/轮次重置；
 * - **两个开关完全解耦**：聚合与冷场搭话各自独立门控、各自阈值。
 */

import { describe, it, expect, vi } from 'vitest';
import { ProactiveManager } from '../../src/gateway/proactive.js';
import { formatSystemEventPrompt } from '../../src/gateway/system-event-hub.js';
import { formatWakeupPrompt } from '../../src/gateway/external-prompt.js';
import { DEFAULT_BASE_CONFIG } from '../../src/constants/index.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';

const PEER = 'user_a1b2c3d4e5f60708';
const PEER_B = 'user_b1b2c3d4e5f60708';

const BASE_CONFIG = {
  aggregation_enabled: true,
  aggregation_interval_mins: 2,
  idle_reply_enabled: true,
  idle_reply_timeout_mins: 60,
};

/** T0：启用时刻。时钟相位由此起算。 */
const T0 = 1_000_000;

function makeOptions(overrides: Record<string, any> = {}) {
  const { config: configOverride, now, ...rest } = overrides;
  return {
    ...rest,
    config: { ...BASE_CONFIG, ...(configOverride || {}) },
    now: now ?? T0,
  };
}

describe('契约 1: 只维护「是否有新消息」布尔标志，绝不保存消息内容', () => {
  it('入站消息只置标志，不保存任何消息体（管理器无消息池 API）', () => {
    const manager = new ProactiveManager();
    manager.recordMessage(PEER);

    expect(manager.hasPendingMessage(PEER)).toBe(true);

    // 管理器不再暴露任何消息内容查询能力
    expect((manager as any).getPendingMessages).toBeUndefined();
    expect((manager as any).consumePendingMessages).toBeUndefined();
  });

  it('标志消费后复位，防止同一批消息被反复唤醒', () => {
    const manager = new ProactiveManager();
    manager.recordMessage(PEER);

    expect(manager.consumePendingMessage(PEER)).toBe(true);
    expect(manager.hasPendingMessage(PEER)).toBe(false);
    // 二次消费返回 false，绝不重复触发
    expect(manager.consumePendingMessage(PEER)).toBe(false);
  });

  it('按 peer 严格隔离', () => {
    const manager = new ProactiveManager();
    manager.recordMessage(PEER);

    expect(manager.hasPendingMessage(PEER)).toBe(true);
    expect(manager.hasPendingMessage(PEER_B)).toBe(false);
  });
});

describe('契约 2: 自由周期时钟', () => {
  it('相位以启用时刻起算，未到第一个周期不触发', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    manager.recordMessage(PEER);

    // 首个 tick 只是建立相位，不触发
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    expect(dispatch).not.toHaveBeenCalled();

    // 未满 2 分钟
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 60_000 }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('到点且标志为真 → 投递一次聚合事件；标志随即消费', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    manager.recordMessage(PEER);

    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('aggregated_messages');
    expect(event.peer).toBe(PEER);
    expect(event.intervalMinutes).toBe(2);
    // 绝不携带消息内容
    expect(event.messages).toBeUndefined();

    expect(manager.hasPendingMessage(PEER)).toBe(false);
  });

  it('到点但标志为假 → 不唤醒（空转 tick 不消耗任何资源）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 240_000 }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('自由周期时钟严格推进：连续两个周期各触发一次，间隔恒为周期长度', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    // 第一个周期
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));
    manager.recordMessage(PEER);
    // 第二个周期
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 240_000 }));

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('时钟不因消息到达时刻重置：窗口中途来的消息等到下一个 tick 统一带走', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    // 周期中途来消息
    manager.recordMessage(PEER);
    // 仍未到点
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 60_000 }));
    expect(dispatch).not.toHaveBeenCalled();

    // 到点统一触发
    await manager.checkProactive(makeOptions({ dispatch, now: T0 + 120_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('周期配置变更时重新对齐相位', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ dispatch, now: T0 }));

    // 改成 5 分钟：重新对齐，此前不会触发
    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000, config: { aggregation_interval_mins: 5 } })
    );
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({ dispatch, now: T0 + 120_000 + 300_000, config: { aggregation_interval_mins: 5 } })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('契约 3: 等待用户输入时跳过唤醒，但消息保留到下一轮', () => {
  it('暂停期间到点不唤醒，标志保留', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
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

    manager.recordMessage(PEER);
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
  });
});

describe('契约 4: 活跃会话门控', () => {
  it('聚合：无活跃会话时不唤醒，标志保留', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
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

    manager.recordMessage(PEER);
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

    manager.recordMessage(PEER);
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

  it('沉默未达阈值不搭话；达到阈值则触发一次', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = { ...BASE_CONFIG, aggregation_enabled: false };

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 30 * 60 * 1000,
        now: T0,
      })
    );
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 60 * 60 * 1000,
        now: T0,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('idle_reply');
    expect(event.idleMinutes).toBe(60);
  });

  it('单轮防死循环：同一次沉默周期内只搭话一次', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = { ...BASE_CONFIG, aggregation_enabled: false };
    const opts = (now: number) =>
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now,
      });

    await manager.checkProactive(opts(T0));
    await manager.checkProactive(opts(T0 + 600_000));
    await manager.checkProactive(opts(T0 + 1_200_000));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('人类新消息复位冷场标记，下一轮沉默可再次搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const idleConfig = { ...BASE_CONFIG, aggregation_enabled: false };

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

    // 人类回来了
    manager.recordMessage(PEER);

    await manager.checkProactive(
      makeOptions({
        config: idleConfig,
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 + 100 * 60 * 1000,
        now: T0 + 200 * 60 * 1000,
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('有待处理新消息时优先聚合，绝不叠加搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});

    manager.recordMessage(PEER);
    await manager.checkProactive(
      makeOptions({
        dispatch,
        dispatch2: undefined,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0,
      })
    );
    // 相位建立，未到点
    expect(dispatch).not.toHaveBeenCalled();

    await manager.checkProactive(
      makeOptions({
        dispatch,
        knownPeers: () => [PEER],
        lastHumanMessageAt: () => T0 - 120 * 60 * 1000,
        now: T0 + 120_000,
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
    const idleConfig = { ...BASE_CONFIG, aggregation_enabled: false };

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
    const idleConfig = { ...BASE_CONFIG, aggregation_enabled: false };

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
  });
});

describe('契约 6: 两个开关完全解耦', () => {
  it('仅开聚合：不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const config = { aggregation_enabled: true, aggregation_interval_mins: 2, idle_reply_enabled: false };

    manager.recordMessage(PEER);
    await manager.checkProactive(makeOptions({ config, dispatch, now: T0 }));
    await manager.checkProactive(makeOptions({ config, dispatch, now: T0 + 120_000 }));
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
    const config = { aggregation_enabled: false, idle_reply_enabled: true, idle_reply_timeout_mins: 60 };

    manager.recordMessage(PEER);
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

describe('契约 7: 聚合提示词不携带消息内容，强制模型自调工具', () => {
  it('提示词不含任何消息正文与消息 ID，只给出「有新消息」的指令', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      intervalMinutes: 2,
      timestamp: new Date(2026, 10, 13, 14, 5, 0).getTime(),
    });

    expect(prompt).toContain('系统事件');
    expect(prompt).toContain('read_chat_history');
    expect(prompt).toContain('[结束]');
    expect(prompt).toMatch(/2026-11-13 14:05:00/);

    // 绝不出现消息内容、短 ID 或渠道前缀
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain(PEER);
    expect(prompt).not.toContain('ROBOT1.0');
    expect(prompt).not.toContain('[msg_');
    expect(prompt).not.toContain('群聊');
  });

  it('提示词说明新消息到达语义，且不透露后台机制', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      intervalMinutes: 2,
    });
    expect(prompt).toMatch(/打扰用户/);
    expect(prompt).toMatch(/切勿|严禁/);
  });

  it('冷场搭话提示词为系统事件语义，不含真实用户消息内容', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'idle_reply',
      peer: PEER,
      idleMinutes: 60,
      timestamp: new Date(2026, 10, 13, 14, 5, 0).getTime(),
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

describe('契约 9: 配置项四方同源与默认值', () => {
  const NEW_KEYS = [
    'aggregation_enabled',
    'aggregation_interval_mins',
    'idle_reply_enabled',
    'idle_reply_timeout_mins',
  ] as const;

  it('4 个新键在 Schema 与 DEFAULT_BASE_CONFIG 中同时存在且默认值一致', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    const parsed = BridgeConfigSchema({});
    const unwrap = (val: any) => (typeof val?.get === 'function' ? val.get() : val);

    for (const key of NEW_KEYS) {
      expect(schemaShape[key]).toBeDefined();
      expect(schemaShape[key]?.meta?.volatile).toBe(true);
      expect(unwrap((parsed as any)[key])).toEqual((DEFAULT_BASE_CONFIG as any)[key]);
    }
  });

  it('默认值：聚合关闭 / 周期 2 分钟 / 搭话关闭 / 阈值 60 分钟', () => {
    expect(DEFAULT_BASE_CONFIG.aggregation_enabled).toBe(false);
    expect(DEFAULT_BASE_CONFIG.aggregation_interval_mins).toBe(2);
    expect(DEFAULT_BASE_CONFIG.idle_reply_enabled).toBe(false);
    expect(DEFAULT_BASE_CONFIG.idle_reply_timeout_mins).toBe(60);
  });

  it('未知 proactive_* 旧键仍被自愈引擎剔除', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    for (const dead of [
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
