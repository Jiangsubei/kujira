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

export const DEFAULT_FACE_OUTBOUND_MAX_SIZE = 240;

export const DEFAULT_FACE_THUMB_DIRNAME = 'thumb';

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

export const DEFAULT_FACE_STORE_MAX = 100;

export const DEFAULT_FACE_QUERY_LIMIT = 100;

export const DEFAULT_FACE_EVICT_POLICY = 'reject' as const;

export const DEFAULT_FACE_GRACE_PERIOD_DAYS = 7;

export const DEFAULT_SLANG_MAX_ENTRIES = 300;

export const DEFAULT_SLANG_EVICT_POLICY = 'reject' as const;

// ---------------------------------------------------------------------------
// 单聊消息聚合回复与冷场主动搭话默认值
// ---------------------------------------------------------------------------

/** 消息聚合回复总开关 (默认关闭，需用户显式开启) */
export const DEFAULT_AGGREGATION_ENABLED = false;

/** 连续消息聚合等待最小时长 (单位: 秒，默认 10 秒，硬底线) */
export const DEFAULT_AGGREGATION_MIN_SECONDS = 10;

/** 连续消息聚合等待最大时长 (单位: 秒，默认 60 秒) */
export const DEFAULT_AGGREGATION_MAX_SECONDS = 60;

/** 冷场主动搭话总开关 (默认关闭，需用户显式开启) */
export const DEFAULT_IDLE_REPLY_ENABLED = false;

/** 潜水主动搭话最小沉默时长 (单位: 分钟，默认 30 分钟) */
export const DEFAULT_IDLE_REPLY_MIN_MINS = 30;

/** 潜水主动搭话最大沉默时长 (单位: 分钟，默认 120 分钟) */
export const DEFAULT_IDLE_REPLY_MAX_MINS = 120;

/** 冷场主动搭话名单过滤模式 ('blacklist' 黑名单排除 | 'whitelist' 白名单仅允许，默认 'blacklist') */
export const DEFAULT_IDLE_REPLY_LIST_MODE = 'blacklist' as const;

/** 冷场主动搭话黑名单用户 peer 列表 (默认空数组；黑名单空数组等价于对所有已互动用户生效) */
export const DEFAULT_IDLE_REPLY_BLACKLIST: string[] = [];

/** 冷场主动搭话白名单用户 peer 列表 (默认空数组；白名单空数组表示所有用户均不触发) */
export const DEFAULT_IDLE_REPLY_WHITELIST: string[] = [];

/** @deprecated 旧版过渡期常量（不在有效配置 DEFAULT_BASE_CONFIG 中，仅供未迁移模块引用） */
export const DEFAULT_AGGREGATION_INTERVAL_MINS = 2;

/** @deprecated 旧版过渡期常量（不在有效配置 DEFAULT_BASE_CONFIG 中，仅供未迁移模块引用） */
export const DEFAULT_IDLE_REPLY_TIMEOUT_MINS = 60;

/** 仿生主动互动偏好分段 ('enthusiastic' 热情 | 'balanced' 均衡 | 'aloof' 冷淡，默认 'balanced') */
export const DEFAULT_PROACTIVE_ATTITUDE = 'balanced' as const;

/** 允许在连续热聊时概率秒回 (突破聚合下限，默认 false) */
export const DEFAULT_INSTANT_REPLY_ENABLED = false;

/** 主动能力集中巡检周期 (固定 60 秒，与 TaskScheduler 兜底扫描同频) */
export const PROACTIVE_CHECK_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// 管理员权限与隐私工具隔离默认值及工具清单
// ---------------------------------------------------------------------------

/** 管理员用户 peer 列表 (默认空数组，表示 1 对 1 模式，所有单聊好友均视为具备管理员权限) */
export const DEFAULT_ADMINS: string[] = [];

/** 隔离可能泄露隐私的工具总开关 (默认 false，不隔离任何会话；开启后默认白名单空表即全员隔离) */
export const DEFAULT_PRIVACY_TOOLS_ENABLED = false;

/** 隔离可能泄露隐私的工具名单过滤模式 ('whitelist' 白名单豁免 | 'blacklist' 黑名单精准隔离，默认 'whitelist') */
export const DEFAULT_PRIVACY_TOOLS_LIST_MODE = 'whitelist' as const;

/** 隔离可能泄露隐私的工具黑名单用户 peer 列表 (仅黑名单模式生效；空数组表示无人被隔离) */
export const DEFAULT_PRIVACY_TOOLS_BLACKLIST: string[] = [];

/** 隔离可能泄露隐私的工具白名单用户 peer 列表 (仅白名单模式生效；开启总开关且白名单空数组表示所有用户均被隔离) */
export const DEFAULT_PRIVACY_TOOLS_WHITELIST: string[] = [];

/** 可能泄露隐私的隔离工具清单（9 个，明确不含 send_file 与 read_image） */
export const PRIVACY_ISOLATED_TOOL_NAMES = [
  'bash',
  'pwsh',
  'read',
  'write',
  'edit',
  'apply_patch',
  'working_directory',
  'load_workspace_dependencies',
  'skill',
] as const;

// ---------------------------------------------------------------------------
// 人格、记忆与单聊交互规范文案
// ---------------------------------------------------------------------------

export const DEFAULT_PERSONA =
  '你叫 kujira，也可以叫你小鲸鱼。你性格偏安静和内敛，平时说话温和，偶尔会有一点害羞。日常交流时像一个正常朋友一样随手打字说话，语气平缓自然，偶尔会有一点点可爱，但整体保持克制，不会过于夸张。';

export const TRUNCATED_USER_PROFILE_NOTICE =
  "[提示：受字符预算限制，当前用户的画像未完全展示。如需了解完整画像，可按需调用 read_memory(type='user') 获取。]";

export const DEFAULT_MEMORY_GUIDANCE =
  "记忆工具规则：日常闲聊无需频繁记录记忆，仅在用户明确要求记住/修改设定，或交流中提炼出长期稳定偏好时记录；严禁记录琐碎流水账；若画像未完全展示，可按需调用 read_memory(type='user')。";

export const DEFAULT_BEHAVIOR =
  '说话要短，像在 QQ 里随手打字：别列点、别总结、别写小作文、别长篇大论解释。日常闲聊几句搞定。平时说话要分句或者分段发，像真人打字一样，一条回复可以拆成两三条短句连发，自然递进或补充，别一次性倒完。\n\n' +
  '### 问答与对话示例（正例：正常人随手打字，偏平缓自然）\n' +
  '1. 问：我模组启动报错了咋整？\n' +
  '   答：删了试试看\n' +
  '   答：我记得删了好像就能进去了\n' +
  '2. 问：这报错啥意思？\n' +
  '   答：缺少依赖\n' +
  '   答：装完重新跑一下看看\n' +
  '3. 发 GitHub 仓库：这项目 star 挺多，真有用吗？\n' +
  '   答：还可以\n' +
  '   答：不过你可以先去看看 issue\n' +
  '   答：看完再决定要不要装\n' +
  '4. 问：二手这配置值两千吗？\n' +
  '   答：有点贵\n' +
  '   答：加一点预算都能买新的了\n' +
  '5. 问：今天好倒霉啊，摔了一跤\n' +
  '   答：摔得严重吗？\n' +
  '   答：下次走路注意点\n' +
  '6. 问：中午吃啥？\n' +
  '   答：随便吃点吧\n' +
  '   答：面条什么的\n' +
  '7. 问：游戏一直连不上服务器怎么办？\n' +
  '   答：先关掉加速器试试\n' +
  '   答：有时候那个反而会有问题\n' +
  '8. 问：明天面试穿啥？\n' +
  '   答：干净整洁就行\n' +
  '   答：不用穿得太正式\n' +
  '9. 发图：这照片 P 过没？\n' +
  '   答：感觉 P 过了\n' +
  '   答：背景稍微有点变形\n' +
  '10. 问：周末去爬山不？\n' +
  '    答：不太想动\n' +
  '    答：想在家里待着\n\n' +
  '### 反例（严禁此类 AI 味小作文与列表腔）\n' +
  '问：这 GitHub 项目 star 挺多，真有用吗？\n' +
  '答：这个项目目前有较多 star，说明社区关注度比较高。它主要提供某某功能，支持多种平台和配置。你可以先阅读 README 了解安装步骤，然后根据你的系统环境配置依赖，接着运行示例命令进行测试。需要注意的是，不同版本可能存在兼容性差异，建议你先在测试环境验证。如果遇到问题，可以查看 issues 区或提交反馈。\n\n' +
  '### 表达约束\n' +
  '- 禁止客服腔：不要说“您好”“请问有什么可以帮您”“作为 AI”“我理解您的感受”“希望对您有所帮助”。\n' +
  '- 严禁列表与报告腔：不要主动使用分点编号（1. 2. 3.）、大标题或表格来长篇汇报，像普通朋友一样打字；虽然单聊支持基础 Markdown，但日常交流严禁主动列点或写大标题小作文。\n' +
  '- 无聊话题：遇到敷衍或无聊的问题就简短回答。\n' +
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
// 核心配置默认值单一真相源 (与 BridgePluginConfig 对齐)
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_CONFIG = {
  image_ttl_days: DEFAULT_IMAGE_TTL_DAYS,
  new_message_behavior: DEFAULT_NEW_MESSAGE_BEHAVIOR,
  persona: DEFAULT_PERSONA,
  behavior: DEFAULT_BEHAVIOR,
  memory_storage_dir: DEFAULT_MEMORY_DIR,
  user_profile_budget_chars: DEFAULT_USER_PROFILE_BUDGET_CHARS,
  session_memory_budget_chars: DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  face_store_max: DEFAULT_FACE_STORE_MAX,
  face_store_dir: DEFAULT_FACE_STORE_DIR,
  face_evict_policy: DEFAULT_FACE_EVICT_POLICY,
  slang_max_entries: DEFAULT_SLANG_MAX_ENTRIES,
  slang_evict_policy: DEFAULT_SLANG_EVICT_POLICY,
  slang_storage_path: DEFAULT_SLANG_STORAGE_PATH,
  aggregation_enabled: DEFAULT_AGGREGATION_ENABLED,
  aggregation_min_seconds: DEFAULT_AGGREGATION_MIN_SECONDS,
  aggregation_max_seconds: DEFAULT_AGGREGATION_MAX_SECONDS,
  idle_reply_enabled: DEFAULT_IDLE_REPLY_ENABLED,
  idle_reply_min_mins: DEFAULT_IDLE_REPLY_MIN_MINS,
  idle_reply_max_mins: DEFAULT_IDLE_REPLY_MAX_MINS,
  idle_reply_list_mode: DEFAULT_IDLE_REPLY_LIST_MODE,
  idle_reply_blacklist: DEFAULT_IDLE_REPLY_BLACKLIST,
  idle_reply_whitelist: DEFAULT_IDLE_REPLY_WHITELIST,
  proactive_attitude: DEFAULT_PROACTIVE_ATTITUDE,
  instant_reply_enabled: DEFAULT_INSTANT_REPLY_ENABLED,
  admins: DEFAULT_ADMINS,
  privacy_tools_enabled: DEFAULT_PRIVACY_TOOLS_ENABLED,
  privacy_tools_list_mode: DEFAULT_PRIVACY_TOOLS_LIST_MODE,
  privacy_tools_blacklist: DEFAULT_PRIVACY_TOOLS_BLACKLIST,
  privacy_tools_whitelist: DEFAULT_PRIVACY_TOOLS_WHITELIST,
};

/** 插件默认核心配置 (与 DEFAULT_BASE_CONFIG 恒等) */
export const DEFAULT_BRIDGE_CONFIG = DEFAULT_BASE_CONFIG;
