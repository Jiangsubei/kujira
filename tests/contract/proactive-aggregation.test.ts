/**
 * tests/contract/proactive-aggregation.test.ts
 *
 * 契约测试: 单聊消息聚合回复与冷场主动搭话 (Kujira Proactive Aggregation & Idle Reply)
 *
 * 覆盖规范清单:
 * 1. 聚合池：入池后按时间升序保留、短 ID 完整保留、消费即清空（绝不重复打扰）；
 * 2. 周期窗口判定：未到窗口不投递，到点且池非空才投递；与冷场搭话完全解耦；
 * 3. 冷场搭话：仅在池为空且沉默达阈值时触发，单轮只触发一次（防死循环），人类新消息重置；
 * 4. 两个开关各自独立门控，互不影响；
 * 5. 聚合提示词：沿用 Kujira 精简骨架（无 `[QQ私聊]`、无发送者标识、仅短 ID 与时间）；
 * 6. 冷场搭话提示词：系统事件语义，绝不含真实用户内容与后台痕迹；
 * 7. 装配闭环：真实 SystemEventHub / SessionManager 接线可被真实调用；
 * 8. 配置项：4 个新键在 Schema/Constants/服务端/客户端四方同源。
 */

import { describe, it, expect, vi } from 'vitest';
import { ProactiveManager } from '../../src/gateway/proactive.js';
import { formatSystemEventPrompt } from '../../src/gateway/system-event-hub.js';
import { formatWakeupPrompt } from '../../src/gateway/external-prompt.js';
import { DEFAULT_BASE_CONFIG } from '../../src/constants/index.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import type { AggregatedMessage } from '../../src/types/wakeup.js';

const PEER = 'user_a1b2c3d4e5f60708';
const PEER_B = 'user_b1b2c3d4e5f60708';

function msg(shortId: string, content: string, time: number): AggregatedMessage {
  return { short_id: shortId, content, time };
}

const BASE_CONFIG = {
  aggregation_enabled: true,
  aggregation_interval_mins: 2,
  idle_reply_enabled: true,
  idle_reply_timeout_mins: 60,
};

/** 构造一轮巡检所需的 options（now 显式注入，绝不依赖真实时钟） */
function makeOptions(overrides: Record<string, any> = {}) {
  return {
    config: { ...BASE_CONFIG, ...(overrides.config || {}) },
    now: overrides.now ?? 1_000_000,
    ...overrides,
  };
}

describe('契约 1: 消息聚合池的入池、排序与消费语义', () => {
  it('入池后按时间升序保留全部消息，短 ID 与正文逐条完整保留', () => {
    const manager = new ProactiveManager();
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_11', '在吗', now), BASE_CONFIG);
    manager.recordMessage(PEER, msg('msg_12', '问你个事', now + 5_000), BASE_CONFIG);
    manager.recordMessage(PEER, msg('msg_13', '那个接口一直 403', now + 9_000), BASE_CONFIG);

    const pending = manager.getPendingMessages(PEER);
    expect(pending).toHaveLength(3);
    expect(pending.map((m) => m.short_id)).toEqual(['msg_11', 'msg_12', 'msg_13']);
    expect(pending.map((m) => m.content)).toEqual(['在吗', '问你个事', '那个接口一直 403']);
  });

  it('私聊不做滑动窗口：不设条数上限，十几条消息全部保留（仅受窗口时间约束）', () => {
    const manager = new ProactiveManager();
    const now = 1_000_000;
    for (let i = 1; i <= 15; i += 1) {
      manager.recordMessage(PEER, msg(`msg_${100 + i}`, `第 ${i} 条`, now + i * 100), BASE_CONFIG);
    }
    expect(manager.getPendingMessages(PEER)).toHaveLength(15);
  });

  it('按 peer 严格隔离：不同单聊会话的消息池互不可见', () => {
    const manager = new ProactiveManager();
    const now = 1_000_000;
    manager.recordMessage(PEER, msg('msg_21', 'A 的消息', now), BASE_CONFIG);
    manager.recordMessage(PEER_B, msg('msg_22', 'B 的消息', now), BASE_CONFIG);

    expect(manager.getPendingMessages(PEER).map((m) => m.content)).toEqual(['A 的消息']);
    expect(manager.getPendingMessages(PEER_B).map((m) => m.content)).toEqual(['B 的消息']);
  });

  it('消费后立即清空该 peer 的消息池，绝不重复打扰', () => {
    const manager = new ProactiveManager();
    const now = 1_000_000;
    manager.recordMessage(PEER, msg('msg_31', '第一条', now), BASE_CONFIG);
    manager.recordMessage(PEER, msg('msg_32', '第二条', now + 1000), BASE_CONFIG);

    const consumed = manager.consumePendingMessages(PEER);
    expect(consumed).toHaveLength(2);
    expect(manager.getPendingMessages(PEER)).toEqual([]);

    // 二次消费必须为空，防止同批消息被投递两次
    expect(manager.consumePendingMessages(PEER)).toEqual([]);
  });

  it('无消息的 peer 返回空数组而非 undefined（保证调用方无需空值兜底）', () => {
    const manager = new ProactiveManager();
    expect(manager.getPendingMessages('user_ffffffffffffffff')).toEqual([]);
    expect(manager.consumePendingMessages('user_ffffffffffffffff')).toEqual([]);
  });
});

describe('契约 2: 聚合周期窗口判定', () => {
  it('聚合总开关关闭时，任何消息都不入池（保持现有一问一答即时语义）', () => {
    const manager = new ProactiveManager();
    const now = 1_000_000;
    manager.recordMessage(PEER, msg('msg_41', '在吗', now), {
      ...BASE_CONFIG,
      aggregation_enabled: false,
    });
    expect(manager.getPendingMessages(PEER)).toEqual([]);
  });

  it('未到聚合窗口时不投递（窗口内连续发消息持续累积）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_51', '在吗', now), BASE_CONFIG);
    // 窗口 2 分钟 = 120000ms；仅过 60 秒
    await manager.checkProactive(makeOptions({ now: now + 60_000, dispatch }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.getPendingMessages(PEER)).toHaveLength(1);
  });

  it('到点且池非空 → 一次性投递整批消息，并按时间升序透传', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_61', '在吗', now), BASE_CONFIG);
    manager.recordMessage(PEER, msg('msg_62', '问你个事', now + 10_000), BASE_CONFIG);

    await manager.checkProactive(makeOptions({ now: now + 120_000, dispatch }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('aggregated_messages');
    expect(event.peer).toBe(PEER);
    expect(event.messages.map((m: any) => m.short_id)).toEqual(['msg_61', 'msg_62']);
    expect(event.intervalMinutes).toBe(2);

    // 投递后池已清空
    expect(manager.getPendingMessages(PEER)).toEqual([]);
  });

  it('投递后重置窗口计时：紧接着的新消息需等下一个完整窗口', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_71', '第一条', now), BASE_CONFIG);
    await manager.checkProactive(makeOptions({ now: now + 120_000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);

    // 投递时刻落新消息
    const deliveredAt = now + 120_000;
    manager.recordMessage(PEER, msg('msg_72', '第二条', deliveredAt), BASE_CONFIG);

    // 仅过 60 秒，未满新窗口
    await manager.checkProactive(makeOptions({ now: deliveredAt + 60_000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);

    // 满 120 秒后投递
    await manager.checkProactive(makeOptions({ now: deliveredAt + 120_000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('周期窗口语义：窗口内持续到来的新消息不重置计时（固定周期抓取）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordMessage(PEER, msg('msg_81', '第一条', now), BASE_CONFIG);
    // 窗口计时从首条消息起算，中途来新消息不前移
    manager.recordMessage(PEER, msg('msg_82', '中途补充', now + 100_000), BASE_CONFIG);

    await manager.checkProactive(makeOptions({ now: now + 120_000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.messages).toHaveLength(2);
    expect(event.messages[1].short_id).toBe('msg_82');
  });
});

describe('契约 3: 冷场主动搭话判定', () => {
  it('冷场开关关闭时，沉默再久也不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordHumanMessage(PEER, now);
    await manager.checkProactive(
      makeOptions({ config: { idle_reply_enabled: false }, now: now + 10 * 60 * 60 * 1000, dispatch })
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('沉默未达阈值时不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordHumanMessage(PEER, now);
    // 阈值 60 分钟，仅过 30 分钟
    await manager.checkProactive(makeOptions({ now: now + 30 * 60 * 1000, dispatch }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('沉默达阈值且消息池为空 → 触发一次冷场搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordHumanMessage(PEER, now);
    await manager.checkProactive(makeOptions({ now: now + 60 * 60 * 1000, dispatch }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as any;
    expect(event.kind).toBe('idle_reply');
    expect(event.peer).toBe(PEER);
    expect(event.idleMinutes).toBe(60);
  });

  it('单轮防死循环：同一次沉默周期内只搭话一次', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordHumanMessage(PEER, now);
    await manager.checkProactive(makeOptions({ now: now + 60 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);

    // 再巡检两轮（沉默继续增长），不得重复搭话
    await manager.checkProactive(makeOptions({ now: now + 90 * 60 * 1000, dispatch }));
    await manager.checkProactive(makeOptions({ now: now + 120 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('人类重新发言后复位冷场标记，下一轮沉默可再次搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    manager.recordHumanMessage(PEER, now);
    await manager.checkProactive(makeOptions({ now: now + 60 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);

    // 人类回来了
    const returnedAt = now + 70 * 60 * 1000;
    manager.recordHumanMessage(PEER, returnedAt);

    // 新一轮沉默达阈值后可再次搭话
    await manager.checkProactive(makeOptions({ now: returnedAt + 60 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('消息池非空时优先聚合回复，绝不叠加冷场搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;

    // 沉默很久，但池里还有未回复消息
    manager.recordHumanMessage(PEER, now);
    manager.recordMessage(PEER, msg('msg_91', '还没回我呢', now + 100), BASE_CONFIG);

    await manager.checkProactive(makeOptions({ now: now + 60 * 60 * 1000, dispatch }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');
  });

  it('未配置任何基准时间的 peer 不会被冷场搭话（绝不主动骚扰陌生会话）', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    await manager.checkProactive(makeOptions({ now: 1_000_000, dispatch }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('契约 4: 两个开关完全解耦', () => {
  it('仅开聚合：池非空投递聚合，沉默也不搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;
    const config = { aggregation_enabled: true, aggregation_interval_mins: 2, idle_reply_enabled: false };

    manager.recordMessage(PEER, msg('msg_a1', '在吗', now), config);
    await manager.checkProactive(makeOptions({ config, now: now + 120_000, dispatch }));
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('aggregated_messages');

    await manager.checkProactive(makeOptions({ config, now: now + 10 * 60 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('仅开搭话：普通消息即时唤醒交由上层处理，池子不入库、冷场照常搭话', async () => {
    const manager = new ProactiveManager();
    const dispatch = vi.fn(async () => {});
    const now = 1_000_000;
    const config = { aggregation_enabled: false, idle_reply_enabled: true, idle_reply_timeout_mins: 60 };

    manager.recordMessage(PEER, msg('msg_b1', '在吗', now), config);
    expect(manager.getPendingMessages(PEER)).toEqual([]);

    await manager.checkProactive(makeOptions({ config, now: now + 60 * 60 * 1000, dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as any).kind).toBe('idle_reply');
  });
});

describe('契约 5: 聚合唤醒提示词沿用 Kujira 精简骨架', () => {
  it('聚合提示词逐条呈现短 ID 与时间，不含渠道前缀与发送者标识', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      intervalMinutes: 2,
      timestamp: new Date(2026, 10, 13, 14, 5, 0).getTime(),
      messages: [
        msg('msg_11', '在吗', new Date(2026, 10, 13, 14, 2, 11).getTime()),
        msg('msg_12', '那个接口一直 403', new Date(2026, 10, 13, 14, 3, 2).getTime()),
      ],
    });

    expect(prompt).toContain('[msg_11]');
    expect(prompt).toContain('[msg_12]');
    expect(prompt).toContain('在吗');
    expect(prompt).toContain('那个接口一直 403');
    expect(prompt).toMatch(/2026-11-13 14:02:11/);

    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain(PEER);
    expect(prompt).not.toContain('ROBOT1.0');
    expect(prompt).not.toContain('群聊');
  });

  it('聚合提示词指引模型一次性综合回复，且禁止透露聚合机制', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'aggregated_messages',
      peer: PEER,
      intervalMinutes: 2,
      messages: [msg('msg_21', '在吗', 1_000_000)],
    });
    expect(prompt).toMatch(/send_qq_message/);
    expect(prompt).toMatch(/切勿|严禁/);
    expect(prompt).toContain('聚合');
  });

  it('冷场搭话提示词为系统事件语义，不含任何真实用户消息内容', () => {
    const prompt = formatSystemEventPrompt({
      kind: 'idle_reply',
      peer: PEER,
      idleMinutes: 60,
      timestamp: new Date(2026, 10, 13, 14, 5, 0).getTime(),
    });

    expect(prompt).toContain('系统事件');
    expect(prompt).toContain('60');
    expect(prompt).toMatch(/send_qq_message/);
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain(PEER);
    expect(prompt).not.toContain('群聊');
    // 允许模型自主选择不发言
    expect(prompt).toMatch(/\[结束\]|不发言|无需/);
  });
});

describe('契约 6: 唤醒提示词统一入口正确分派两类新事件', () => {
  it('aggregated / idle_reply 两类事件均经 formatWakeupPrompt 分派到系统事件格式化', () => {
    const aggregated = formatWakeupPrompt({
      peer: PEER,
      trigger: 'aggregated',
      from_user: '',
      from_name: '',
      content: '',
      timestamp: 1_000_000,
      is_system: true,
      system_event: {
        kind: 'aggregated_messages',
        peer: PEER,
        intervalMinutes: 2,
        messages: [msg('msg_31', '在吗', 1_000_000)],
      },
    });
    expect(aggregated).toContain('在吗');
    expect(aggregated).toContain('[msg_31]');
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

describe('契约 7: 配置项四方同源与默认值', () => {
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

  it('默认值：聚合关闭 / 窗口 2 分钟 / 搭话关闭 / 阈值 60 分钟', () => {
    expect(DEFAULT_BASE_CONFIG.aggregation_enabled).toBe(false);
    expect(DEFAULT_BASE_CONFIG.aggregation_interval_mins).toBe(2);
    expect(DEFAULT_BASE_CONFIG.idle_reply_enabled).toBe(false);
    expect(DEFAULT_BASE_CONFIG.idle_reply_timeout_mins).toBe(60);
  });

  it('未知 proactive_* 旧键仍被自愈引擎剔除，绝不被误认为新键', () => {
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
