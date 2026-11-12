/**
 * kujira: 系统内部事件模型契约
 *
 * 严格区隔“外部真实单聊用户输入”与“系统内部触发事件”，从类型定义层面杜绝：
 * 1. 虚假系统名称进入 from_name 导致会话标题污染；
 * 2. 系统事件充当本轮真人发起人导致审批 Fail-Closed 失效。
 */

import type { AggregatedMessage } from './wakeup.js';

/** 系统事件类型辨识标签 */
export type SystemEventKind = 'scheduled_task' | 'aggregated_messages' | 'idle_reply';

/** 定时任务系统事件 */
export interface ScheduledTaskEvent {
  kind: 'scheduled_task';
  peer: string;
  taskId: string;
  taskType: 'once' | 'recurring';
  taskRule?: string;
  prompt: string;
  /** 任务创建者（仅作审计/日志用途，严禁充当当轮唤醒发起人） */
  creator?: string;
  timestamp?: number;
}

/**
 * 消息聚合回复事件：周期窗口到点后，将池内未回复消息一次性交给模型。
 * 语义上是「真实用户消息的延迟投递」，与定时任务的自发语义严格区分。
 */
export interface AggregatedMessagesEvent {
  kind: 'aggregated_messages';
  peer: string;
  /** 本轮聚合的未回复消息快照（按时间升序，已消费即从池中移除） */
  messages: AggregatedMessage[];
  /**
   * 触发本轮聚合的真实发送者身份（peer 内真实用户 openid）。
   * 池内消息均来自该用户的真实入站事件，故聚合轮次具备审批发起人资格；
   * 与 `idle_reply` / `scheduled_task` 的「无真实发起人」严格区分。
   */
  fromUser?: string;
  /** 聚合周期窗口（分钟），仅用于上下文说明 */
  intervalMinutes?: number;
  timestamp?: number;
}

/**
 * 冷场主动搭话事件：长时间无新消息时，由系统自发唤醒模型主动发起话题。
 * 该事件无任何真实用户输入，审批必须保持 Fail-Closed。
 */
export interface IdleReplyEvent {
  kind: 'idle_reply';
  peer: string;
  /** 距最后一条人类消息的沉默时长（分钟） */
  idleMinutes: number;
  timestamp?: number;
}

/** 全量系统事件实体类型 */
export type SystemWakeupEvent = ScheduledTaskEvent | AggregatedMessagesEvent | IdleReplyEvent;
