/**
 * tests/contract/system-event-hub.test.ts
 *
 * 契约测试: 单聊系统内部事件与统一唤醒中枢 (SystemEventHub)
 *
 * 验证目标:
 * 1. 面向 QQ 官方 Bot 单聊的 `scheduled_task` 提示词骨架（无群聊、无主动插话/戳一戳）；
 * 2. Zero-Leak / Null-Initiator 铁律: `from_name === ''`、`from_user === ''`、`is_system === true`；
 * 3. 出站合成上下文追踪 (`is_synthetic: true`) 与历史有效被动 `msg_id` 锚点绝不被擦除。
 */

import { describe, it, expect, vi } from 'vitest';
import { SystemEventHub, formatSystemEventPrompt } from '../../src/gateway/system-event-hub.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { ScheduledTaskEvent } from '../../src/types/system-event.js';
import type { WakeupPayload } from '../../src/types/index.js';

const PEER_USER = 'user_a1b2c3d4e5f60708';

describe('契约测试: 单聊系统事件与统一唤醒中枢 (SystemEventHub)', () => {
  it('契约 1: 定时任务提示词采用单聊骨架（含任务编号、规则、内容与置底引导，不含群聊文案）', () => {
    const event: ScheduledTaskEvent = {
      kind: 'scheduled_task',
      peer: PEER_USER,
      taskId: 'task_999',
      taskType: 'recurring',
      taskRule: '每天 18:00 执行',
      prompt: '提醒用户下班并通报天气',
      timestamp: 1794000000000,
    };

    const prompt = formatSystemEventPrompt(event);

    expect(prompt).toContain('系统事件：[定时任务] [任务编号: #task_999] [QQ私聊]');
    expect(prompt).toContain('任务规则：每天 18:00 执行');
    expect(prompt).toContain('\n\n任务内容：\n提醒用户下班并通报天气\n\n');
    expect(prompt).toContain('QQ 单聊中设定的定时任务触发');
    expect(prompt).toContain('切勿向用户透露内部 task_id 或系统事件代码等调试信息');
    expect(prompt).not.toContain('群聊');
  });

  it('契约 2: Zero-Leak 与 Null-Initiator 铁律（from_name 与 from_user 严格为空，is_system=true）', async () => {
    let capturedPayload: WakeupPayload | undefined;
    const mockSessionManager = {
      dispatchWakeup: vi.fn(async (payload: WakeupPayload, opts?: { onMessageCreated?: (msg: any) => void }) => {
        capturedPayload = payload;
        opts?.onMessageCreated?.({ id: 'dsh_msg_1' });
        return { ok: true };
      }),
    };
    const mockOutboundBridge = {
      trackInboundContext: vi.fn(),
      trackPendingMessage: vi.fn(),
    };

    const hub = new SystemEventHub({
      sessionManager: mockSessionManager,
      outboundBridge: mockOutboundBridge,
    });

    await hub.dispatchScheduledTask({
      peer: PEER_USER,
      taskId: 'task_001',
      taskType: 'once',
      prompt: '提醒喝水',
      creator: '1000000001',
    });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.is_system).toBe(true);
    expect(capturedPayload!.trigger).toBe('scheduled');
    expect(capturedPayload!.from_name).toBe('');
    expect(capturedPayload!.from_user).toBe('');
    expect(capturedPayload!.task_id).toBe('task_001');

    expect(mockOutboundBridge.trackInboundContext).toHaveBeenCalledWith(
      PEER_USER,
      expect.objectContaining({
        from_user: '',
        trigger: 'scheduled',
        is_synthetic: true,
      })
    );
    // 绝不显式传递 msg_id: undefined 去覆盖擦除历史锚点
    const ctxArg = mockOutboundBridge.trackInboundContext.mock.calls[0]?.[1];
    expect(Object.hasOwn(ctxArg, 'msg_id')).toBe(false);
    expect(mockOutboundBridge.trackPendingMessage).toHaveBeenCalledWith(
      'dsh_msg_1',
      PEER_USER,
      expect.objectContaining({
        trigger: 'scheduled',
        is_synthetic: true,
      })
    );
  });

  it('契约 3: 与真实 OutboundStreamBridge 协同，系统事件下发绝不覆盖擦除历史有效入站 msg_id 锚点', async () => {
    const outboundBridge = new OutboundStreamBridge({} as any, {});
    // 先记录一条真实用户的入站被动锚点
    outboundBridge.trackInboundContext(PEER_USER, {
      msg_id: 'ROBOT1.0_REAL_INBOUND_001',
      ref_idx: 'REFIDX_REAL_001',
      from_user: 'a1b2c3d4e5f60708',
    });
    expect(outboundBridge.resolvePassiveMsgId(PEER_USER)).toBe('ROBOT1.0_REAL_INBOUND_001');

    const mockSessionManager = {
      dispatchWakeup: vi.fn(async (_payload: WakeupPayload, opts?: { onMessageCreated?: (msg: any) => void }) => {
        opts?.onMessageCreated?.({ id: 'dsh_msg_2' });
      }),
      getOutboundBridge: () => outboundBridge,
    };

    const hub = new SystemEventHub({ sessionManager: mockSessionManager });
    await hub.dispatchScheduledTask({
      peer: PEER_USER,
      taskId: 'task_002',
      taskType: 'once',
      prompt: '定时问候',
    });

    // 历史有效入站被动 msg_id 必须完好保留，且当前活跃上下文保留 is_synthetic=true
    expect(outboundBridge.resolvePassiveMsgId(PEER_USER)).toBe('ROBOT1.0_REAL_INBOUND_001');
    expect(outboundBridge.getActiveTurnContext(PEER_USER)?.is_synthetic).toBe(true);
    expect(outboundBridge.getActiveTurnContext(PEER_USER)?.msg_id).toBe('ROBOT1.0_REAL_INBOUND_001');
  });
});
