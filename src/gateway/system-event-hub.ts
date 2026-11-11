/**
 * kujira: 系统内部事件与统一唤醒中枢 (SystemEventHub)
 *
 * 核心职责：
 * 1. 统一管理非外部真实用户输入的系统唤醒事件（QQ 单聊定时任务 `scheduled_task`）；
 * 2. 贯彻“标题防污染铁律 (Zero Pseudo-Name)”：严禁在系统事件 Payload 中携带任何假借的用户昵称；
 * 3. 贯彻“零特权审批铁律 (Strict Null Initiator)”：系统事件 `from_user` 锁定为 `''`，审批保持 Fail-Closed；
 * 4. 出站合成上下文追踪 (`is_synthetic: true`)：只标记合成上下文，绝不覆盖擦除历史有效的入站被动 `msg_id` 锚点。
 */

import type { OutboundBridgeLike } from './session/types.js';
import type { ScheduledTaskEvent, SystemWakeupEvent } from '../types/system-event.js';
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
        `系统事件：[定时任务]${taskTag} [QQ私聊] [${timeStr}]${ruleLine}\n\n` +
        `任务内容：\n` +
        `${event.prompt}\n\n` +
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

    // 出站合成上下文自动挂载：仅传 is_synthetic: true，绝不传入 msg_id: undefined 擦除历史有效被动锚点
    const outboundBridge = this.options.outboundBridge ?? this.options.sessionManager.getOutboundBridge?.();
    if (outboundBridge) {
      outboundBridge.trackInboundContext(peer, {
        from_user: '',
        trigger: 'scheduled',
        is_synthetic: true,
      });
    }

    // 构造干净的 WakeupPayload（from_name 与 from_user 严格留空，is_system 为 true）
    const payload: WakeupPayload = {
      peer,
      trigger: 'scheduled',
      from_name: '',
      from_user: '',
      content: promptText,
      timestamp: now,
      is_system: true,
      system_event: event,
      task_id: event.taskId,
      task_type: event.taskType,
      task_rule: event.taskRule,
    };

    return this.options.sessionManager.dispatchWakeup(payload, {
      onMessageCreated: (userMsg) => {
        if (outboundBridge && userMsg?.id) {
          outboundBridge.trackPendingMessage?.(userMsg.id, peer, {
            from_user: '',
            trigger: 'scheduled',
            is_synthetic: true,
          });
        }
        options?.onMessageCreated?.(userMsg);
      },
    });
  }
}
