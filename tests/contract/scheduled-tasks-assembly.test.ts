/**
 * tests/contract/scheduled-tasks-assembly.test.ts
 * 契约测试: 单聊定时任务工具真实装配闭环契约 (Assembly Contract)
 * 验证 registerAgentTools 装配下 schedule_task 与 manage_scheduled_tasks 对 kujira-user-<hash16> 的
 * 创建 / 查询 / 更新 / 取消完整闭环及非单聊会话 Fail-Closed 校验。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { MediaStorageManager } from '../../src/storage/media.js';
import { TaskScheduler } from '../../src/scheduler/index.js';
import { registerAgentTools, resetGlobalToolContext } from '../../src/tools/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

function expectLosslessJson(value: unknown, trail = 'root'): void {
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => expectLosslessJson(item, `${trail}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      expect(v, `${trail}.${k} must not be undefined`).not.toBeUndefined();
      expectLosslessJson(v, `${trail}.${k}`);
    }
  }
}

describe('契约测试: 单聊定时任务工具真实装配闭环 (Scheduled Tasks Assembly Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let mediaManager: MediaStorageManager;
  let scheduler: TaskScheduler;
  let ctx: Context;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-tasks-assembly-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new MessageDatabase(dbPath);
    db.init();

    mediaManager = new MediaStorageManager({
      dshHome: tmpDir,
      db,
      ttlDays: 7,
    });

    scheduler = new TaskScheduler({
      db,
      dispatchWakeup: async () => {},
      configGetter: () => ({}),
    });

    ctx = new Context();
  });

  afterEach(() => {
    resetGlobalToolContext();
    scheduler.dispose();
    try {
      db.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: registerAgentTools 装配后 tools 注册表包含 schedule_task 与 manage_scheduled_tasks，且可完整注销', () => {
    const registeredTools = new Map<string, any>();
    (ctx as any).tools = {
      register: (toolDef: any) => {
        registeredTools.set(toolDef.name, toolDef);
        return () => registeredTools.delete(toolDef.name);
      },
      get: (name: string) => registeredTools.get(name),
    };

    const unregister = registerAgentTools(ctx, {
      db,
      mediaManager,
      scheduler,
      dshHome: tmpDir,
    });

    const scheduleTaskTool = registeredTools.get('schedule_task');
    expect(scheduleTaskTool).toBeDefined();
    expect(scheduleTaskTool.name).toBe('schedule_task');
    expect(scheduleTaskTool.description).toContain('为当前 QQ 会话创建并排期一个定时唤醒任务');

    const manageTool = registeredTools.get('manage_scheduled_tasks');
    expect(manageTool).toBeDefined();
    expect(manageTool.name).toBe('manage_scheduled_tasks');
    expect(manageTool.description).toContain('查询、取消或修改当前 QQ 会话中已排期的定时任务');

    unregister();
    expect(registeredTools.has('schedule_task')).toBe(false);
    expect(registeredTools.has('manage_scheduled_tasks')).toBe(false);
  });

  it('契约 2: 装配工具支持通过 kujira-user-<hash16> 自动解析单聊 peer 并完成创建/查询/更新/取消闭环', async () => {
    const registeredTools = new Map<string, any>();
    (ctx as any).tools = {
      register: (toolDef: any) => {
        registeredTools.set(toolDef.name, toolDef);
        return () => registeredTools.delete(toolDef.name);
      },
      get: (name: string) => registeredTools.get(name),
    };

    registerAgentTools(ctx, {
      db,
      mediaManager,
      scheduler,
      dshHome: tmpDir,
    });

    const scheduleTool = registeredTools.get('schedule_task');
    const manageTool = registeredTools.get('manage_scheduled_tasks');

    const mockExec = {
      agent: {
        session: {
          id: MOCK_SESSION_ID,
        },
      },
    };

    // 1. 创建任务
    const createRes = await scheduleTool.execute(
      {
        prompt: '10分钟后提醒喝水',
        delay_seconds: 600,
      },
      mockExec
    );
    expectLosslessJson(createRes);
    expect(createRes.success).toBe(true);
    expect(createRes.task_id).toBeDefined();
    const taskId = createRes.task_id;

    // 2. 查询列表，验证 peer 已归一化为 user_<hash16>
    const listRes = await manageTool.execute({ action: 'list' }, mockExec);
    expectLosslessJson(listRes);
    expect(listRes.success).toBe(true);
    expect(listRes.tasks).toHaveLength(1);
    expect(listRes.tasks[0].id).toBe(taskId);
    expect(listRes.tasks[0].peer).toBe(MOCK_PEER);
    expect(listRes.tasks[0].prompt).toBe('10分钟后提醒喝水');

    // 3. 更新任务内容与延迟时间
    const updateRes = await manageTool.execute(
      {
        action: 'update',
        task_id: taskId,
        prompt: '20分钟后提醒站起来活动',
        delay_seconds: 1200,
      },
      mockExec
    );
    expectLosslessJson(updateRes);
    expect(updateRes.success).toBe(true);
    expect(updateRes.action).toBe('update');
    expect(updateRes.task.prompt).toBe('20分钟后提醒站起来活动');
    expect(updateRes.task.next_run_at).toBeGreaterThan(createRes.next_run_at);

    // 4. 取消任务
    const cancelRes = await manageTool.execute(
      {
        action: 'cancel',
        task_id: taskId,
      },
      mockExec
    );
    expectLosslessJson(cancelRes);
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.action).toBe('cancel');
    expect(cancelRes.task.status).toBe('cancelled');

    // 5. 取消后再次 list 应为空
    const listAfterCancel = await manageTool.execute({ action: 'list' }, mockExec);
    expectLosslessJson(listAfterCancel);
    expect(listAfterCancel.success).toBe(true);
    expect(listAfterCancel.tasks).toEqual([]);
  });

  it('契约 3: 非 Kujira 单聊会话 (如 web-session) 调用定时任务工具必须 Fail-Closed 拒绝', async () => {
    const registeredTools = new Map<string, any>();
    (ctx as any).tools = {
      register: (toolDef: any) => {
        registeredTools.set(toolDef.name, toolDef);
        return () => registeredTools.delete(toolDef.name);
      },
      get: (name: string) => registeredTools.get(name),
    };

    registerAgentTools(ctx, {
      db,
      mediaManager,
      scheduler,
      dshHome: tmpDir,
    });

    const scheduleTool = registeredTools.get('schedule_task');
    const manageTool = registeredTools.get('manage_scheduled_tasks');
    const webExec = { agent: { session: { id: 'web-session-task' } } };

    const deniedCreate = await scheduleTool.execute(
      { prompt: '不应该创建', delay_seconds: 60 },
      webExec
    );
    expectLosslessJson(deniedCreate);
    expect(deniedCreate.success).toBe(false);
    expect(deniedCreate.error).toContain('单聊');

    const deniedList = await manageTool.execute({ action: 'list' }, webExec);
    expectLosslessJson(deniedList);
    expect(deniedList.success).toBe(false);
    expect(deniedList.error).toContain('单聊');
  });
});
