/**
 * 契约测试：单聊外部唤醒提示词统一模块 (ExternalPromptFormatter)
 * 验证精简短 ID 唤醒格式：无 `[QQ私聊]`、无发送者标识（openid / from_name）、仅使用短 ID `msg_<n>` / `msg_self_<n>`、静态委托 SystemEventHub。
 */

import { describe, it, expect } from 'vitest';
import {
  formatExternalPrompt,
  formatMsgIdString,
  formatQuotedString,
  formatSenderString,
  formatWakeupPrompt,
  resolveChannelInfo,
} from '../../src/gateway/external-prompt.js';
import type { WakeupPayload } from '../../src/types/index.js';

describe('外部唤醒提示词统一模块契约 (Kujira C2C ExternalPromptFormatter)', () => {
  const FIXED_TS = new Date(2026, 10, 11, 22, 58, 59).getTime(); // 2026-11-11 22:58:59
  const TIME_STR = '2026-11-11 22:58:59';
  const QUOTED_TS = new Date(2026, 10, 11, 22, 50, 10).getTime(); // 2026-11-11 22:50:10
  const QUOTED_TIME_STR = '2026-11-11 22:50:10';
  const PEER = 'user_a1b2c3d4e5f60708';
  const HASH16 = 'a1b2c3d4e5f60708';

  it('契约 1: formatSenderString 保留过渡期兼容性（不在外部唤醒提示词中输出）', () => {
    expect(formatSenderString('李四', HASH16)).toBe(`[李四 (${HASH16})]`);
    expect(formatSenderString('', HASH16)).toBe(`[${HASH16}]`);
    expect(formatSenderString('李四', '')).toBe('[李四]');
    expect(formatSenderString('', '')).toBe('[用户]');
    expect(formatSenderString(undefined, undefined)).toBe('[用户]');
  });

  it('契约 2: formatMsgIdString 仅接受合法短 ID（msg_<n> / msg_self_<n>），绝不拼入长 ROBOT1.0_ ID', () => {
    expect(formatMsgIdString('msg_12')).toBe('[msg_12]');
    expect(formatMsgIdString('  msg_self_8  ')).toBe('[msg_self_8]');
    expect(formatMsgIdString('ROBOT1.0_abc_xyz_001')).toBe('');
    expect(formatMsgIdString('')).toBe('');
    expect(formatMsgIdString('   ')).toBe('');
    expect(formatMsgIdString(undefined)).toBe('');
    expect(formatMsgIdString(null)).toBe('');
  });

  it('契约 3: resolveChannelInfo 精简模式下不再返回 [QQ私聊]', () => {
    expect(resolveChannelInfo(PEER)).toEqual({ isGroup: false, channelStr: '' });
  });

  it('契约 4: 单聊直接唤醒格式（[short_id] [时间] 正文；无 [QQ私聊]、无发送者标识、不泄露长 msg_id）', () => {
    const payload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1001',
      short_id: 'msg_12',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '张三',
      content: '你好呀，今天天气不错',
      trigger: 'direct',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(`[msg_12] [${TIME_STR}] 你好呀，今天天气不错`);
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain('ROBOT1.0_C2C_1001');
    expect(prompt).not.toContain('[消息ID:');
    expect(prompt).not.toContain(HASH16);
    expect(prompt).not.toContain('张三');
    expect(prompt).not.toContain('系统事件：');
    expect(prompt).not.toContain('QQ:');
  });

  it('契约 5: 无 short_id 时仅输出 [时间] 正文（即使 payload.msg_id 存在长 ID 也绝不拼入）', () => {
    const payload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1002',
      timestamp: FIXED_TS,
      from_user: '',
      from_name: '',
      content: '在吗',
      trigger: 'direct',
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(`[${TIME_STR}] 在吗`);
    expect(prompt).not.toContain('ROBOT1.0_C2C_1002');
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain('[用户]');
  });

  it('契约 6: 单聊引用回复格式化（库命中带 short_id/时间；TMP_/未知历史降级）', () => {
    const payload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1005',
      short_id: 'msg_15',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '张三',
      content: '穿风衣会不会冷？',
      trigger: 'quote',
      quoted: {
        short_id: 'msg_self_8',
        time: QUOTED_TS,
        text: '明天北京最高气温 18 度',
      },
    };

    const prompt = formatExternalPrompt(payload);
    expect(prompt).toBe(
      `[msg_15] [${TIME_STR}] [引用回复: "[msg_self_8] [${QUOTED_TIME_STR}] 明天北京最高气温 18 度"] 穿风衣会不会冷？`
    );
    expect(prompt).not.toContain('[QQ私聊]');
    expect(prompt).not.toContain('ROBOT1.0_C2C_1005');
    expect(prompt).not.toContain('张三');
    expect(prompt).not.toContain(HASH16);

    // 库命中但缺省时间 / 空 text
    expect(formatQuotedString({ short_id: 'msg_self_8', text: '原消息' })).toBe(
      '[引用回复: "[msg_self_8] 原消息"]'
    );
    expect(formatQuotedString({ short_id: 'msg_self_8', time: QUOTED_TS, text: '' })).toBe(
      `[引用回复: "[msg_self_8] [${QUOTED_TIME_STR}]"]`
    );

    // TMP_ / 未知历史（无 short_id）
    expect(formatQuotedString({ text: '服务端下发的原始引用内容' })).toBe(
      '[引用回复: "服务端下发的原始引用内容"]'
    );
    expect(formatQuotedString({ text: '' })).toBe('[引用回复]');

    // 引用回复但当前消息正文为空
    const quoteOnlyPrompt = formatExternalPrompt({ ...payload, content: '' });
    expect(quoteOnlyPrompt).toBe(
      `[msg_15] [${TIME_STR}] [引用回复: "[msg_self_8] [${QUOTED_TIME_STR}] 明天北京最高气温 18 度"]`
    );
  });

  it('契约 7: 多模态占位符作为正文自然呈现在头信息之后', () => {
    const imagePayload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1006',
      short_id: 'msg_16',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '',
      content: '[图片:F:\\cache\\test.png]',
      trigger: 'direct',
    };

    expect(formatExternalPrompt(imagePayload)).toBe(
      `[msg_16] [${TIME_STR}] [图片:F:\\cache\\test.png]`
    );
  });

  it('契约 8: 定时任务触发（external & SystemEventHub）均不含 [QQ私聊]，且 formatWakeupPrompt 正确委派', () => {
    const directPayload: WakeupPayload = {
      peer: PEER,
      msg_id: 'ROBOT1.0_C2C_1007',
      short_id: 'msg_17',
      timestamp: FIXED_TS,
      from_user: HASH16,
      from_name: '',
      content: '测试单聊消息',
      trigger: 'direct',
    };
    expect(formatWakeupPrompt(directPayload)).toBe(formatExternalPrompt(directPayload));

    const externalScheduledPayload: WakeupPayload = {
      peer: PEER,
      timestamp: FIXED_TS,
      from_user: '',
      from_name: '',
      content: '提醒用户起身活动',
      trigger: 'scheduled',
      task_id: 'task_99',
      task_rule: '一次性定时',
    };
    const extScheduledPrompt = formatExternalPrompt(externalScheduledPayload);
    expect(extScheduledPrompt).toMatch(/^\[2026-11-11 22:58:59\] \[定时任务唤醒: #task_99\]/);
    expect(extScheduledPrompt).not.toContain('[QQ私聊]');

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
    expect(sysPrompt).toContain(`系统事件：[定时任务] [任务编号: #task_101] [${TIME_STR}]`);
    expect(sysPrompt).not.toContain('[QQ私聊]');
    expect(sysPrompt).toContain('任务内容：\n提醒用户喝水');
  });
});
