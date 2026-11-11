/**
 * kujira: Agent 工具入参、出参及执行结果 Schema（QQ 官方 Bot API v2 合规单聊）
 */

import type {
  MessageSource,
  RecurringRule,
  ScheduledTaskStatus,
  ScheduledTaskType,
  SlangEntry,
  FaceSummaryItem,
} from './storage.js';

// ==================== 1. 聊天历史检索（单聊强隔离，禁止跨会话） ====================

export interface ReadChatHistoryParams {
  /** 按消息内容关键词模糊匹配 (SQL LIKE %keyword%) */
  keyword?: string;
  /**
   * 按消息类型筛选，支持单类型或类型数组:
   * 'text' | 'image' | 'sticker' | 'file' | 'forward' | 'record' | 'video' | 'reply' | 'card'
   */
  type?: string | string[];
  /** 起始时间: 支持毫秒数字、秒级数字、相对时间字符串 ("30m", "2h", "1d", "7d")、裸时间 ("19:00", "19:00:00") 或日期时间字符串 ("10-30 19:00", "2026-10-30 12:00:00") */
  since?: number | string;
  /** 截止时间: 支持毫秒数字、秒级数字、相对时间字符串、裸时间 ("20:00") 或日期时间字符串 */
  until?: number | string;
  /** 快捷相对时间窗口: 检索过去指定时间段内的消息 (如 "1h", "6h", "1d", "7d")，等效于 since = now - relative */
  relative?: string;
  /** 是否仅筛选带有文件/图片/多媒体附件的消息 (local_path 或 file_id 不为空) */
  has_file?: boolean;
  /** 查询引用了指定短消息 ID（如 `msg_5` 或 `msg_self_8`）的回复消息 */
  reply_to?: string;
  /** 是否排除机器人自己发出的消息 (self = 0) */
  exclude_self?: boolean;
  /** 是否仅查询机器人自己发出的消息 (self = 1) */
  self_only?: boolean;
  /** 消息来源筛选：单聊仅支持真实 QQ 消息 ('qq') */
  source?: MessageSource;
  /** 起始序号偏移，从 0 开始 (默认 0) */
  offset?: number;
  /** 返回最大条数 (默认 20，上限 100) */
  limit?: number;
  /** 时间排序 (默认 'desc' 倒序，取最新消息) */
  order?: 'asc' | 'desc';
}

export interface ChatMessageSummary {
  /** 短消息 ID（入站 `msg_<n>` / 出站 `msg_self_<n>`） */
  msg_id: string;
  time: number;
  formatted_time?: string;
  type: string;
  content: string;
  recalled: boolean;
  self: boolean;
  /** 被引用消息的短消息 ID（`msg_<n>` / `msg_self_<n>`） */
  reply_to?: string | null;
  local_path?: string | null;
  file_id?: string | null;
  /** 统一附件描述符 JSON（与 MessageRecord.attachments 同源） */
  attachments?: string | null;
  /** 消息来源: 'qq' */
  source?: MessageSource;
}

export interface ReadChatHistoryResult {
  messages: ChatMessageSummary[];
  /** 本次实际返回条数 */
  total: number;
  /** 过滤后匹配的总条数 */
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
}

// ==================== 2. 资源下载与合并转发展开 ====================

export interface FetchResourceItem {
  /** 入站附件索引、文件标识或消息 ID */
  file_id: string;
  /** 保存文件名建议（落盘前执行 basename 与安全净化） */
  file_name?: string;
  /** 可选直链 URL（裸 GET 拉取；严禁在结果中明文回显带凭证 query） */
  url?: string;
}

export interface FetchChatResourceItemResult {
  file_id: string;
  file_name?: string;
  success: boolean;
  local_path?: string;
  error?: string;
}

export interface FetchChatResourceParams {
  file_id?: string;
  file_name?: string;
  url?: string;
  /** 可选：仅接收短消息 ID（`msg_<n>` / `msg_self_<n>`），重新拉取该条消息关联的入站附件 */
  msg_id?: string;
  files?: FetchResourceItem[];
}

export interface FetchChatResourceResult {
  success: boolean;
  local_path?: string;
  error?: string;
  total?: number;
  downloaded_count?: number;
  results?: FetchChatResourceItemResult[];
}

/** 展开合并转发入参（适配 QQ 官方 Bot message_type=102 展开文本与内嵌图片提取） */
export interface ExpandForwardMessageParams {
  /** 入站合并转发消息的短消息 ID（仅接收 `msg_<n>` / `msg_self_<n>`，优先查库获取 message_type=102 原始内容并提取内嵌图片） */
  msg_id?: string;
  /** 可选：直接传入的 message_type=102 合并转发原文 */
  content?: string;
  /** 可选兼容别名：仅接收短消息 ID（`msg_<n>` / `msg_self_<n>`，等价于 msg_id） */
  forward_id?: string;
}

/** 合并转发节点中提取的内嵌附件摘要（URL 仅内部裸 GET 使用，不对外暴露带凭证地址） */
export interface ForwardEmbeddedAttachment {
  type?: string;
  filename?: string;
  dimensions?: string;
  size_text?: string;
  local_path?: string;
  error?: string;
}

/** 合并转发单条展开节点（适配官方 message_type=102 结构化文本段落） */
export interface ForwardNode {
  /** 节点序号（如 === 消息 1 ===） */
  index?: number;
  /** 节点文本中解析出的展示名（[发送者]） */
  sender_name?: string;
  /** 节点正文内容（已剥离含访问凭证的原始下载 URL） */
  content: string;
  /** 从节点 [附件k] 提取并尝试裸 GET 落盘的附件列表 */
  attachments?: ForwardEmbeddedAttachment[];
}

export interface ExpandForwardMessageResult {
  success: boolean;
  /** 合并转发首行标题（若有） */
  title?: string;
  messages?: ForwardNode[];
  /** 本次展开中成功裸 GET 落盘的内嵌图片数量（缺省表示无新增落盘） */
  images_downloaded?: number;
  error?: string;
}

// ==================== 3. 消息/文件发送、撤回与轻量等待 ====================

export interface SendFileParams {
  file_path: string;
  file_type?: 'image' | 'file' | 'video' | 'voice';
}

export interface SendFileResult {
  success: boolean;
  /** 短出站消息 ID（如 `msg_self_12`，可用于 120s 内撤回或后续引用） */
  message_id?: string;
  error?: string;
}

export interface SendQqMessageParams {
  text: string;
  /** 引用的目标短消息 ID（如 `msg_12` 或 `msg_self_8`） */
  reply_to?: string;
}

export interface SendQqMessageResult {
  success: boolean;
  /** 短出站消息 ID（如 `msg_self_12`，可用于 120s 内撤回或后续引用） */
  message_id?: string;
  error?: string;
  sent_preview?: string;
}

export interface RecallMessageParams {
  /** 需要撤回的机器人自身短出站消息 ID（仅接收 `msg_self_<n>`，严格限制 120 秒内） */
  message_id: string;
}

export interface RecallMessageResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface WaitForUserMessagesParams {
  /** 等待超时秒数（正数） */
  timeout?: number;
}

// ==================== 4. 表情包工具 ====================

export interface ListFacesParams {
  query?: string;
  tag?: string;
  mood?: string;
  untagged?: boolean;
  offset?: number;
  limit?: number;
}

export interface ListFacesResult {
  faces: FaceSummaryItem[];
  /** 本次实际返回条数 */
  total: number;
  /** 过滤后匹配的总条数 */
  total_matched: number;
  offset: number;
  limit: number;
  has_more: boolean;
  message?: string;
}

export interface SendFaceParams {
  face_id: string;
}

export interface SendFaceResult {
  success: boolean;
  /** 短出站消息 ID（如 `msg_self_12`，可用于 120s 内撤回或后续引用） */
  message_id?: string;
  error?: string;
}

export interface CollectFaceParams {
  tags: string[];
  mood: string;
  /** 仅接收短消息 ID（如 `msg_<n>` 或 `msg_self_<n>`），指定要提取表情图片的目标消息 */
  message_id?: string;
}

export interface CollectFaceResult {
  success: boolean;
  duplicated?: boolean;
  face_id?: string;
  message?: string;
  error?: string;
}

export interface ManageFacesParams {
  action: 'update' | 'delete' | 'query_quota' | 'evict';
  face_id?: string;
  tags?: string[];
  mood?: string;
  count?: number;
}

export interface ManageFacesResult {
  success: boolean;
  action?: 'update' | 'delete' | 'query_quota' | 'evict';
  face_id?: string;
  total?: number;
  max_quota?: number;
  available?: number;
  total_bytes?: number;
  evicted_count?: number;
  message?: string;
  error?: string;
}

// ==================== 5. 定时任务工具 ====================

export interface ScheduleTaskParams {
  prompt: string;
  delay_seconds?: number;
  execute_at?: string;
  recurring?: RecurringRule;
}

export interface ScheduleTaskResult {
  [key: string]: any;
  success: boolean;
  task_id?: string;
  next_run_at?: number;
  formatted_next_run?: string;
  rule_description?: string;
  error?: string;
}

export interface ManageScheduledTasksParams {
  action: 'list' | 'cancel' | 'update';
  task_id?: string;
  prompt?: string;
  delay_seconds?: number;
  execute_at?: string;
  recurring?: RecurringRule;
}

export interface ScheduledTaskSummary {
  id: string;
  peer: string;
  creator: string;
  prompt: string;
  type: ScheduledTaskType;
  next_run_at: number;
  formatted_next_run: string;
  rule_description: string;
  status: ScheduledTaskStatus;
}

export interface ManageScheduledTasksResult {
  [key: string]: any;
  success: boolean;
  action: 'list' | 'cancel' | 'update';
  tasks?: ScheduledTaskSummary[];
  task?: ScheduledTaskSummary;
  error?: string;
}

// ==================== 6. 黑话工具 ====================

export interface QuerySlangParams {
  term: string;
}

export interface QuerySlangResult {
  [key: string]: any;
  success: boolean;
  entry?: SlangEntry;
  message?: string;
  error?: string;
}

export interface RecordSlangParams {
  term: string;
  tags: string;
  definition: string;
  example: string;
}

export interface RecordSlangResult {
  [key: string]: any;
  success: boolean;
  entry?: SlangEntry;
  action: 'created' | 'updated';
  total: number;
  max_entries: number;
  evicted_term?: string;
  message?: string;
  error?: string;
}

export interface ManageSlangParams {
  action: 'list' | 'edit' | 'delete';
  term?: string;
  new_term?: string;
  tags?: string;
  definition?: string;
  example?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
}

export interface ManageSlangResult {
  [key: string]: any;
  success: boolean;
  action: 'list' | 'edit' | 'delete';
  entries?: SlangEntry[];
  entry?: SlangEntry;
  total?: number;
  total_matched?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  max_entries?: number;
  message?: string;
  error?: string;
}

// ==================== 7. 记忆工具（单聊强隔离，禁止跨会话） ====================

export type MemoryScope = 'session' | 'user';

/**
 * 读取当前单聊会话记忆入参（禁止跨会话调用：始终绑定当前会话 peer，不提供跨会话目标参数）
 */
export interface ReadMemoryParams {
  /** 记忆类型：'session' 表示当前会话规则与文化；'user' 表示当前对话用户画像 */
  type?: MemoryScope;
}

/**
 * 创建当前单聊会话记忆入参（禁止跨会话调用：始终绑定当前会话 peer，不提供跨会话目标参数）
 */
export interface CreateMemoryParams {
  type: MemoryScope;
  content: string;
}

/**
 * 编辑当前单聊会话记忆入参（禁止跨会话调用：始终绑定当前会话 peer，不提供跨会话目标参数）
 */
export interface EditMemoryParams {
  type: MemoryScope;
  old_string: string;
  new_string?: string;
}

export interface MemoryToolResult {
  success: boolean;
  message?: string;
  type?: MemoryScope;
  target?: string;
  content?: string;
  preview?: string;
}

export type ReadMemoryResult = MemoryToolResult;
export type ReadMemoryArgs = ReadMemoryParams;
export type CreateMemoryArgs = CreateMemoryParams;
export type EditMemoryArgs = EditMemoryParams;
