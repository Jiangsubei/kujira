/**
 * kujira: 全局常量与默认配置单一真相源 (SSOT)
 */

// ---------------------------------------------------------------------------
// 品牌、配置命名空间、凭据键名与数据目录
// ---------------------------------------------------------------------------

export const PLUGIN_NAME = 'kujira';

export const SETTINGS_NAMESPACE = 'kujira';

export const CRED_APP_ID = 'QQ_BOT_APP_ID';

export const CRED_SECRET = 'QQ_BOT_SECRET';

export const DEFAULT_WORKSPACE_ROOT = '.dsh/workspace/kujira';

export const DEFAULT_DATABASE_PATH = '.dsh/kujira/messages.sqlite';

export const DEFAULT_DOWNLOAD_ROOT = '.dsh/kujira/downloads';

export const DEFAULT_MEMORY_DIR = '.dsh/kujira/memory';

export const DEFAULT_FACE_STORE_DIR = '.dsh/kujira/faces';

export const DEFAULT_SLANG_STORAGE_PATH = '.dsh/kujira/slang/slang.md';

// ---------------------------------------------------------------------------
// QQ 官方 Bot API v2 协议与实测硬边界常量
// ---------------------------------------------------------------------------

export const QQ_BOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

export const QQ_API_BASE = 'https://api.sgroup.qq.com';

export const QQ_INTENT_GROUP_AND_C2C_EVENT = 1 << 25;

export const QQ_MSG_TYPE_TEXT = 0;

export const QQ_MSG_TYPE_MARKDOWN = 2;

export const QQ_MSG_TYPE_INPUT_NOTIFY = 6;

export const QQ_MSG_TYPE_MEDIA = 7;

export const QQ_FILE_TYPE_IMAGE = 1;

export const QQ_FILE_TYPE_VIDEO = 2;

export const QQ_FILE_TYPE_AUDIO = 3;

export const QQ_FILE_TYPE_FILE = 4;

export const QQ_MEDIA_SOFT_LIMIT_IMAGE = 20 * 1024 * 1024;

export const QQ_MEDIA_SOFT_LIMIT_VIDEO = 30 * 1024 * 1024;

export const QQ_MEDIA_SOFT_LIMIT_AUDIO = 20 * 1024 * 1024;

export const QQ_MEDIA_HARD_LIMIT = 200 * 1024 * 1024;

export const QQ_UPLOAD_MD5_10M_BYTES = 10002432;

export const QQ_MESSAGE_MAX_BYTES = 16 * 1024;

/** send_qq_message 单次发送本地字符拦截上限（超长需拆条发送） */
export const QQ_SEND_MESSAGE_MAX_CHARS = 6000;

export const QQ_INPUT_NOTIFY_MAX_SECONDS = 60;

export const QQ_REQUEST_TIMEOUT_MS = 30_000;

export const QQ_UPLOAD_PUT_TIMEOUT_MS = 60_000;

export const QQ_TOKEN_REFRESH_MARGIN_MS = 60_000;

export const QQ_WS_BACKOFF_MS = [2000, 5000, 10000, 30000, 60000] as const;

// ---------------------------------------------------------------------------
// 行为默认开关与配置基线常量
// ---------------------------------------------------------------------------

export const DEFAULT_IMAGE_TTL_DAYS = 7;

export const DEFAULT_NEW_MESSAGE_BEHAVIOR = 'steer' as const;

/** 单个用户画像文件的写入上限 */
export const DEFAULT_USER_PROFILE_BUDGET_CHARS = 2200;

/** 单个 Session 规则文件的写入上限 */
export const DEFAULT_SESSION_MEMORY_BUDGET_CHARS = 2200;

export const DEFAULT_FACE_ENABLED = false;

export const DEFAULT_FACE_STORE_MAX = 100;

export const DEFAULT_FACE_QUERY_LIMIT = 100;

export const DEFAULT_FACE_EVICT_POLICY = 'evict_lru' as const;

export const DEFAULT_FACE_GRACE_PERIOD_DAYS = 7;

export const DEFAULT_SLANG_ENABLED = true;

export const DEFAULT_SLANG_MAX_ENTRIES = 300;

export const DEFAULT_SLANG_EVICT_POLICY = 'reject' as const;

// ---------------------------------------------------------------------------
// 单聊消息聚合回复与冷场主动搭话默认值
// ---------------------------------------------------------------------------

/** 消息聚合回复总开关 (默认关闭，需用户显式开启) */
export const DEFAULT_AGGREGATION_ENABLED = false;

/** 消息聚合周期窗口 (单位: 分钟，默认 2 分钟) */
export const DEFAULT_AGGREGATION_INTERVAL_MINS = 2;

/** 冷场主动搭话总开关 (默认关闭，需用户显式开启) */
export const DEFAULT_IDLE_REPLY_ENABLED = false;

/** 冷场判定阈值 (单位: 分钟，默认 60 分钟) */
export const DEFAULT_IDLE_REPLY_TIMEOUT_MINS = 60;

/** 主动能力集中巡检周期 (固定 60 秒，与 TaskScheduler 兜底扫描同频) */
export const PROACTIVE_CHECK_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// 人格、记忆与单聊交互规范文案
// ---------------------------------------------------------------------------

export const DEFAULT_PERSONA =
  '你是一个得力的 QQ 单聊智能助手，请友好、精炼、真实地回答用户的问题。';

export const TRUNCATED_USER_PROFILE_NOTICE =
  "[提示：受字符预算限制，当前用户的画像未完全展示。如需了解完整画像，可按需调用 read_memory(type='user') 获取。]";

export const DEFAULT_MEMORY_GUIDANCE =
  "记忆工具规则：日常对话不必每轮都调用记忆工具（create_memory、edit_memory），但在用户明确要求记住/修改设定，或交流中提炼出长期稳定事实与偏好时，应当调用（仅操作当前单聊会话）；严禁记录琐碎流水账；若上下文快照提示画像未完全展示，可按需使用 read_memory(type='user') 查询。";

export const DEFAULT_BEHAVIOR =
  '## 交互与输出规范\n' +
  '- 消息排版：QQ 官方 Bot 单聊原生支持 Markdown 富文本格式（包括标题、列表、表格、加粗、引用、代码块与链接等），可按表达需要清晰排版；使用 `#` 标题时建议在 `#` 后保留一个空格。\n' +
  '- 消息下发：向用户回复消息、告知结论或同步长任务进展时，必须调用 send_qq_message 工具。请将正文完整传入 text 参数（单次文本上限 6000 字符，超长需拆条发送）。引用回复默认不使用 reply_to：只有当被回复的那条已隔较久、被后续消息冲散需要锚定，或用户明确要求引用/回复某条，或需对多条并列消息逐条对应，或明确指代某条更早的历史消息时，才传入目标短消息 ID（如 msg_12 或 msg_self_8）；日常一问一答与连续短对话一律不传。严禁在直接回复中重复输出已发送的正文内容。\n' +
  '- 用户提问与抉择：若需要用户澄清需求、提供缺失信息或在多选项中进行抉择确认，可调用官方 ask_user_question 工具发起结构化交互。\n' +
  '- 文件与表情：生成或需发送给用户的图片、音视频与文件必须保存到本地持久化路径或工作区目录，并调用 send_file 下发；发送表情包请调用 send_face（若已启用表情包工具）。\n' +
  '- 消息撤回：若发现发错内容、产生幻觉或被用户指出要求撤回，可调用 recall_message 撤回指定消息（传入短出站消息 ID，如 msg_self_8）。受 QQ 官方平台严格限制，单聊仅支持在发送后 2 分钟（120 秒）内撤回机器人自身发出的消息，超时或传入非本机出站消息 ID 将如实报错。\n' +
  '- ' +
  DEFAULT_MEMORY_GUIDANCE;

/**
 * 解析生效的行为准则：仅在用户未配置（空白）时回落到 DEFAULT_BEHAVIOR
 * （默认值本身已包含记忆工具指引）；用户配置了任意字符则原样返回，绝不追加任何默认内容。
 */
export function resolveEffectiveBehavior(configured?: string | null): string {
  const trimmed = (configured || '').trim();
  return trimmed || DEFAULT_BEHAVIOR;
}

// ---------------------------------------------------------------------------
// 核心配置默认值单一真相源 (与 BridgePluginConfig 19 项核心配置对齐)
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_CONFIG = {
  image_ttl_days: DEFAULT_IMAGE_TTL_DAYS,
  new_message_behavior: DEFAULT_NEW_MESSAGE_BEHAVIOR,
  persona: DEFAULT_PERSONA,
  behavior: DEFAULT_BEHAVIOR,
  memory_storage_dir: DEFAULT_MEMORY_DIR,
  user_profile_budget_chars: DEFAULT_USER_PROFILE_BUDGET_CHARS,
  session_memory_budget_chars: DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  face_enabled: DEFAULT_FACE_ENABLED,
  face_store_max: DEFAULT_FACE_STORE_MAX,
  face_store_dir: DEFAULT_FACE_STORE_DIR,
  face_evict_policy: DEFAULT_FACE_EVICT_POLICY,
  slang_enabled: DEFAULT_SLANG_ENABLED,
  slang_max_entries: DEFAULT_SLANG_MAX_ENTRIES,
  slang_evict_policy: DEFAULT_SLANG_EVICT_POLICY,
  slang_storage_path: DEFAULT_SLANG_STORAGE_PATH,
  aggregation_enabled: DEFAULT_AGGREGATION_ENABLED,
  aggregation_interval_mins: DEFAULT_AGGREGATION_INTERVAL_MINS,
  idle_reply_enabled: DEFAULT_IDLE_REPLY_ENABLED,
  idle_reply_timeout_mins: DEFAULT_IDLE_REPLY_TIMEOUT_MINS,
};
