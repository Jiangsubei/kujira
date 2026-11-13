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
 * 把聚合池中的一条消息渲染为逐条段落（`序号. [短 ID] [时间] ...`）。
 * - 纯文本消息：正文与消息头**同一行**，与正常直接入站消息的格式保持一致；
 * - 带引用或附件：消息头独占一行，引用快照、附件占位符、正文依次缩进另起行。
 */
function renderAggregatedMessageLines(
  messages: ReadonlyArray<{ short_id?: string; content: string; time: number; quoted?: { short_id?: string; time?: number; text: string }; attachments?: string[] }>
): string[] {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    const shortId = typeof message.short_id === 'string' && message.short_id.trim() ? message.short_id.trim() : '';
    const timeStr = message.time ? formatDateTime(message.time) : '';
    const header = [shortId ? `[${shortId}]` : '', timeStr ? `[${timeStr}]` : '']
      .filter(Boolean)
      .join(' ');

    const quoted = message.quoted;
    const attachments = (message.attachments ?? []).filter(Boolean);
    const body = message.content ?? '';

    // 纯文本消息：正文直接跟在消息头同一行，与正常入站消息格式一致
    if (!quoted && attachments.length === 0) {
      lines.push(`${index + 1}. ${header} ${body}`.trimEnd());
      return;
    }

    lines.push(`${index + 1}. ${header}`.trimEnd());

    if (quoted) {
      const qShortId =
        typeof quoted.short_id === 'string' && quoted.short_id.trim() ? quoted.short_id.trim() : '';
      const qTime = typeof quoted.time === 'number' && quoted.time > 0 ? formatDateTime(quoted.time) : '';
      const qHeader = [qShortId ? `[${qShortId}]` : '', qTime ? `[${qTime}]` : '']
        .filter(Boolean)
        .join(' ');
      const qText = quoted.text ? ` ${quoted.text}` : '';
      lines.push(`   [引用回复: "${qHeader}${qText}"]`);
    }

    for (const attachment of attachments) {
      lines.push(`   ${attachment}`);
    }

    if (body) lines.push(`   ${body}`);
  });
  return lines;
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
      const messages = Array.isArray(event.messages) ? event.messages : [];

      // 无消息快照的历史调用：保留「有新消息，去读历史」的兜底语义
      if (messages.length === 0) {
        const guide =
          '（说明：用户在你的上一条回复之后又发来了新消息。' +
          '你必须先调用 read_chat_history 工具，查看自你上次回复以来有什么新消息，再判断如何回复。' +
          '如果此时回复会打扰用户，或者没有值得回应的内容，直接输出 [结束] 即可。' +
          '表现自然，切勿向用户透露消息聚合、或系统唤醒等任何后台痕迹。）';

        return (
          `系统事件：[消息聚合]${timeStr ? ` [${timeStr}]` : ''}\n\n` +
          `会话状态：检测到自上次回复以来有新的用户消息待查看。\n\n` +
          guide
        );
      }

      const count = messages.length;
      const isTurnEnd = event.reason === 'turn_end';
      const stateLine = isTurnEnd
        ? `会话状态：你上一轮处理期间，用户又发来了 ${count} 条新消息。`
        : `会话状态：自你上次回复以来，用户发来了 ${count} 条新消息。`;
      const guide = isTurnEnd
        ? '（说明：以上消息是在你上一轮回复过程中到达的。请先判断它们是否已经被你上一条回复覆盖，或者只是补充、闲聊、情绪表达而无需回应；若已经回应过，或此刻再回复会显得重复、打扰，直接输出 [结束] 即可。确实需要补充回应时，直接针对新内容自然作答；如需更早的上下文，可调用 read_chat_history。切勿向用户透露消息聚合或系统唤醒等任何后台痕迹。）'
        : '（说明：以上是本轮周期内聚合的用户消息，已按时间顺序逐条列出，可直接针对内容回复；如需回顾更早的上下文，可调用 read_chat_history 查询。若此时回复会打扰用户，或没有值得回应的内容，直接输出 [结束] 即可。表现自然，切勿向用户透露消息聚合或系统唤醒等任何后台痕迹。）';

      return (
        `系统事件：[消息聚合]${timeStr ? ` [${timeStr}]` : ''}\n\n` +
        `${stateLine}\n\n` +
        `${renderAggregatedMessageLines(messages).join('\n')}\n\n` +
        guide
      );
    }

    case 'idle_reply': {
      const guide =
        '（说明：当前单聊已经较长时间没有新消息。你可以自主评估是否适合主动发起一个自然的话题、关心近况或延续此前聊过的事情；若需要回顾前情，可先调用 read_chat_history 查看最近的聊天记录。判断适合时通过 send_qq_message 发送给对方，若判断当前不宜打扰，直接输出 [结束] 即可，不必强行发言。切勿向用户透露冷场判定、沉默时长或系统唤醒等任何后台痕迹。）';

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
  /**
   * 解析 peer 对应的真实 openid（来自身份映射表）。
   * 聚合轮次据此登记审批发起人；解析不到时该轮次审批保持 Fail-Closed。
   */
  resolveOpenid?: (peer: string) => string | undefined;
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
    let realFromUser = '';
    if (isAggregated) {
      const explicit = typeof event.fromUser === 'string' ? event.fromUser.trim() : '';
      if (explicit) {
        realFromUser = explicit;
      } else if (this.options.resolveOpenid) {
        try {
          realFromUser = this.options.resolveOpenid(peer)?.trim() ?? '';
        } catch {
          realFromUser = '';
        }
      }
    }

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
