/**
 * kujira: 单聊外部唤醒提示词统一管理模块 (ExternalPromptFormatter)
 *
 * 核心规范与原则：
 * 1. 严格区分外部真实单聊用户消息与内部系统事件：外部消息绝不添加「系统事件：」前缀；
 * 2. 精简单聊唤醒消息头：彻底移除 `[QQ私聊]` 与所有发送者标识（`openid` / `from_name`），仅保留短消息 ID 与时间戳；
 * 3. 引用回复行内结构化：库命中时还原被引用消息短 ID、时间与正文 `[引用回复: "[msg_...] [时间] 正文"]`；
 * 4. 适配 QQ 官方 Bot 单聊：绝不将长 `ROBOT1.0_...` 或 `REFIDX_...` 注入唤醒提示词。
 */

import type { WakeupPayload, AggregatedMessage } from '../types/index.js';
import { formatDateTime } from '../storage/time-parser.js';
import { isShortMessageId, parseShortMessageId } from '../utils/short-id.js';
import { formatSystemEventPrompt } from './system-event-hub.js';

/** 格式化仅时间部分 HH:mm:ss */
export function formatTimeOnly(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 规范化发送者身份描述（保留导出以兼容过渡期调用方；外部唤醒消息头不再拼入发送者标识） */
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

/** 解析单聊渠道元信息（精简模式下不再注入 `[QQ私聊]` 前缀） */
export function resolveChannelInfo(_peer?: string): { isGroup: false; channelStr: string } {
  return { isGroup: false, channelStr: '' };
}

/** 格式化短消息 ID 标签（仅接收标准短 ID `msg_<n>` / `msg_self_<n>`；长 ID 或无效值返回空串） */
export function formatMsgIdString(shortId: unknown): string {
  const parsed = parseShortMessageId(shortId);
  return parsed ? `[${parsed.shortId}]` : '';
}

/** 格式化引用回复信息块 */
export function formatQuotedString(quoted?: WakeupPayload['quoted']): string {
  if (!quoted) return '';
  const shortId =
    typeof quoted.short_id === 'string' && isShortMessageId(quoted.short_id.trim())
      ? quoted.short_id.trim()
      : '';
  const qText = quoted.text || '';

  if (shortId) {
    const qTimeStr =
      typeof quoted.time === 'number' && Number.isFinite(quoted.time) && quoted.time > 0
        ? formatDateTime(quoted.time)
        : '';
    const qHeader = qTimeStr ? `[${shortId}] [${qTimeStr}]` : `[${shortId}]`;
    return `[引用回复: "${qHeader}${qText ? ` ${qText}` : ''}"]`;
  }

  if (qText) {
    return `[引用回复: "${qText}"]`;
  }
  return '[引用回复]';
}

/**
 * 组装消息正文（普通消息 vs 引用消息）
 */
export function formatMessageBody(
  content: string,
  quoted?: WakeupPayload['quoted']
): string {
  const quotedStr = formatQuotedString(quoted);
  const bodyText = content || '';

  if (quotedStr) {
    return bodyText ? `${quotedStr} ${bodyText}` : quotedStr;
  }

  return bodyText;
}

/**
 * 单聊外部唤醒提示词格式化主入口
 */
export function formatExternalPrompt(payload: WakeupPayload): string {
  const now = payload.timestamp || Date.now();
  const timeStr = formatDateTime(now);
  const timeTag = timeStr ? `[${timeStr}]` : '';

  if (payload.trigger === 'scheduled') {
    const taskTag = payload.task_id ? `[定时任务唤醒: #${payload.task_id}]` : '[定时任务唤醒]';
    const header = [timeTag, taskTag].filter(Boolean).join(' ');
    const ruleTag = payload.task_rule ? `\n[任务类型: ${payload.task_rule}]` : '';
    const guide =
      '（说明：这是此前设定的定时任务触发。发言内容应自然贴切，切勿向用户透露内部 task_id 或系统事件代码等调试信息。）';

    return `${header}${ruleTag}\n${guide}\n\n任务要求/备注:\n${payload.content}`;
  }

  const msgIdStr = formatMsgIdString(payload.short_id);
  const body = formatMessageBody(payload.content, payload.quoted);
  return [msgIdStr, timeTag, body].filter((part) => part !== '').join(' ');
}

/**
 * 把聚合池中的一条消息渲染为逐条段落（`序号. [短 ID] [时间] ...`）。
 * - 单条消息保持紧凑行内呈现：消息头、引用回复、正文与行内附件保持在同一行（与直接唤醒消息的语流格式完全对齐）；
 * - 用户正文原生的换行自然保留（后续行缩进），避免在单条消息内部生硬拆行导致语义断裂。
 */
export function renderAggregatedMessageLines(
  messages: ReadonlyArray<AggregatedMessage>
): string[] {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    const shortId = typeof message.short_id === 'string' && message.short_id.trim() ? message.short_id.trim() : '';
    const timeStr = message.time ? formatDateTime(message.time) : '';
    const header = [shortId ? `[${shortId}]` : '', timeStr ? `[${timeStr}]` : '']
      .filter(Boolean)
      .join(' ');

    const quoted = message.quoted;
    let quotedStr = '';
    if (quoted) {
      const qShortId =
        typeof quoted.short_id === 'string' && quoted.short_id.trim() ? quoted.short_id.trim() : '';
      const qTime = typeof quoted.time === 'number' && quoted.time > 0 ? formatDateTime(quoted.time) : '';
      const qHeader = [qShortId ? `[${qShortId}]` : '', qTime ? `[${qTime}]` : '']
        .filter(Boolean)
        .join(' ');
      const qText = quoted.text ? ` ${quoted.text}` : '';
      quotedStr = `[引用回复: "${qHeader}${qText}"]`;
    }

    let body = message.content ?? '';
    const attachments = (message.attachments ?? []).filter(Boolean);
    const missingAttachments: string[] = [];
    for (const att of attachments) {
      if (!body.includes(att)) {
        missingAttachments.push(att);
      }
    }
    if (missingAttachments.length > 0) {
      body = body ? `${body} ${missingAttachments.join(' ')}` : missingAttachments.join(' ');
    }

    const linePrefix = `${index + 1}. ${header}`.trimEnd();
    const inlineContent = [quotedStr, body].filter(Boolean).join(' ');

    if (!inlineContent) {
      lines.push(linePrefix);
      return;
    }

    // 若正文原生包含换行符，首行紧接消息头，后续换行行适当缩进呈现
    if (inlineContent.includes('\n')) {
      const parts = inlineContent.split('\n');
      lines.push(`${linePrefix} ${parts[0]}`.trimEnd());
      for (let i = 1; i < parts.length; i++) {
        lines.push(`   ${parts[i]}`.trimEnd());
      }
    } else {
      lines.push(`${linePrefix} ${inlineContent}`.trimEnd());
    }
  });
  return lines;
}

/**
 * 格式化单聊消息聚合批次提示词（纯净自然聊天记录流）。
 * 彻底剔除系统事件外壳与多余引导说明，呈现为：
 *
 * [消息聚合] [YYYY-MM-DD HH:mm:ss]
 *
 * 1. [msg_1] [YYYY-MM-DD HH:mm:ss] 消息 1
 * 2. [msg_2] [YYYY-MM-DD HH:mm:ss] 消息 2
 */
export function formatAggregatedPrompt(event: {
  timestamp?: number;
  messages?: ReadonlyArray<AggregatedMessage>;
}): string {
  const now = event.timestamp || Date.now();
  const timeStr = formatDateTime(now);
  const header = `[消息聚合]${timeStr ? ` [${timeStr}]` : ''}`;

  const messages = Array.isArray(event.messages) ? event.messages : [];
  if (messages.length === 0) {
    return header;
  }

  const lines = renderAggregatedMessageLines(messages);
  return `${header}\n\n${lines.join('\n')}`;
}

/**
 * 统一唤醒提示词入口（聚合消息走 formatAggregatedPrompt，系统事件走 SystemEventHub，外部直接消息走 formatExternalPrompt）
 */
export function formatWakeupPrompt(payload: WakeupPayload): string {
  if (payload.trigger === 'aggregated') {
    if (payload.aggregated_messages && payload.aggregated_messages.length > 0) {
      return formatAggregatedPrompt({
        timestamp: payload.timestamp,
        messages: payload.aggregated_messages,
      });
    }
    if (payload.content) {
      return payload.content;
    }
    return formatAggregatedPrompt({
      timestamp: payload.timestamp,
      messages: [],
    });
  }
  if (payload.is_system && payload.system_event) {
    return formatSystemEventPrompt(payload.system_event);
  }
  return formatExternalPrompt(payload);
}
