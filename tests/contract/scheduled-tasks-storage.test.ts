/**
 * tests/contract/scheduled-tasks-storage.test.ts
 * 契约测试: 定时任务 SQLite 持久化契约 (Scheduled Tasks Storage Contract)
 * 验证 scheduled_tasks 表的生命周期、单次/周期状态更新与检索契约（C2C 单聊模型）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MessageDatabase } from '../../src/storage/database.js';
import type { ScheduledTaskRecord } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const PEER_A = openidToPeer('0123456789ABCDEF0123456789ABCDEF');
const PEER_B = openidToPeer('FEDCBA9876543210FEDCBA9876543210');

describe('契约测试: 定时任务 SQLite 持久化契约 (Scheduled Tasks Storage Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-tasks-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new MessageDatabase(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: 创建单次定时任务并能正确读取', () => {
    const task: ScheduledTaskRecord = {
      id: 'task_001',
      peer: PEER_A,
      creator: '0123456789ABCDEF0123456789ABCDEF',
      prompt: '半小时后提醒我开会',
      type: 'once',
      recurring_rule: null,
      next_run_at: 1700000000000,
      status: 'pending',
      created_at: 1699990000000,
      updated_at: 1699990000000,
    };

    db.createScheduledTask(task);

    const fetched = db.getScheduledTask('task_001');
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe('task_001');
    expect(fetched?.peer).toBe(PEER_A);
    expect(fetched?.creator).toBe('0123456789ABCDEF0123456789ABCDEF');
    expect(fetched?.prompt).toBe('半小时后提醒我开会');
    expect(fetched?.type).toBe('once');
    expect(fetched?.recurring_rule).toBeNull();
    expect(fetched?.next_run_at).toBe(1700000000000);
    expect(fetched?.status).toBe('pending');
  });

  it('契约 2: 创建周期定时任务并能序列化/反序列化 recurring_rule', () => {
    const task: ScheduledTaskRecord = {
      id: 'task_002',
      peer: PEER_B,
      creator: 'FEDCBA9876543210FEDCBA9876543210',
      prompt: '工作日早会提醒',
      type: 'recurring',
      recurring_rule: {
        frequency: 'weekdays',
        time_of_day: '09:30',
      },
      next_run_at: 1700003600000,
      status: 'pending',
      created_at: 1699990000000,
      updated_at: 1699990000000,
    };

    db.createScheduledTask(task);

    const fetched = db.getScheduledTask('task_002');
    expect(fetched).toBeDefined();
    expect(fetched?.type).toBe('recurring');
    expect(fetched?.recurring_rule).toEqual({
      frequency: 'weekdays',
      time_of_day: '09:30',
    });
  });

  it('契约 3: listScheduledTasks 按 peer 与 status 筛选，默认按 next_run_at ASC 排序', () => {
    const now = Date.now();
    db.createScheduledTask({
      id: 't1',
      peer: PEER_A,
      creator: '1',
      prompt: '任务1',
      type: 'once',
      next_run_at: now + 50000,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    db.createScheduledTask({
      id: 't2',
      peer: PEER_A,
      creator: '1',
      prompt: '任务2',
      type: 'once',
      next_run_at: now + 10000,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    db.createScheduledTask({
      id: 't3',
      peer: PEER_A,
      creator: '1',
      prompt: '任务3-已取消',
      type: 'once',
      next_run_at: now + 20000,
      status: 'cancelled',
      created_at: now,
      updated_at: now,
    });
    db.createScheduledTask({
      id: 't4',
      peer: PEER_B,
      creator: '2',
      prompt: '会话B任务',
      type: 'once',
      next_run_at: now + 30000,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    const peerAPending = db.listScheduledTasks(PEER_A, 'pending');
    expect(peerAPending.length).toBe(2);
    expect(peerAPending[0].id).toBe('t2');
    expect(peerAPending[1].id).toBe('t1');

    const peerAAll = db.listScheduledTasks(PEER_A);
    expect(peerAAll.length).toBe(3);
  });

  it('契约 4: updateScheduledTask 支持局部更新 prompt、next_run_at 与 recurring_rule', () => {
    const now = Date.now();
    db.createScheduledTask({
      id: 'task_up',
      peer: PEER_A,
      creator: '1',
      prompt: '初始要求',
      type: 'once',
      next_run_at: now + 10000,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    const updated = db.updateScheduledTask('task_up', {
      prompt: '更新后的提示词',
      next_run_at: now + 20000,
    });
    expect(updated).toBe(true);

    const record = db.getScheduledTask('task_up');
    expect(record?.prompt).toBe('更新后的提示词');
    expect(record?.next_run_at).toBe(now + 20000);
    expect(record?.updated_at).toBeGreaterThanOrEqual(now);
  });

  it('契约 5: cancelScheduledTask 标记状态为 cancelled 并更新时间戳', () => {
    const now = Date.now();
    db.createScheduledTask({
      id: 'task_cancel',
      peer: PEER_A,
      creator: '1',
      prompt: '将要取消',
      type: 'once',
      next_run_at: now + 10000,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    const success = db.cancelScheduledTask('task_cancel');
    expect(success).toBe(true);

    const record = db.getScheduledTask('task_cancel');
    expect(record?.status).toBe('cancelled');
  });

  it('契约 6: completeScheduledTask 支持单次标记 completed 或周期更新 next_run_at', () => {
    const now = Date.now();
    db.createScheduledTask({
      id: 'task_once',
      peer: PEER_A,
      creator: '1',
      prompt: '单次',
      type: 'once',
      next_run_at: now,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    db.completeScheduledTask('task_once');
    expect(db.getScheduledTask('task_once')?.status).toBe('completed');

    db.createScheduledTask({
      id: 'task_rec',
      peer: PEER_A,
      creator: '1',
      prompt: '周期',
      type: 'recurring',
      next_run_at: now,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    const nextRun = now + 86400000;
    db.completeScheduledTask('task_rec', nextRun);
    const rec = db.getScheduledTask('task_rec');
    expect(rec?.status).toBe('pending');
    expect(rec?.next_run_at).toBe(nextRun);
  });

  it('契约 7: getPendingScheduledTasks 检索所有到期/超期待处理任务', () => {
    const now = Date.now();
    db.createScheduledTask({
      id: 'past1',
      peer: PEER_A,
      creator: '1',
      prompt: '已到期1',
      type: 'once',
      next_run_at: now - 5000,
      status: 'pending',
      created_at: now - 10000,
      updated_at: now - 10000,
    });
    db.createScheduledTask({
      id: 'past2',
      peer: PEER_B,
      creator: '2',
      prompt: '已到期2',
      type: 'once',
      next_run_at: now,
      status: 'pending',
      created_at: now - 10000,
      updated_at: now - 10000,
    });
    db.createScheduledTask({
      id: 'future',
      peer: PEER_A,
      creator: '1',
      prompt: '未到期',
      type: 'once',
      next_run_at: now + 50000,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });

    const dueTasks = db.getPendingScheduledTasks(now);
    expect(dueTasks.map((t) => t.id).sort()).toEqual(['past1', 'past2']);
  });
});
