/**
 * kujira: SQLite 持久化表契约与存储模型
 */

/** 消息来源：qq = QQ 官方 Bot 单聊收发 */
export type MessageSource = 'qq';

export interface MessageRecord {
  msg_id: string;
  peer: string;
  user_id: string;
  sender_name: string;
  time: number; // 毫秒时间戳
  type: string;
  content: string;
  raw: string; // 原始 JSON 字符串
  file_id: string | null;
  local_path: string | null;
  fingerprint: string | null;
  recalled: number; // 0 | 1
  self: number; // 0 | 1
  reply_to: string | null;
  /** 消息引用索引（入站 message_scene.ext msg_idx 或出站 ext_info.ref_idx，形如 REFIDX_...） */
  ref_idx?: string | null;
  /** 消息来源，缺省视为 'qq' */
  source?: MessageSource;
  /** 统一附件描述符 JSON（精简数组，不含原始事件或带凭证 URL 明文） */
  attachments?: string | null;
}

/** 方案 A 身份映射表：内部 peer (`user_<hash16>`) 与真实 `openid` 双向映射 */
export interface PeerOpenidMapping {
  peer: string;
  openid: string;
  remark: string;
  updated_at: number; // 毫秒时间戳
}

/** 入站被动回复锚点与 `msg_seq` 槽位持久化表 */
export interface InboundReplySlot {
  msg_id: string;
  peer: string;
  openid: string;
  last_seq: number;
  received_at: number; // 毫秒时间戳
  invalidated: number; // 0 | 1
  updated_at: number; // 毫秒时间戳
}

/** 富媒体四步上传 `file_info` 本地缓存表（主键 `(openid, md5, file_type)`） */
export interface MediaUploadCacheRecord {
  openid: string;
  md5: string;
  /** 1=图片, 2=视频, 3=语音, 4=文件 */
  file_type: number;
  file_info: string;
  file_uuid?: string;
  expires_at: number; // 毫秒时间戳
}

export interface FaceRecord {
  id: string;
  file_path: string;
  md5: string;
  added_at: number;
  source: 'curate' | 'manual' | 'collect';
  tags: string[];
  mood?: string;
  enabled: boolean;
  size: number;
  format: string; // 'png' | 'jpg' | 'gif' | 'webp'
  last_used_at?: number;
  use_count: number;
  deleted_at?: number | null; // 软删除时间戳（7 天后悔期保留），null/undefined 表示活跃
}

export interface FaceMoodSummary {
  total: number;
  moods: Array<{ mood: string; count: number }>;
}

export interface FaceQueryOptions {
  query?: string;
  tag?: string;
  mood?: string;
  untagged?: boolean;
  enabledOnly?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  cursor?: string;
  orderBy?: 'added_at' | 'last_used_at' | 'use_count';
  order?: 'asc' | 'desc';
}

export interface FaceSummaryItem {
  id: string;
  tags: string[];
  mood?: string;
  format: string;
  file_path?: string;
}

export type ScheduledTaskStatus = 'pending' | 'completed' | 'cancelled';
export type ScheduledTaskType = 'once' | 'recurring';
export type RecurringFrequency = 'daily' | 'weekdays' | 'weekends' | 'custom';

export interface RecurringRule {
  frequency: RecurringFrequency;
  /** 每日触发时间点，格式 HH:mm，如 '09:30' */
  time_of_day?: string;
  /** 自定义星期几：1=周一, 7=周日 */
  days_of_week?: number[];
}

export interface ScheduledTaskRecord {
  id: string;
  peer: string;
  creator: string;
  prompt: string;
  type: ScheduledTaskType;
  recurring_rule?: RecurringRule | null;
  next_run_at: number; // 毫秒时间戳
  status: ScheduledTaskStatus;
  created_at: number;
  updated_at: number;
}

export interface SlangEntry {
  id?: number;
  term: string;
  tags?: string;
  definition: string;
  example?: string;
  query_count?: number;
  last_queried_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

export interface SessionStateRecord {
  peer: string;
  current_session_id: string;
  cleared_round: number;
  cleared_version: number;
  updated_at: number;
  model_provider?: string;
  model_name?: string;
  model_reasoning_effort?: string;
}
