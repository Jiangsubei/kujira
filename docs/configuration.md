# 运行时配置全景参考 (Configuration)

本文档提供 **kujira** 的 29 项核心运行参数全貌解析、配置安全机制、WebUI 分区调优指南与典型角色调优配方。

---

## 1. 配置架构与安全机制

### 1.1 凭据安全隔离与只写保护
- **凭据不入配置文件**：机器人的核心凭据 `AppID` 与 `密钥 (AppSecret)` 完全接入 DSH 官方凭据管理服务 `ctx.credentials`，独立保存在 `$DSH_HOME/.credentials.yaml` 中，**绝不写入普通插件配置**；
- **只写安全协议（Write-Only）**：WebUI 前端与 REST 接口仅向用户展示凭据的就绪状态（`configured: true / false` 与配置来源 `source`），**绝不向前端回显明文密钥**，杜绝页面审查与截屏泄露风险；
- **环境变量无缝覆盖**：支持通过系统环境变量 `QQ_BOT_APP_ID` 与 `QQ_BOT_SECRET` 注入凭据，容器与 CI 环境优先读取。

### 1.2 动态热更新 (Volatile Schema)
所有 29 项业务参数均标记为 `volatile()`。修改参数并在 WebUI 保存后，**无需重启 DSH 进程**，插件会即时触发 Reconciler 完成热重载与逻辑对齐（包括对存活会话即时施加或解除隐私工具组隔离，下一条消息热生效）。

### 1.3 过时配置物理自愈 (Config Self-Healing)
Kujira 内置自愈清理机制。当读取到旧版本遗留的废弃配置项（如旧版的 `markdown_enabled`、`input_notify_enabled`、`face_enabled`、`slang_enabled`、`aggregation_interval_mins`、`idle_reply_timeout_mins`、`coding_tools_*`、`session_permission_*` 等）时，系统会自动在内存中安全剥离，并在下一次保存时从持久化存储中物理抹除，保持配置文件的绝对干净。

---

## 2. WebUI 7 大 Tab 参数权威字典

### Tab 1: 常规 (Connection)

聚焦于网络直连、凭据管理与本地静态资源缓存。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **AppID** | `string` | *(必填)* | QQ 开放平台分配的机器人唯一身份标识。凭据安全托管，前端只写。 |
| **密钥 (AppSecret)** | `string` | *(必填)* | QQ 开放平台分配的机器人通信密钥。凭据安全托管，前端只写。 |
| **`image_ttl_days`** | `number` | `7` | **外来图片与媒体资源缓存保留天数**。<br/>入站附件（图片、语音、文档）下载至 `files/<peer>/` 后的生存周期。定时清理任务会扫描并安全清理超出天数的历史媒体文件。 |

---

### Tab 2: 回复节奏 (Reply)

控制消息聚合状态机、动态时钟、防饥饿模型与冷场主动搭话节奏（名单过滤见「更多配置」Tab）。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **`new_message_behavior`** | `'steer' \| 'queue'` | `'steer'` | **运行中收到新消息的行为模式**：<br/>• `steer`（及时插话）：当前回合内，模型正在进行推演但尚未发话时收到新消息，立即将新消息合流进当前上下文统一考虑；<br/>• `queue`（加入队列）：让当前回合按原有计划完整终结，将新消息排入待办，下一回合再处理。 |
| **`proactive_attitude`** | `enum` | `'balanced'` | **仿生互动偏好分段**（在 WebUI 呈现为分段单选组）：<br/>• `enthusiastic`（热情）：采样偏向最小时长，回复迅捷，热度折减积极；<br/>• `balanced`（均衡）：均匀随机分布，节奏适中自然；<br/>• `aloof`（冷淡）：采样偏向最大时长，节奏沉着，保留充足留白。 |
| **`aggregation_enabled`** | `boolean` | `false` | **连续消息聚合回复总开关（默认关闭）**。<br/>开启后，用户在短时间内连续发送的多条短句会被聚合为一个完整的消息包一次性投递给大模型，避免碎片化连续抢答。需用户显式开启。 |
| **`aggregation_min_seconds`** | `number` | `10` | **聚合等待最小时长（秒，硬底线）**。<br/>收到首条消息后，系统预设的绝对最早回复底线时刻（`FloorTime`）。即便连续收到多条消息触发折减，倒计时也绝不早于此底线。 |
| **`aggregation_max_seconds`** | `number` | `60` | **聚合等待最大时长（秒）**。<br/>首条消息到达后随机采样的初始等待上限。取值建议在 30~90 秒之间。 |
| **`instant_reply_enabled`** | `boolean` | `false` | **概率秒回开关**。<br/>开启后，当模型检测到会话处于极高活跃度（例如用户在 15 秒内接话）时，有 $40\% \sim 70\%$ 的概率突破聚合底线，在 0~2 秒内极速秒回。 |
| **`idle_reply_enabled`** | `boolean` | `false` | **冷场主动搭话总开关**。<br/>当双方结束对话且经过长时间沉默后，机器人自主发起话题（冷场破冰；可在「更多配置」Tab 配置精准名单过滤）。 |
| **`idle_reply_min_mins`** | `number` | `30` | **潜水主动搭话最小沉默时长（分钟）**。 |
| **`idle_reply_max_mins`** | `number` | `120` | **潜水主动搭话最大沉默时长（分钟）**。 |

---

### Tab 3: 人格与准则 (Persona & Behavior)

控制注入模型动态上下文的角色核心 Prompt。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **`persona`** | `string` | *(内置)* | **助手人设与性格基底**。<br/>注入 System Prompt 动态人设段。用于定义机器人的称呼、身份背景、口吻风格与情感倾向。 |
| **`behavior`** | `string` | *(内置)* | **行为准则与约束**。<br/>注入 System Prompt 动态准则段。用于约束聊天长度、分段偏好、隐私底线以及工具调用的纪律（如何时保持沉默、何时使用 Markdown 排版）。 |

---

### Tab 4: 记忆系统 (Memory)

管理单聊专属的双层 Markdown 记忆库容量与存储路径。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **`memory_storage_dir`** | `string` | `".dsh/kujira/memory"` | **双层记忆文件存储根目录**。<br/>相对于 `$DSH_HOME` 的存储路径。用户画像存为 `user_<openid>.md`，会话规则存为 `session_<peer>.md`。 |
| **`user_profile_budget_chars`** | `number` | `2200` | **用户画像字符预算上限**。<br/>单个用户画像 Markdown 文档的写入硬限制。模型调用 `edit_memory` 或 `create_memory` 时一旦超额会被硬拦截，倒逼模型压缩提炼长期稳定的事实。 |
| **`session_memory_budget_chars`** | `number` | `2200` | **会话规则字符预算上限**。<br/>单个会话短期规则与上下文备忘的写入硬限制。 |

---

### Tab 5: 表情资产 (Face)

管理个性化表情包库的收录、发送与淘汰机制（表情工具集 `list_faces`、`send_face`、`collect_face`、`manage_faces` 默认常驻装配，表情库为空时不注入上下文）。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **`face_store_max`** | `number` | `100` | **本地表情库存储容量上限（张）**。达到上限后将触发淘汰策略。 |
| **`face_store_dir`** | `string` | `".dsh/kujira/faces"` | **本地表情库图片保存目录**。 |
| **`face_evict_policy`** | `'reject' \| 'evict_lru'` | `'reject'` | **库容满额淘汰策略**：<br/>• `reject`：库容满时直接拒绝收录新表情；<br/>• `evict_lru`：自动淘汰模型最久未发送过的冷门表情。 |

---

### Tab 6: 黑话学习 (Slang)

管理流行梗、专属暗号与标志句式的学习知识库（黑话工具集 `query_slang`、`record_slang`、`manage_slang` 默认常驻装配，词库非空时自动在 System Prompt 中挂载 L1 索引，为空时不注入上下文）。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **`slang_max_entries`** | `number` | `300` | **黑话知识库条数上限（条）**。 |
| **`slang_evict_policy`** | `'reject' \| 'evict_lru'` | `'reject'` | **黑话满额策略**：`reject`（满额拒绝）或 `evict_lru`（淘汰查阅频次最少的词条）。 |
| **`slang_storage_path`** | `string` | `".dsh/kujira/slang/slang.md"` | **黑话 Markdown 参考导出路径**。用于将 SQLite 词库导出为人可读的 Markdown文本供审阅。 |

---

### Tab 7: 更多配置 (More)

收纳 1 对 1 基础场景下通常不需要关注的进阶管理配置，包含管理员名单鉴权、隐私工具热隔离与冷场主动搭话名单过滤。面板内各项直接平铺展开，免除冗余折叠操作。

| 参数名 | 字段类型 | 默认值 | 作用域与机制说明 |
| :--- | :--- | :--- | :--- |
| **`admins`** | `string[]` | `[]` | **管理员名单（支持多选，仅存脱敏内部 `peer`）**。<br/>• 为空时按 1 对 1 场景对所有单聊好友开放审批与全部斜杠命令；<br/>• 非空时仅名单内用户可审批敏感工具（无人值守定时任务/冷场搭话始终 Fail-Closed），以及使用 `/权限`、`/模型 ... -默认`、`/思考 ... -默认`；<br/>• 首次配置请先向机器人发送一条消息，即可在脱敏下拉列表（短 OpenID + 相对时间 + 消息摘要）中识别并添加自己，保存后热生效。 |
| **`privacy_tools_enabled`** | `boolean` | `false` | **隔离可能泄露隐私的工具总开关**。<br/>• 关闭（默认）：不隔离任何会话，1 对 1 开箱即用；<br/>• 开启：按下方名单规则对会话热隔离 9 个可能访问宿主机文件与环境的工具（`bash`、`pwsh`、`read`、`write`、`edit`、`apply_patch`、`working_directory`、`load_workspace_dependencies`、`skill`），始终保留 `send_file`、`read_image`、`web_search`/`web_fetch`、`ask_user_question` 及全部 QQ 单聊专属工具；保存后对存活会话即时热生效。 |
| **`privacy_tools_list_mode`** | `'whitelist' \| 'blacklist'` | `'whitelist'` | **隐私工具隔离名单模式**（平铺展开）：<br/>• `whitelist`（白名单模式，默认）：仅白名单内用户豁免隔离可使用上述工具，其余用户一律隔离（空白名单 = 勾选总开关即全员隔离）；<br/>• `blacklist`（黑名单模式）：仅隔离黑名单内用户，其余用户正常使用。 |
| **`privacy_tools_whitelist`** | `string[]` | `[]` | **隐私工具白名单用户列表**（仅白名单模式生效，存内部脱敏 `peer`）。 |
| **`privacy_tools_blacklist`** | `string[]` | `[]` | **隐私工具黑名单用户列表**（仅黑名单模式生效，存内部脱敏 `peer`）。 |
| **`idle_reply_list_mode`** | `'blacklist' \| 'whitelist'` | `'blacklist'` | **冷场主动搭话名单过滤模式**（平铺展开）：<br/>• `blacklist`（黑名单模式，默认）：排除黑名单用户，其余已互动用户正常触发；<br/>• `whitelist`（白名单模式）：仅白名单用户触发，其余好友不受打扰。 |
| **`idle_reply_blacklist`** | `string[]` | `[]` | **冷场主动搭话黑名单用户列表**（仅黑名单模式生效，存内部脱敏 `peer`）。 |
| **`idle_reply_whitelist`** | `string[]` | `[]` | **冷场主动搭话白名单用户列表**（仅白名单模式生效，存内部脱敏 `peer`）。 |

---

## 3. 典型角色调优配方 (Preset Recipes)

通过组合配置项，可迅速将机器人调校出三种极具代表性的交互风格：

### 配方 A：“随叫随到”型工作专业助手
> **场景**：个人效率工具、代码答疑、任务跟进与日程提醒。要求反应极快、不冗余拖沓。
- **回复节奏 (Reply)**：
  - `aggregation_enabled`: `true`
  - `aggregation_min_seconds`: `3`
  - `aggregation_max_seconds`: `10`
  - `proactive_attitude`: `'enthusiastic'`
  - `instant_reply_enabled`: `true`
  - `idle_reply_enabled`: `false`

### 配方 B：“慢条斯理”型沉浸贴心伙伴
> **场景**：日常闲聊、情感树洞、懂梗斗图、真实拟人体验。
- **回复节奏 (Reply)**：
  - `aggregation_enabled`: `true`
  - `aggregation_min_seconds`: `15`
  - `aggregation_max_seconds`: `60`
  - `proactive_attitude`: `'balanced'`
  - `instant_reply_enabled`: `true`（连续连聊时秒回，增加互动兴奋感）
  - `idle_reply_enabled`: `true`（`idle_reply_min_mins: 45`, `idle_reply_max_mins: 180`）
- **表情资产**：
  - `face_store_max`: `150`
  - `face_evict_policy`: `'evict_lru'`

### 配方 C：“高冷独立”型冷系角色
> **场景**：傲娇、独立自主、不主动迎合的角色设定。
- **回复节奏 (Reply)**：
  - `aggregation_enabled`: `true`
  - `aggregation_min_seconds`: `30`
  - `aggregation_max_seconds`: `90`
  - `proactive_attitude`: `'aloof'`
  - `instant_reply_enabled`: `false`
  - `idle_reply_enabled`: `false`
