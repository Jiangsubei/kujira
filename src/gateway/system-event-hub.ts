/**
 * kujira: 系统内部事件与统一唤醒中枢 (SystemEventHub)
 *
 * 核心职责：
 * 1. 统一管理非外部真实用户输入的系统唤醒事件（定时任务、消息聚合投递、冷场主动搭话）；
 * 2. 贯彻“标题防污染铁律 (Zero Pseudo-Name)”：严禁在系统事件 Payload 中携带任何假借的用户昵称；
 * 3. 贯彻“零特权审批铁律 (Strict Null Initiator)”：系统事件 `from_user` 锁定为 `''`，审批保持 Fail-Closed；
 * 4. 出站合成上下文追踪 (`is_synthetic: true`)：只标记合成上下文，绝不覆盖擦除历史有效的入站被动 `msg_id` 锚点。
 */

import type { OutboundBridgeLike } from './session/types.js';
import type { ScheduledTaskEvent, SystemWakeupEvent, AggregatedMessagesEvent, IdleReplyEvent } from '../types/system-event.js';
import type { WakeupPayload } from '../types/index.js';
import { formatDateTime } from '../storage/time-parser.js';
import { isShortMessageId } from '../utils/short-id.js';

/** 格式化短消息 ID 标签（仅接受 `msg_<n>` / `msg_self_<n>`；本地内联以避免与 external-prompt 循环依赖） */
function formatShortIdTag(shortId: unknown): string {
  const raw = typeof shortId === 'string' ? shortId.trim() : '';
  return raw && isShortMessageId(raw) ? `[${raw}]` : '';
}

export interface SystemEventSessionManager {
  dispatchWakeup(
    payload: WakeupPayload,
    options?: {
      onMessageCreated?: (userMsg: any) => void;
    }
  ): Promise<any>;
  getOutboundBridge?(): OutboundBridgeLike | undefined;
}

export function formatTimeOnly(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 格式化系统事件的标准提示词文本（QQ 官方 Bot 单聊）。
 * 骨架：双换行分段、中文冒号标引、行为引导置底。
 */
export function formatSystemEventPrompt(event: SystemWakeupEvent): string {
  const now = event.timestamp || Date.now();
  const timeStr = formatDateTime(now);

  switch (event.kind) {
    case 'scheduled_task': {
      const taskTag = event.taskId ? ` [任务编号: #${event.taskId}]` : '';
      const ruleLine = event.taskRule ? `\n任务规则：${event.taskRule}` : '';
      const guide =
        '（说明：这是此前在当前 QQ 单聊中设定的定时任务触发。如需回顾前序聊天背景，可先调用 read_chat_history 工具查询最近记录；发言内容应自然贴切，请通过 send_qq_message 发送给对方，切勿向用户透露内部 task_id 或系统事件代码等调试信息。）';

      return (
        `系统事件：[定时任务]${taskTag}${timeStr ? ` [${timeStr}]` : ''}${ruleLine}\n\n` +
        `任务内容：\n` +
        `${event.prompt}\n\n` +
        guide
      );
    }

    case 'aggregated_messages': {
      const intervalTag = event.intervalMinutes
        ? ` [聚合窗口: ${event.intervalMinutes} 分钟]`
        : '';
      const lines: string[] = [];
      for (const m of event.messages) {
        const timeTag = m.time && !Number.isNaN(m.time) ? `[${formatDateTime(m.time)}]` : '';
        const idTag = formatShortIdTag(m.short_id);
        const parts = [idTag, timeTag, m.content].filter((p) => p !== '');
        lines.push(parts.join(' '));
      }
      const listContent = lines.join('\n') || '（本轮无待回复消息）';

      const guide =
        '（说明：以上是你在最近一个聚合窗口内尚未回复的连续单聊消息，已按时间顺序列出。请综合理解整段对话的意图后，通过 send_qq_message 一次性作出完整回应，不要逐条机械复读；若前文不足可先调用 read_chat_history 补齐。表现自然，切勿向用户透露消息聚合、窗口或系统唤醒等任何后台痕迹。）';

      return (
        `系统事件：[消息聚合]${intervalTag}${timeStr ? ` [${timeStr}]` : ''}\n\n` +
        `待回复消息：\n` +
        `${listContent}\n\n` +
        guide
      );
    }

    case 'idle_reply': {
      const guide =
        '（说明：当前单聊已经较长时间没有新消息。你可以自主评估是否适合主动发起一个自然的话题、关心近况或延续此前聊过的事情，并通过 send_qq_message 发送给对方；若判断当前不宜打扰，直接输出 [结束] 即可，不必强行发言。切勿向用户透露冷场判定、沉默时长或系统唤醒等任何后台痕迹。）';

      return (
        `系统事件：[冷场陪伴]${timeStr ? ` [${timeStr}]` : ''}\n\n` +
        `会话状态：已连续约 ${event.idleMinutes} 分钟没有新的用户消息。\n\n` +
        guide
      );
    }
  }
}

export interface SystemEventHubOptions {
  sessionManager: SystemEventSessionManager;
  outboundBridge?: OutboundBridgeLike;
  logger?: any;
}

export class SystemEventHub {
  constructor(private options: SystemEventHubOptions) {}

  /** 分发单聊定时任务唤醒 */
  public async dispatchScheduledTask(
    event: Omit<ScheduledTaskEvent, 'kind'>,
    options?: { onMessageCreated?: (userMsg: any) => void }
  ): Promise<any> {
    return this.dispatchSystemEvent({ kind: 'scheduled_task', ...event }, options);
  }

  /** 分发单聊消息聚合回复唤醒（周期窗口到点，整批未回复消息一次性投递） */
  public async dispatchAggregatedMessages(
    event: Omit<AggregatedMessagesEvent, 'kind'>,
    options?: { onMessageCreated?: (userMsg: any) => void }
  ): Promise<any> {
    return this.dispatchSystemEvent({ kind: 'aggregated_messages', ...event }, options);
  }

  /** 分发单聊冷场主动搭话唤醒 */
  public async dispatchIdleReply(
    event: Omit<IdleReplyEvent, 'kind'>,
    options?: { onMessageCreated?: (userMsg: any) => void }
  ): Promise<any> {
    return this.dispatchSystemEvent({ kind: 'idle_reply', ...event }, options);
  }

  /**
   * 底层统一分发收敛核心（Zero-Leak / Null-Initiator）
   */
  public async dispatchSystemEvent(
    event: SystemWakeupEvent,
    options?: { onMessageCreated?: (userMsg: any) => void }
  ): Promise<any> {
    const peer = event.peer;
    const now = event.timestamp || Date.now();
    const promptText = formatSystemEventPrompt(event);

    // 事件类型 → 底层唤醒触发类型映射（聚合投递仍属系统合成事件，审批保持 Fail-Closed）
    const trigger: WakeupPayload['trigger'] =
      event.kind === 'aggregated_messages'
        ? 'aggregated'
        : event.kind === 'idle_reply'
          ? 'idle_reply'
          : 'scheduled';

    // 出站合成上下文自动挂载：仅传 is_synthetic: true，绝不传入 msg_id: undefined 擦除历史有效被动锚点
    const outboundBridge = this.options.outboundBridge ?? this.options.sessionManager.getOutboundBridge?.();
    if (outboundBridge) {
      outboundBridge.trackInboundContext(peer, {
        from_user: '',
        trigger,
        is_synthetic: true,
      });
    }

    // 构造干净的 WakeupPayload。
    // 关键区分：聚合投递来自真实用户消息（携带真实 from_user），具备审批发起人资格；
    // 定时任务与冷场搭话为系统自发，from_user 严格留空，审批保持 Fail-Closed。
    const isAggregated = event.kind === 'aggregated_messages';
    const realFromUser = isAggregated ? (event.fromUser ?? '') : '';

    const payload: WakeupPayload = {
      peer,
      trigger,
      from_name: '',
      from_user: realFromUser,
      content: promptText,
      timestamp: now,
      is_system: true,
      system_event: event,
      ...(event.kind === 'scheduled_task'
        ? { task_id: event.taskId, task_type: event.taskType, task_rule: event.taskRule }
        : {}),
      ...(isAggregated
        ? {
            aggregated_messages: event.messages,
            ...(event.intervalMinutes !== undefined
              ? { aggregation_interval_mins: event.intervalMinutes }
              : {}),
          }
        : {}),
      ...(event.kind === 'idle_reply' ? { idle_minutes: event.idleMinutes } : {}),
    };

    return this.options.sessionManager.dispatchWakeup(payload, {
      onMessageCreated: (userMsg) => {
        if (outboundBridge && userMsg?.id) {
          outboundBridge.trackPendingMessage?.(userMsg.id, peer, {
            from_user: '',
            trigger,
            is_synthetic: true,
          });
        }
        options?.onMessageCreated?.(userMsg);
      },
    });
  }
}
