/**
 * kujira: 单聊外部唤醒提示词统一管理模块 (ExternalPromptFormatter)
 *
 * 核心规范与原则：
 * 1. 严格区分外部真实单聊用户消息与内部系统事件：外部消息绝不添加「系统事件：」前缀；
 * 2. 真实聊天语义自然连贯：发送者与消息正文通过冒号行内连接；
 * 3. 引用回复行内结构化：发送者中文冒号紧跟 `[引用回复 被引用者: "原文"]`，空格后承接当前内容；
 * 4. 适配 QQ 官方 Bot 单聊：无群聊、无 `QQ:` 号码前缀、`formatMsgIdString` 接收非空字符串（如 `ROBOT1.0_...`）。
 */

import type { WakeupPayload } from '../types/index.js';
import { formatDateTime } from '../storage/time-parser.js';
import { formatSystemEventPrompt } from './system-event-hub.js';

/** 格式化仅时间部分 HH:mm:ss */
export function formatTimeOnly(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 规范化发送者身份描述（无 QQ: 前缀；无昵称且无用户标识时输出 [用户]） */
export function formatSenderString(fromName?: string, fromUser?: string): string {
  const name = fromName?.trim();
  const user = fromUser?.trim();
  if (name && user) {
    return `[${name} (${user})]`;
  }
  if (user) {
    return `[${user}]`;
  }
  if (name) {
    return `[${name}]`;
  }
  return '[用户]';
}

/** 解析单聊渠道元信息 */
export function resolveChannelInfo(_peer?: string): { isGroup: false; channelStr: string } {
  return { isGroup: false, channelStr: '[QQ私聊]' };
}

/** 格式化消息 ID 标签（接收非空字符串或非零安全整数，无效值返回空串） */
export function formatMsgIdString(msgId: unknown): string {
  if (typeof msgId === 'string') {
    const trimmed = msgId.trim();
    if (trimmed !== '') {
      return ` [消息ID: ${trimmed}]`;
    }
    return '';
  }
  if (typeof msgId === 'number' && Number.isSafeInteger(msgId) && msgId !== 0) {
    return ` [消息ID: ${msgId}]`;
  }
  return '';
}

/** 格式化引用回复信息块 */
export function formatQuotedString(quoted?: WakeupPayload['quoted']): string {
  if (!quoted) return '';
  const fromName = quoted.from_name?.trim();
  const userId = quoted.user_id?.trim();
  const refTarget = quoted.msg_id?.trim() || quoted.ref_idx?.trim();

  let quotedSender = '';
  if (fromName && userId) {
    quotedSender = `${fromName} (${userId})`;
  } else if (fromName) {
    quotedSender = fromName;
  } else if (userId) {
    quotedSender = userId;
  } else if (refTarget) {
    quotedSender = `消息ID: ${refTarget}`;
  } else {
    quotedSender = '历史消息';
  }
  const textPart = quoted.text ? `: "${quoted.text}"` : '';
  return `[引用回复 ${quotedSender}${textPart}]`;
}

/**
 * 组装发送者与消息正文（普通消息 vs 引用消息）
 */
export function formatMessageBody(
  senderStr: string,
  content: string,
  quoted?: WakeupPayload['quoted']
): string {
  const quotedStr = formatQuotedString(quoted);
  const trimmedContent = content || '';

  if (quotedStr) {
    return trimmedContent
      ? `${senderStr}：${quotedStr} ${trimmedContent}`
      : `${senderStr}：${quotedStr}`;
  }

  return trimmedContent
    ? `${senderStr}: ${trimmedContent}`
    : senderStr;
}

/**
 * 单聊外部唤醒提示词格式化主入口
 */
export function formatExternalPrompt(payload: WakeupPayload): string {
  const { channelStr } = resolveChannelInfo(payload.peer);
  const fromUser = payload.from_user || '';
  const fromName = payload.from_name || '';
  const senderStr = formatSenderString(fromName, fromUser);

  const now = payload.timestamp || Date.now();
  const timeStr = formatDateTime(now);
  const msgIdStr = formatMsgIdString(payload.msg_id);
  const headerTime = timeStr ? ` [${timeStr}]` : '';

  if (payload.trigger === 'scheduled') {
    const taskTag = payload.task_id ? ` [定时任务唤醒: #${payload.task_id}]` : ' [定时任务唤醒]';
    const ruleTag = payload.task_rule ? `\n[任务类型: ${payload.task_rule}]` : '';
    const guide =
      '（说明：这是此前设定的定时任务触发。发言内容应自然贴切，切勿向用户透露内部 task_id 或系统事件代码等调试信息。）';

    return `${channelStr}${headerTime}${taskTag}${ruleTag}\n${guide}\n\n任务要求/备注:\n${payload.content}`;
  }

  const body = formatMessageBody(senderStr, payload.content, payload.quoted);
  return `${channelStr}${msgIdStr}${headerTime} ${body}`;
}

/**
 * 统一唤醒提示词入口（系统事件静态委托给 SystemEventHub，外部消息走 formatExternalPrompt）
 */
export function formatWakeupPrompt(payload: WakeupPayload): string {
  if (payload.is_system && payload.system_event) {
    return formatSystemEventPrompt(payload.system_event);
  }
  return formatExternalPrompt(payload);
}
