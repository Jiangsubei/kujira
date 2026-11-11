/**
 * kujira: 配置 Schema 定义
 * 基于 @deepseek-ai/schemastery 定义插件核心单聊配置项与 Web UI 设置卡片结构。
 * 注意：AppID / AppSecret 凭据已交由 DSH 官方 ctx.credentials（$DSH_HOME/.credentials.yaml）管理，
 * 不在此 Schema 中声明。
 */

import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_MARKDOWN_ENABLED,
  DEFAULT_INPUT_NOTIFY_ENABLED,
  DEFAULT_NEW_MESSAGE_BEHAVIOR,
  DEFAULT_PERSONA,
  DEFAULT_BEHAVIOR,
  DEFAULT_MEMORY_DIR,
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  DEFAULT_FACE_ENABLED,
  DEFAULT_FACE_STORE_MAX,
  DEFAULT_FACE_STORE_DIR,
  DEFAULT_FACE_EVICT_POLICY,
  DEFAULT_SLANG_ENABLED,
  DEFAULT_SLANG_MAX_ENTRIES,
  DEFAULT_SLANG_EVICT_POLICY,
  DEFAULT_SLANG_STORAGE_PATH,
} from '../constants/index.js';
import type { BridgePluginConfig } from '../types/index.js';

export const BridgeConfigSchema: z<any> = z.object({
  image_ttl_days: z
    .number()
    .default(DEFAULT_IMAGE_TTL_DAYS)
    .volatile()
    .description('外来图片与媒体资源本地缓存保留天数 (默认 7 天)'),
  markdown_enabled: z
    .boolean()
    .default(DEFAULT_MARKDOWN_ENABLED)
    .volatile()
    .description('启用 QQ 官方单聊原生 Markdown 富文本发送 (msg_type=2，默认开启)'),
  input_notify_enabled: z
    .boolean()
    .default(DEFAULT_INPUT_NOTIFY_ENABLED)
    .volatile()
    .description('启用「对方正在输入...」状态提示 (msg_type=6，默认开启)'),
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
  face_enabled: z
    .boolean()
    .default(DEFAULT_FACE_ENABLED)
    .volatile()
    .description('控制新建会话是否装载表情包工具集，对后续新会话生效'),
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
  slang_enabled: z
    .boolean()
    .default(DEFAULT_SLANG_ENABLED)
    .volatile()
    .description('控制新建会话是否装载黑话工具集与注入黑话上下文，对后续新会话生效'),
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
});

export type { BridgePluginConfig };
