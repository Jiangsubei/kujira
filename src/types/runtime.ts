/**
 * kujira: 运行时出站队列与入站上下文契约
 */

/**
 * 触发一次唤醒的入站消息上下文
 * 用于出站被动回复锚点（`msg_id`）与引用索引（`ref_idx`）透传；
 * 系统合成事件（`is_synthetic: true`）不得覆盖历史有效入站 `msg_id`。
 */
export interface InboundReplyContext {
  /** 入站被动回复锚点 ID（来自 C2C_MESSAGE_CREATE d.id；严禁写入出站响应 id） */
  msg_id?: string;
  /** 入站引用索引（来自 message_scene.ext 的 msg_idx=REFIDX_...） */
  ref_idx?: string;
  /** 发起者内部标识（peer / hash16 或系统标识） */
  from_user: string;
  /** 是否为系统合成事件（如 scheduled_task） */
  is_synthetic?: boolean;
}

/**
 * Shared per-peer 串行发送器契约
 * 正文、提问、审批、主动发文件与 msg_seq 分配均须经同一串行队列下发，保证同 peer 内发送顺序。
 */
export interface SerialSender {
  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T>;
}
