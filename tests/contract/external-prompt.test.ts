/**
 * 契约测试：单聊外部唤醒提示词统一模块 (ExternalPromptFormatter)
 * 验证 QQ 官方 Bot v2 单聊唤醒格式：无群聊、无 QQ: 前缀、支持字符串 msg_id、静态委托 SystemEventHub。
 */

import { describe, it, expect } from 'vitest';
import {
  formatExternalPrompt,
  formatMsgIdString,
  formatSenderString,
  formatWakeupPrompt,
  resolveChannelInfo,
} from '../../src/gateway/external-prompt.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('外部唤醒提示词统一模块契约 (Kujira C2C ExternalPromptFormatter)', () => {
  const FIXED_TS = new Date(2026, 9, 28, 14, 30, 15).getTime(); // 2026-10-28 14:30:15
  const TIME_STR = '2026-10-28 14:30:15';
  const PEER = 'user_a1b2c3d4e5f60708';
  const HASH16 = 'a1b2c3d4e5f60708';

  it('契约 1: formatSenderString 去除 QQ: 前缀与 agent: 前缀，无昵称且无用户标识时输出 [用户]', () => {
    expect(formatSenderString('李四', HASH16)).toBe(`[李四 (${HASH16})]`);
    expect(formatSenderString('', HASH16)).toBe(`[${HASH16}]`);
    expect(formatSenderString('李四', '')).toBe('[李四]');
    expect(formatSenderString('', '')).toBe('[用户]');
    expect(formatSenderString(undefined, undefined)).toBe('[用户]');
  });

  it('契约 2: formatMsgIdString 接收非空字符串 msg_id（如 ROBOT1.0_...）', () => {
    expect(formatMsgIdString('ROBOT1.0_abc_xyz_001')).toBe(' [消息ID: ROBOT1.0_abc_xyz_001]');
    expect(formatMsgIdString('  ROBOT1.0_trimmed  ')).toBe(' [消息ID: ROBOT1.0_trimmed]');
    expect(formatMsgIdString('')).toBe('');
    expect(formatMsgIdString('   ')).toBe('');
    expect(formatMsgIdString(undefined)).toBe('');
    expect(formatMsgIdString(null)).toBe('');
  });

  it('契约 3: resolveChannelInfo 统一返回单聊标识 [QQ私聊]', () => {
    expect(resolveChannelInfo(PEER)).toEqual({ isGroup: false, channelStr: '[QQ私聊]' });
  });

  it('契约 4: 单聊直接唤醒格式（无系统事件前缀、无 QQ: 前缀、完整字符串消息ID）', () => {
    const payload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1001',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '',
      content: '你好呀，今天天气不错',
      trigger: 'direct',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ私聊] [消息ID: ROBOT1.0_C2C_1001] [${TIME_STR}] [${HASH16}]: 你好呀，今天天气不错`
    );
    expect(prompt).not.toContain('系统事件：');
    expect(prompt).not.toContain('QQ:');
  });

  it('契约 5: 无昵称且无 from_user 时展示 [用户]', () => {
    const payload: WakeupPayload = {
      peer: PEER,
      timestamp: FIXED_TS,
      from_user: '',
      from_name: '',
      content: '在吗',
      trigger: 'direct',
    };

    expect(formatExternalPrompt(payload)).toBe(`[QQ私聊] [${TIME_STR}] [用户]: 在吗`);
  });

  it('契约 6: 单聊引用回复消息格式（全角冒号紧跟 [引用回复 ...]，无 QQ: 前缀）', () => {
    const payload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1005',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '张三',
      content: '穿风衣会不会冷？',
      trigger: 'quote',
      quoted: {
        msg_id: 'ROBOT1.0_OUT_999',
        ref_idx: 'REFIDX_OUT_999',
        from_name: '智能小助手',
        text: '明天北京最高气温 18 度',
      },
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[QQ私聊] [消息ID: ROBOT1.0_C2C_1005] [${TIME_STR}] [张三 (${HASH16})]：[引用回复 智能小助手: "明天北京最高气温 18 度"] 穿风衣会不会冷？`
    );
    expect(prompt).not.toContain('QQ:');
  });

  it('契约 7: 多模态占位符作为正文自然呈现在冒号后', () => {
    const imagePayload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1006',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '',
      content: '[图片:F:\\cache\\test.png]',
      trigger: 'direct',
    };

    expect(formatExternalPrompt(imagePayload)).toBe(
      `[QQ私聊] [消息ID: ROBOT1.0_C2C_1006] [${TIME_STR}] [${HASH16}]: [图片:F:\\cache\\test.png]`
    );
  });

  it('契约 8: formatWakeupPrompt 对外部消息走 formatExternalPrompt，对系统事件静态委托 SystemEventHub', () => {
    const directPayload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1007',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '',
      content: '测试单聊消息',
      trigger: 'direct',
    };
    expect(formatWakeupPrompt(directPayload)).toBe(formatExternalPrompt(directPayload));

    const sysPayload: WakeupPayload = {
      peer: PEER,
      timestamp: FIXED_TS,
      from_user: '',
      from_name: '',
      content: '',
      trigger: 'scheduled',
      is_system: true,
      system_event: {
        kind: 'scheduled_task',
        peer: PEER,
        taskId: 'task_101',
        taskType: 'once',
        prompt: '提醒用户喝水',
        timestamp: FIXED_TS,
      },
    };
    const sysPrompt = formatWakeupPrompt(sysPayload);
    expect(sysPrompt).toContain('系统事件：[定时任务] [任务编号: #task_101] [QQ私聊]');
    expect(sysPrompt).toContain('任务内容：\n提醒用户喝水');
  });
});
