/**
 * 契约测试: TaskScheduler 调度引擎契约 (Task Scheduler Engine Contract)
 * 验证 Fail-Fast 校验、无夜间免打扰全时段单聊放行、配额限制、周期推演及 SystemEventHub 唤醒分发契约。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import { TaskScheduler } from '../../src/scheduler/index.js';
import { SystemEventHub } from '../../src/gateway/system-event-hub.js';
import { openidToPeer } from '../../src/utils/peer.js';
import type { WakeupPayload } from '../../src/types/index.js';

const PEER_A = openidToPeer('10000000000000000000000000000001');
const PEER_B = openidToPeer('10000000000000000000000000000002');
const PEER_OVERFLOW = openidToPeer('10000000000000000000000000000003');
const PEER_TRIGGER = openidToPeer('10000000000000000000000000000004');
const PEER_REC = openidToPeer('10000000000000000000000000000005');

describe('契约测试: TaskScheduler 调度引擎契约', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let dispatchedPayloads: WakeupPayload[] = [];
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-scheduler-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new MessageDatabase(dbPath);
    dispatchedPayloads = [];

    scheduler = new TaskScheduler({
      db,
      dispatchWakeup: async (payload: WakeupPayload) => {
        dispatchedPayloads.push(payload);
      },
    });
  });

  afterEach(() => {
    scheduler.dispose();
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 单次任务时间下限 10 秒，小于 10 秒抛错拒绝', async () => {
    await expect(
      scheduler.scheduleTask({
        peer: PEER_A,
        creator: 'self',
        prompt: '测试快速任务',
        delay_seconds: 9,
      })
    ).rejects.toThrow(/不能少于 10 秒/);
  });

  it('契约 2: 单次任务支持长延迟（7 天 / 30 天），且超长定时器防 32 位溢出', async () => {
    const baseDate = new Date();
    baseDate.setHours(12, 0, 0, 0);
    const now = baseDate.getTime();

    const res7d = await scheduler.scheduleTask({
      peer: PEER_A,
      creator: 'self',
      prompt: '一周后提醒我交周报',
      delay_seconds: 7 * 86400,
      now,
    });
    expect(res7d.success).toBe(true);
    expect(res7d.task_id).toBeDefined();
    expect(res7d.next_run_at).toBe(now + 7 * 86400 * 1000);

    const targetDate = new Date(now + 30 * 86400 * 1000);
    targetDate.setHours(14, 0, 0, 0);
    const executeAtStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')} 14:00:00`;
    const res30d = await scheduler.scheduleTask({
      peer: PEER_A,
      creator: 'self',
      prompt: '一个月后的重要日程',
      execute_at: executeAtStr,
      now,
    });
    expect(res30d.success).toBe(true);
    expect(res30d.task_id).toBeDefined();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const longRes = await scheduler.scheduleTask({
        peer: PEER_OVERFLOW,
        creator: 'self',
        prompt: '防止32位整型溢出测试',
        delay_seconds: 30 * 86400,
        now,
      });
      expect(longRes.success).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(dispatchedPayloads.some((p) => p.task_id === longRes.task_id)).toBe(false);
      const taskInDb = db.getScheduledTask(longRes.task_id!);
      expect(taskInDb?.status).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('契约 3: 已彻底移除夜间免打扰拦截，单聊凌晨时段 (03:00 / 23:30) 均正常放行创建', async () => {
    const target3am = new Date();
    target3am.setHours(3, 0, 0, 0);
    if (target3am.getTime() <= Date.now()) {
      target3am.setDate(target3am.getDate() + 1);
    }
    const str3am = `${target3am.getFullYear()}-${String(target3am.getMonth() + 1).padStart(2, '0')}-${String(target3am.getDate()).padStart(2, '0')} 03:00:00`;

    const res1 = await scheduler.scheduleTask({
      peer: PEER_A,
      creator: 'self',
      prompt: '凌晨提醒',
      execute_at: str3am,
    });
    expect(res1.success).toBe(true);
    expect(res1.task_id).toBeDefined();

    const targetLate = new Date();
    targetLate.setHours(23, 30, 0, 0);
    if (targetLate.getTime() <= Date.now()) {
      targetLate.setDate(targetLate.getDate() + 1);
    }
    const strLate = `${targetLate.getFullYear()}-${String(targetLate.getMonth() + 1).padStart(2, '0')}-${String(targetLate.getDate()).padStart(2, '0')} 23:30:00`;

    const res2 = await scheduler.scheduleTask({
      peer: PEER_B,
      creator: 'self',
      prompt: '深夜提醒',
      execute_at: strLate,
    });
    expect(res2.success).toBe(true);
  });

  it('契约 4: 单聊单个 peer 最多 5 个 pending 任务，超过限制拒绝创建', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      for (let i = 1; i <= 5; i++) {
        const res = await scheduler.scheduleTask({
          peer: PEER_A,
          creator: 'self',
          prompt: `单聊任务 ${i}`,
          delay_seconds: 100 * i,
        });
        expect(res.success).toBe(true);
      }

      await expect(
        scheduler.scheduleTask({
          peer: PEER_A,
          creator: 'self',
          prompt: '第6个单聊任务',
          delay_seconds: 600,
        })
      ).rejects.toThrow(/待执行任务数量已达上限/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('契约 5: 周期任务下一次时间计算 (daily, weekdays, weekends, custom)', () => {
    const mockMonday = new Date(2026, 9, 26, 10, 0, 0, 0).getTime();

    const nextDailySameDay = scheduler.computeNextRunAt(
      { frequency: 'daily', time_of_day: '14:30' },
      mockMonday
    );
    const d1 = new Date(nextDailySameDay);
    expect(d1.getFullYear()).toBe(2026);
    expect(d1.getMonth()).toBe(9);
    expect(d1.getDate()).toBe(26);
    expect(d1.getHours()).toBe(14);
    expect(d1.getMinutes()).toBe(30);

    const nextDailyNextDay = scheduler.computeNextRunAt(
      { frequency: 'daily', time_of_day: '08:30' },
      mockMonday
    );
    const d2 = new Date(nextDailyNextDay);
    expect(d2.getDate()).toBe(27);
    expect(d2.getHours()).toBe(8);
    expect(d2.getMinutes()).toBe(30);

    const mockFridayEvening = new Date(2026, 9, 30, 18, 0, 0, 0).getTime();
    const nextWeekday = scheduler.computeNextRunAt(
      { frequency: 'weekdays', time_of_day: '09:00' },
      mockFridayEvening
    );
    const d3 = new Date(nextWeekday);
    expect(d3.getMonth()).toBe(10);
    expect(d3.getDate()).toBe(2);
    expect(d3.getDay()).toBe(1);

    const mockSundayEvening = new Date(2026, 10, 1, 20, 0, 0, 0).getTime();
    const nextWeekend = scheduler.computeNextRunAt(
      { frequency: 'weekends', time_of_day: '10:00' },
      mockSundayEvening
    );
    const d4 = new Date(nextWeekend);
    expect(d4.getDate()).toBe(7);
    expect(d4.getDay()).toBe(6);

    const nextCustom = scheduler.computeNextRunAt(
      { frequency: 'custom', days_of_week: [3], time_of_day: '15:00' },
      mockMonday
    );
    const d5 = new Date(nextCustom);
    expect(d5.getDay()).toBe(3); // 周三
    expect(d5.getHours()).toBe(15);
  });

  it('契约 6: 定时触发通过 SystemEventHub 唤醒且单次任务标记 completed', async () => {
    vi.useFakeTimers();
    const hubPayloads: WakeupPayload[] = [];
    const hub = new SystemEventHub({
      sessionManager: {
        dispatchWakeup: async (payload: WakeupPayload) => {
          hubPayloads.push(payload);
        },
      },
    });
    const hubScheduler = new TaskScheduler({ db, systemEventHub: hub });

    try {
      const res = await hubScheduler.scheduleTask({
        peer: PEER_TRIGGER,
        creator: 'self',
        prompt: '到期提醒我测试',
        delay_seconds: 15,
      });

      expect(res.success).toBe(true);
      const taskId = res.task_id!;

      await vi.advanceTimersByTimeAsync(15500);

      expect(hubPayloads.length).toBe(1);
      const payload = hubPayloads[0]!;
      expect(payload.trigger).toBe('scheduled');
      expect(payload.is_system).toBe(true);
      expect(payload.from_user).toBe('');
      expect(payload.from_name).toBe('');
      expect(payload.peer).toBe(PEER_TRIGGER);
      expect(payload.content).toContain('到期提醒我测试');
      expect(payload.task_id).toBe(taskId);

      const taskInDb = db.getScheduledTask(taskId);
      expect(taskInDb?.status).toBe('completed');
    } finally {
      hubScheduler.dispose();
      vi.useRealTimers();
    }
  });

  it('契约 7: 周期任务触发后，任务保持 pending 且自动计算并更新下次 next_run_at', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const firstRun = now + 10000;
      const res = await scheduler.scheduleTask({
        peer: PEER_REC,
        creator: 'self',
        prompt: '每日循环任务',
        execute_at: new Date(firstRun).toISOString(),
        recurring: {
          frequency: 'daily',
          time_of_day: '12:00',
        },
      });

      expect(res.success).toBe(true);
      const taskId = res.task_id!;

      await vi.advanceTimersByTimeAsync(10500);

      expect(dispatchedPayloads.length).toBe(1);
      expect(dispatchedPayloads[0]!.from_user).toBe('');
      expect(dispatchedPayloads[0]!.from_name).toBe('');
      const taskInDb = db.getScheduledTask(taskId);
      expect(taskInDb?.status).toBe('pending');
      expect(taskInDb?.next_run_at).toBeGreaterThan(firstRun);
    } finally {
      vi.useRealTimers();
    }
  });
});
