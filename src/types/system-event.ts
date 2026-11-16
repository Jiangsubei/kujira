/**
 * kujira: 系统内部事件模型契约
 *
 * 严格区隔“外部真实单聊用户输入”与“系统内部触发事件”，从类型定义层面杜绝：
 * 1. 虚假系统名称进入 from_name 导致会话标题污染；
 * 2. 系统事件充当本轮真人发起人导致审批 Fail-Closed 失效。
 */

/** 系统事件类型辨识标签（仅限真正的内部系统自发事件） */
import type { AggregatedMessage } from './wakeup.js';

export type SystemEventKind = 'scheduled_task' | 'idle_reply';

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
 * 消息聚合批次载荷：轮次边界（自由周期 tick 或 turn/end flush）投递内存池。
 *
 * 注：消息聚合本质是真实入站消息的批次延迟投递，不属于内部系统自发事件，
 * 故已从 SystemWakeupEvent 中剥离，以纯净的自然聊天记录格式呈现给模型。
 */
export interface AggregatedMessagesEvent {
  kind?: 'aggregated_messages';
  peer: string;
  /** 待投递消息快照（按时间顺序；存在时提示词逐条列出） */
  messages?: AggregatedMessage[];
  /**
   * 投递时机：
   * - `period`：自由周期时钟到点（会话空闲时）
   * - `turn_end`：一轮处理结束后的排队消息 flush
   */
  reason?: 'period' | 'turn_end';
  /**
   * 触发本轮聚合的真实发送者身份（peer 内真实用户 openid）。
   * 聚合轮次源于真实用户的入站消息，具备审批发起人资格。
   */
  fromUser?: string;
  /** 聚合周期（分钟），仅用于上下文说明 */
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

/** 全量系统内部事件实体类型（仅限无当轮用户输入的内部自发事件） */
export type SystemWakeupEvent = ScheduledTaskEvent | IdleReplyEvent;
