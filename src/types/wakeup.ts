/**
 * kujira: 单聊唤醒包与会话驱动契约
 */

import type { SystemWakeupEvent } from './system-event.js';

export type WakeupTriggerType = 'direct' | 'quote' | 'scheduled' | 'aggregated' | 'idle_reply';

/** 入站引用消息快照（优先通过 ref_idx 反查库；TMP_ 或未命中时由 msg_elements 回退填充） */
export interface WakeupQuotedInfo {
  short_id?: string;
  time?: number;
  text: string;
}

/**
 * 消息聚合池中的一条待回复消息（精简契约：全部使用短 ID，绝不透出长 `ROBOT1.0_` 锚点）。
 *
 * 池只保存「尚未投递」的真实入站消息；提问/审批答案、wait_for_user_messages 收集
 * 以及运行中 steer 即时投递的消息都不入池，因此模型不会重复看到已处理内容。
 */
export interface AggregatedMessage {
  /** 单聊短消息 ID（如 `msg_<n>`），入池时已解析 */
  short_id?: string;
  /** 归一化后的消息正文（不含引用前缀与附件占位符） */
  content: string;
  /** 消息时间戳（毫秒） */
  time: number;
  /** 引用回复快照：渲染时独立成行 */
  quoted?: WakeupQuotedInfo;
  /** 附件占位符（如 `[图片: ...]`）：渲染时每条独立成行 */
  attachments?: string[];
}

export interface WakeupPayload {
  /** 入站消息 ID（来自 C2C_MESSAGE_CREATE d.id，如 ROBOT1.0_...；仅内部逻辑使用，不在展示头暴露） */
  msg_id?: string;
  /** 单聊短消息 ID（如 msg_<n>） */
  short_id?: string;
  /** 入站消息自身引用索引（来自 message_scene.ext msg_idx=REFIDX_...） */
  ref_idx?: string;
  trigger: WakeupTriggerType;
  /** 定时任务 ID (当 trigger === 'scheduled' 时提供) */
  task_id?: string;
  /** 定时任务说明/规则描述 (当 trigger === 'scheduled' 时提供) */
  task_rule?: string;
  /** 定时任务类型 (当 trigger === 'scheduled' 时提供) */
  task_type?: 'once' | 'recurring';
  /** 聚合周期分钟数 (当 trigger === 'aggregated' 时提供) */
  aggregation_interval_mins?: number;
  /** 沉默时长分钟数 (当 trigger === 'idle_reply' 时提供) */
  idle_minutes?: number;
  peer: string;
  from_user: string;
  from_name: string;
  content: string;
  quoted?: WakeupQuotedInfo;
  /** 是否为系统内部生成的事件（定时任务、聚合投递、冷场搭话） */
  is_system?: boolean;
  /** 对应的强类型系统事件实体（由 SystemEventHub 统一注入） */
  system_event?: SystemWakeupEvent;
  timestamp: number;
}
