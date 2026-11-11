/**
 * kujira: 插件全局配置与凭据状态契约（QQ 官方 Bot API v2 合规单聊）
 */

export type DshPermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';

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

/** kujira 单聊插件核心配置（17 项，不含 AppID/AppSecret 凭据） */
export interface BridgePluginConfig {
  /** 外来图片/媒体资源本地缓存保留天数 */
  image_ttl_days?: number;
  /** 是否启用单聊原生 Markdown 消息发送 (`msg_type=2`) */
  markdown_enabled?: boolean;
  /** 是否在收到单聊消息时下发「正在输入」状态 (`msg_type=6`) */
  input_notify_enabled?: boolean;
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
}
