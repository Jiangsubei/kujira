/**
 * kujira: 单聊唤醒包与会话驱动契约
 */

import type { SystemWakeupEvent } from './system-event.js';

export type WakeupTriggerType = 'direct' | 'quote' | 'scheduled';

/** 入站引用消息快照（优先通过 ref_idx 反查库；TMP_ 或未命中时由 msg_elements 回退填充） */
export interface WakeupQuotedInfo {
  short_id?: string;
  time?: number;
  text: string;
  images?: string[];
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
  peer: string;
  from_user: string;
  from_name: string;
  content: string;
  quoted?: WakeupQuotedInfo;
  images?: string[];
  /** 是否为系统内部生成的事件（定时任务，非真实用户消息） */
  is_system?: boolean;
  /** 对应的强类型系统事件实体（由 SystemEventHub 统一注入） */
  system_event?: SystemWakeupEvent;
  timestamp: number;
}
