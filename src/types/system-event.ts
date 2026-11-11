/**
 * kujira: 系统内部事件模型契约
 *
 * 严格区隔“外部真实单聊用户输入”与“系统内部定时任务触发事件”，从类型定义层面杜绝：
 * 1. 虚假系统名称进入 from_name 导致会话标题污染；
 * 2. 系统事件充当本轮真人发起人导致审批 Fail-Closed 失效。
 */

/** 系统事件类型辨识标签 */
export type SystemEventKind = 'scheduled_task';

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

/** 全量系统事件实体类型 */
export type SystemWakeupEvent = ScheduledTaskEvent;
