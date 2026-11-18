/**
 * kujira: 配置 Schema 定义
 * 基于 @deepseek-ai/schemastery 定义插件核心单聊配置项与 Web UI 设置卡片结构。
 * 注意：AppID / AppSecret 凭据已交由 DSH 官方 ctx.credentials（$DSH_HOME/.credentials.yaml）管理，
 * 不在此 Schema 中声明。
 */

import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_NEW_MESSAGE_BEHAVIOR,
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_MEMORY_DIR,
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  DEFAULT_FACE_STORE_MAX,
  DEFAULT_FACE_STORE_DIR,
  DEFAULT_FACE_EVICT_POLICY,
  DEFAULT_SLANG_MAX_ENTRIES,
  DEFAULT_SLANG_EVICT_POLICY,
  DEFAULT_SLANG_STORAGE_PATH,
  DEFAULT_AGGREGATION_ENABLED,
  DEFAULT_AGGREGATION_MIN_SECONDS,
  DEFAULT_AGGREGATION_MAX_SECONDS,
  DEFAULT_IDLE_REPLY_ENABLED,
  DEFAULT_IDLE_REPLY_MIN_MINS,
  DEFAULT_IDLE_REPLY_MAX_MINS,
  DEFAULT_IDLE_REPLY_LIST_MODE,
  DEFAULT_IDLE_REPLY_BLACKLIST,
  DEFAULT_IDLE_REPLY_WHITELIST,
  DEFAULT_PROACTIVE_ATTITUDE,
  DEFAULT_INSTANT_REPLY_ENABLED,
  DEFAULT_ADMINS,
  DEFAULT_PRIVACY_TOOLS_LIST_MODE,
  DEFAULT_PRIVACY_TOOLS_BLACKLIST,
  DEFAULT_PRIVACY_TOOLS_WHITELIST,
} from '../constants/index.js';
import type { BridgePluginConfig } from '../types/index.js';

export const BridgeConfigSchema: z<any> = z.object({
  image_ttl_days: z
    .number()
    .default(DEFAULT_IMAGE_TTL_DAYS)
    .volatile()
    .description('外来图片与媒体资源本地缓存保留天数 (默认 7 天)'),
  new_message_behavior: z
    .union([z.const('steer'), z.const('queue')])
    .default(DEFAULT_NEW_MESSAGE_BEHAVIOR)
    .volatile()
    .description('运行中收到新消息的行为模式 (steer: 及时插话并在当前 Step 完成后接纳; queue: 加入队列等待整轮结束)'),
  persona: z
    .string()
    .default(DEFAULT_PERSONA)
    .volatile()
    .description('助手人格设定 (注入 SystemPrompt 动态段)'),
  behavior: z
    .string()
    .default(DEFAULT_BEHAVIOR)
    .volatile()
    .description('行为约束准则 (注入 SystemPrompt 动态段)'),
  memory_storage_dir: z
    .string()
    .default(DEFAULT_MEMORY_DIR)
    .volatile()
    .description('双层记忆 Markdown 文件存储根目录 (默认 .dsh/kujira/memory)'),
  user_profile_budget_chars: z
    .number()
    .default(DEFAULT_USER_PROFILE_BUDGET_CHARS)
    .volatile()
    .description('用户画像字符预算上限：单个用户画像文件的写入上限 (默认 2200)'),
  session_memory_budget_chars: z
    .number()
    .default(DEFAULT_SESSION_MEMORY_BUDGET_CHARS)
    .volatile()
    .description('Session 规则字符预算上限：单个会话规则文件的写入上限 (默认 2200)'),
  face_store_max: z
    .number()
    .default(DEFAULT_FACE_STORE_MAX)
    .volatile()
    .description('本地表情库存储容量上限 (默认 100 张)'),
  face_store_dir: z
    .string()
    .default(DEFAULT_FACE_STORE_DIR)
    .volatile()
    .description('本地表情库文件存储目录 (默认 .dsh/kujira/faces)'),
  face_evict_policy: z
    .union([z.const('reject'), z.const('evict_lru')])
    .default(DEFAULT_FACE_EVICT_POLICY)
    .volatile()
    .description('满额策略 (reject: 拒绝新增, evict_lru: 淘汰最久未用)'),
  slang_max_entries: z
    .number()
    .default(DEFAULT_SLANG_MAX_ENTRIES)
    .volatile()
    .description('黑话知识库条数上限 (默认 300 条)'),
  slang_evict_policy: z
    .union([z.const('reject'), z.const('evict_lru')])
    .default(DEFAULT_SLANG_EVICT_POLICY)
    .volatile()
    .description('黑话满额策略 (reject: 拒绝新增, evict_lru: 淘汰查阅最少词条)'),
  slang_storage_path: z
    .string()
    .default(DEFAULT_SLANG_STORAGE_PATH)
    .volatile()
    .description('黑话 Markdown 文档保存路径 (默认 .dsh/kujira/slang/slang.md)'),
  aggregation_enabled: z
    .boolean()
    .default(DEFAULT_AGGREGATION_ENABLED)
    .volatile()
    .description('消息聚合回复总开关：开启后连续消息按周期窗口合并为一次回复'),
  aggregation_min_seconds: z
    .number()
    .default(DEFAULT_AGGREGATION_MIN_SECONDS)
    .volatile()
    .description('聚合等待最小时长 (单位: 秒，默认 10 秒，硬底线)'),
  aggregation_max_seconds: z
    .number()
    .default(DEFAULT_AGGREGATION_MAX_SECONDS)
    .volatile()
    .description('聚合等待最大时长 (单位: 秒，默认 60 秒)'),
  idle_reply_enabled: z
    .boolean()
    .default(DEFAULT_IDLE_REPLY_ENABLED)
    .volatile()
    .description('冷场主动搭话总开关：长时间无新消息时主动发起话题'),
  idle_reply_min_mins: z
    .number()
    .default(DEFAULT_IDLE_REPLY_MIN_MINS)
    .volatile()
    .description('潜水主动搭话最小沉默时长 (单位: 分钟，默认 30 分钟)'),
  idle_reply_max_mins: z
    .number()
    .default(DEFAULT_IDLE_REPLY_MAX_MINS)
    .volatile()
    .description('潜水主动搭话最大沉默时长 (单位: 分钟，默认 120 分钟)'),
  idle_reply_list_mode: z
    .union([z.const('blacklist'), z.const('whitelist')])
    .default(DEFAULT_IDLE_REPLY_LIST_MODE)
    .volatile()
    .description('冷场主动搭话名单过滤模式 (blacklist: 黑名单排除, whitelist: 白名单仅允许)'),
  idle_reply_blacklist: z
    .array(z.string())
    .default(DEFAULT_IDLE_REPLY_BLACKLIST)
    .volatile()
    .description('冷场主动搭话黑名单用户 peer 列表 (仅黑名单模式生效，仅存内部哈希 peer)'),
  idle_reply_whitelist: z
    .array(z.string())
    .default(DEFAULT_IDLE_REPLY_WHITELIST)
    .volatile()
    .description('冷场主动搭话白名单用户 peer 列表 (仅白名单模式生效，仅存内部哈希 peer)'),
  proactive_attitude: z
    .union([z.const('enthusiastic'), z.const('balanced'), z.const('aloof')])
    .default(DEFAULT_PROACTIVE_ATTITUDE)
    .volatile()
    .description('互动偏好分段 (enthusiastic: 热情, balanced: 均衡, aloof: 冷淡)'),
  instant_reply_enabled: z
    .boolean()
    .default(DEFAULT_INSTANT_REPLY_ENABLED)
    .volatile()
    .description('允许在连续热聊时概率秒回 (突破聚合下限，默认 false)'),
  admins: z
    .array(z.string())
    .default(DEFAULT_ADMINS)
    .volatile()
    .description('管理员用户 peer 列表 (空列表表示 1 对 1 模式全员具备管理员权限，仅存内部哈希 peer)'),
  privacy_tools_list_mode: z
    .union([z.const('blacklist'), z.const('whitelist')])
    .default(DEFAULT_PRIVACY_TOOLS_LIST_MODE)
    .volatile()
    .description('隔离可能泄露隐私的工具名单过滤模式 (blacklist: 黑名单隔离, whitelist: 白名单仅允许)'),
  privacy_tools_blacklist: z
    .array(z.string())
    .default(DEFAULT_PRIVACY_TOOLS_BLACKLIST)
    .volatile()
    .description('隔离可能泄露隐私的工具黑名单用户 peer 列表 (仅黑名单模式生效，空数组表示无人被隔离)'),
  privacy_tools_whitelist: z
    .array(z.string())
    .default(DEFAULT_PRIVACY_TOOLS_WHITELIST)
    .volatile()
    .description('隔离可能泄露隐私的工具白名单用户 peer 列表 (仅白名单模式生效，空数组表示所有用户均被隔离)'),
});

export type { BridgePluginConfig };
