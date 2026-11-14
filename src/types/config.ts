/**
 * kujira: 插件全局配置与凭据状态契约（QQ 官方 Bot API v2 合规单聊）
 */

export type DshPermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 仿生主动互动偏好分段 ('enthusiastic' 热情 | 'balanced' 均衡 | 'aloof' 冷淡) */
export type ProactiveAttitude = 'enthusiastic' | 'balanced' | 'aloof';

/** QQ 官方 Bot 开放平台凭据（仅通过 DSH ctx.credentials 安全存储，不写入配置文件） */
export interface QqCredential {
  appId: string;
  appSecret: string;
}

/** 单个凭据槽位状态元数据（供 WebUI 只读展示来源，绝不回显明文） */
export interface CredentialSlotStatus {
  configured: boolean;
  source?: string;
  writable: boolean;
}

/** QQ 官方 Bot 凭据配置汇总状态 */
export interface CredentialStatusSummary {
  appId: CredentialSlotStatus;
  appSecret: CredentialSlotStatus;
  ready: boolean;
  reason?: string;
}

/** kujira 单聊插件核心配置（23 项，不含 AppID/AppSecret 凭据） */
export interface BridgePluginConfig {
  /** 外来图片/媒体资源本地缓存保留天数 */
  image_ttl_days?: number;
  /** 一轮 Agent 循环正在进行时收到新消息的行为模式 ('steer' 及时插话并在当前 Step 完成后接纳; 'queue' 加入队列等待整轮结束) */
  new_message_behavior?: 'steer' | 'queue';
  /** 助手人格设定 (注入 SystemPrompt 动态段) */
  persona?: string;
  /** 行为约束准则 (注入 SystemPrompt 动态段) */
  behavior?: string;
  /** 记忆 Markdown 文件存储根目录 (默认 .dsh/kujira/memory) */
  memory_storage_dir?: string;
  /** 用户画像字符预算上限：单个用户画像文件的写入上限 (默认 2200) */
  user_profile_budget_chars?: number;
  /** Session 规则字符预算上限：单个会话规则文件的写入上限 (默认 2200) */
  session_memory_budget_chars?: number;
  /** 控制新建会话是否装载表情包工具集，对后续新会话生效 */
  face_enabled?: boolean;
  /** 本地表情库存储容量上限 (默认 100 张) */
  face_store_max?: number;
  /** 本地表情库文件存储目录 (默认 .dsh/kujira/faces) */
  face_store_dir?: string;
  /** 表情库满额淘汰策略 ('reject' 拒绝新增 / 'evict_lru' 淘汰最久未用) */
  face_evict_policy?: 'reject' | 'evict_lru';
  /** 控制新建会话是否装载黑话工具集与注入黑话上下文，对后续新会话生效 */
  slang_enabled?: boolean;
  /** 黑话知识库条数上限 (默认 300 条) */
  slang_max_entries?: number;
  /** 黑话库满额淘汰策略 ('reject' 拒绝新增 / 'evict_lru' 淘汰查阅最少词条) */
  slang_evict_policy?: 'reject' | 'evict_lru';
  /** 黑话 Markdown 文档参考导出路径 (默认 .dsh/kujira/slang/slang.md) */
  slang_storage_path?: string;
  /** 消息聚合回复总开关：开启后用户连续发送的消息按周期窗口聚合，一次性交给模型回复 */
  aggregation_enabled?: boolean;
  /** 聚合等待最小时长 (单位: 秒，默认 10 秒，硬底线) */
  aggregation_min_seconds?: number;
  /** 聚合等待最大时长 (单位: 秒，默认 60 秒) */
  aggregation_max_seconds?: number;
  /** 冷场主动搭话总开关：长时间无新消息时主动发起话题 */
  idle_reply_enabled?: boolean;
  /** 潜水主动搭话最小沉默时长 (单位: 分钟，默认 30 分钟) */
  idle_reply_min_mins?: number;
  /** 潜水主动搭话最大沉默时长 (单位: 分钟，默认 120 分钟) */
  idle_reply_max_mins?: number;
  /** 互动偏好分段 ('enthusiastic' 热情 | 'balanced' 均衡 | 'aloof' 冷淡，默认 'balanced') */
  proactive_attitude?: ProactiveAttitude;
  /** 允许在连续热聊时概率秒回 (突破聚合下限，默认 false) */
  instant_reply_enabled?: boolean;
  /** @deprecated 旧版过渡期类型兼容占位（已从 Schema、默认值与有效配置彻底清除） */
  aggregation_interval_mins?: number;
  /** @deprecated 旧版过渡期类型兼容占位（已从 Schema、默认值与有效配置彻底清除） */
  idle_reply_timeout_mins?: number;
}
