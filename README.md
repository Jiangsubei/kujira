# kujira

<p align="center">
  <img src="./icon.svg" width="128" height="128" alt="kujira logo" />
  <br />
  <sub>图标形象源自 B 站用户 <strong>ZipZipPipe</strong> 与 <strong>上善无形</strong>（社区开源共创形象）</sub>
</p>

<p align="center">
  <strong>DeepSeek Harness × QQ 官方 Bot API v2 合规单聊（C2C）拟人化聊天插件</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kujira"><img src="https://img.shields.io/npm/v/kujira.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/deepseek-ai/dsh"><img src="https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.2-4f46e5" alt="DeepSeek Harness" /></a>
  <a href="https://q.qq.com/"><img src="https://img.shields.io/badge/QQ%20Bot%20API-v2%20Compliant-00CAFC" alt="QQ Bot API" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.12.0-339933" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/Tests-830%2B%20Passing-brightgreen" alt="Tests" />
</p>

DeepSeek Harness (DSH) × QQ 官方 Bot 接入插件 —— 既是随叫随到的专业助手，也是能记事实、懂梗玩词、具备仿生动态呼吸节奏的贴心伙伴。让 DSH Agent 在 QQ 官方单聊（C2C）中合规开箱即用。

> [!IMPORTANT]
> **官方正向合规直连**
> 本项目全面基于腾讯 **QQ 开放平台官方 Bot API v2** 规范构建，采用正向 WebSocket 长连接与 OpenAPI 直连通信。告别第三方协议端封号风控，零外部逆向服务依赖，提供长期稳定的生产级接入能力。

> [!CAUTION]
> **安全模型与多好友权限隔离**
> - **默认 1 对 1 开箱即用**：在 QQ 开放平台创建机器人的开发者默认可直接添加机器人为好友。未配置管理员名单与隐私隔离时，默认按 1 对 1 私人助手场景开放完整工具、审批与全部斜杠命令；
> - **多好友防隐私泄露控制**：若在开放平台将其他好友加入体验名单，强烈建议在 WebUI **「更多配置」** 设置中配置：
>   1. **管理员名单 (`admins`)**：配置后仅名单内用户可审批敏感工具，以及执行 `/权限`、`/模型 ... -默认`、`/思考 ... -默认`（其余日常指令与本会话内切换模型/思考仍对好友开放）；
>   2. **隔离可能泄露隐私的工具 (`privacy_tools_enabled`)**：勾选开启后默认对所有单聊隔离 Shell、文件读写、目录、环境依赖与技能加载（保留 `send_file`、`read_image` 与聊天工具），可在下方配置白名单豁免或黑名单精准隔离；
> - **首次自举与热生效**：配置名单前先向机器人发任意消息，即可在 WebUI 脱敏下拉列表中识别并添加自己；保存后对所有存活会话**立即热生效**，无需重启或新建会话。

---

## ✨ 核心特性

- **官方合规正向网关**：内置 WebSocket 网关客户端与 OpenAPI 调度体系，全自动心跳保活、网络抖动重连与凭据鉴权，无需维护任何第三方协议端进程。
- **事件驱动单聊消息聚合与仿生动态时钟**：
  - **Peer 独立状态机**：多用户单聊状态互不干扰，彻底杜绝全局轮询饥饿；
  - **25% 温和折减与触底下限锁定**：用户连续输入时，剩余聚合时间温和折减（$T_{remaining} \times 0.75$），触底锁定防打字饥饿；
  - **双层动量算法**：结合微观时延 $\Delta t_{turn}$（秒级接话 vs 离席）与宏观历史切片回溯，自适应拟人化回复节奏；
  - **互动偏好与概率秒回**：支持热情、均衡、冷淡三段式偏好调节，连续热聊场景支持概率秒回突破聚合下限。
- **用户侧静默出站体系**：遵循「用户侧静默原则」，模型思考与中间推演在内部完成；文本与排版统一通过 **`send_qq_message`** 工具驱动出站，由模型根据上下文短 ID（`msg_1` / `msg_self_2`）自主决定是否引用（`reply_to`）。
- **原生 Markdown 与富媒体交互**：
  - QQ 单聊原生支持 Markdown 渲染（标题、列表、表格、代码高亮、引用卡片等）；
  - 入站文件与语音裸 GET 即时安全落盘，自动 MD5 去重与防路径穿越；
  - 聊天记录与合并转发卡片（`message_type=102`）本地化解构渲染。
- **单聊专属预设（`kujira-session`）**：构建期与运行时单一真相源（SSOT）自动同步，注入专属轻量化提示词与单聊工具集；屏蔽无关 Coding 冗余，彻底杜绝 QQ 专用工具泄露至 WebUI 常规会话。
- **双层记忆体系**：单聊会话规则 + 用户专属画像，基于 Markdown 持久化存储；写入侧受独立字符预算硬拒绝约束，注入侧保持原子读取，单 Agent 轮次内“顺手提炼”。
- **黑话学习系统**：基于 SQLite 存储的词库，全局常驻 L1 索引动态注入，支持查梗、收录新梗与满额拒绝/LRU淘汰策略。
- **表情包资产闭环**：默认常驻装配，提供查表情、发表情、收录好图与满额管控（默认拒绝新增，支持 LRU 淘汰）全生命周期工具链。
- **纯两字中文斜杠命令与权限分层**：开箱支持 `/状态`、`/模型`、`/思考`、`/停止`、`/新建`、`/会话`、`/用量`、`/压缩`、`/权限`、`/帮助` 10 大指令；`/模型` 与 `/思考` 统一支持 `-默认` 设定新建会话默认值；配置 `admins` 后自动对 `/权限` 及 `-默认` 全局配置启用管理员门控。
- **WebUI 7 大 Tab 设置面板**：集成于 DSH 设置界面，涵盖 29 项核心参数，全部支持 volatile 动态热更新（含管理员审批、隐私工具热隔离与冷场搭话黑白名单），废弃字段全自动物理自愈过滤。

---

## ⚡ 极速上手

整个部署流程仅需 **“装插件 → 官方后台拿凭据 → 填入即连”** 3 步，其余 29 项运行参数开箱即具备精心调校的默认值。

### 步骤 1：安装插件（双端二选一）

#### 途径 A：DSH 桌面端（Desktop GUI）
1. 打开 DSH 桌面客户端，进入左侧 **「设置」** → **「插件」**；
2. 点击 **「添加插件」**，在输入框中输入包名：
   ```text
   kujira
   ```
3. 点击安装并确认启用。

#### 途径 B：CLI / Web 端（命令行用户）
```bash
# 推荐：安装到 DSH 的 web profile
dsh plugin --profile web add kujira

# 或安装到全局默认 profile
dsh plugin add kujira
```

---

### 步骤 2：获取 QQ 开放平台机器人凭据

1. 打开浏览器访问 [QQ 开放平台](https://q.qq.com/) 并登录；
2. 在左侧边栏点击 **「机器人」** → **「去创建 / 管理我的机器人」** → 点击 **「创建机器人」**；
3. 填写机器人基本信息创建完成后，进入该机器人管理页面：
   - 在基础信息中复制 **AppID**（机器人 ID）；
   - 在开发管理 / 密钥管理中生成并复制 **密钥 (AppSecret)**。

> [!TIP]
> 创建机器人的 QQ 账号默认就是该机器人的管理员，**默认即可直接通过手机 QQ 搜索或扫码添加该机器人为好友**，无需任何额外白名单配置！

---

### 步骤 3：填入凭据，即刻畅聊

1. 打开 DSH 设置面板中的 **kujira** 插件卡片：
   - **桌面端**：直接在客户端「插件设置」中找到 `kujira`；
   - **Web 端**：启动 `dsh --profile web` 后，浏览器访问 `http://127.0.0.1:3080/`；
2. 切换至 **「常规 (Connection)」** 分区：
   - 填入上一步获取的 **AppID** 与 **密钥**；
   - 点击 **保存**（凭据受 DSH `ctx.credentials` 只写保护，明文安全持久化且前端不回显）；
3. 用手机 QQ 扫描机器人的测试二维码或添加机器人好友，发送任意文本，机器人即刻以拟人化节奏回复！

---

## ⚙️ 运行时配置全景 (29 项)

配置面板在 WebUI 中分为 7 个 Tab 分区，所有参数均支持动态热生效：

### 1. 常规 (Connection)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `AppID` | `string` | *(必填)* | QQ 开放平台机器人 AppID（只写保护，不入配置文件） |
| `密钥 (AppSecret)` | `string` | *(必填)* | QQ 开放平台机器人密钥（只写保护，不入配置文件） |
| `image_ttl_days` | `number` | `7` | 外来图片与媒体资源本地缓存保留天数 |

### 2. 回复节奏 (Reply)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `new_message_behavior` | `'steer' \| 'queue'` | `'steer'` | 运行中收到新消息的行为模式（`steer` 及时插话 vs `queue` 加入队列） |
| `proactive_attitude` | `'enthusiastic' \| 'balanced' \| 'aloof'` | `'balanced'` | 互动偏好分段（`enthusiastic` 热情 / `balanced` 均衡 / `aloof` 冷淡） |
| `aggregation_enabled` | `boolean` | `false` | 消息聚合回复总开关（连续消息按周期窗口合并回复，需手动开启） |
| `aggregation_min_seconds` | `number` | `10` | 聚合等待最小时长（秒，硬底线） |
| `aggregation_max_seconds` | `number` | `60` | 聚合等待最大时长（秒） |
| `instant_reply_enabled` | `boolean` | `false` | 允许在连续热聊时概率秒回（突破聚合下限） |
| `idle_reply_enabled` | `boolean` | `false` | 冷场主动搭话总开关（长时间无新消息时主动发起话题，名单过滤见「更多配置」） |
| `idle_reply_min_mins` | `number` | `30` | 潜水主动搭话最小沉默时长（分钟） |
| `idle_reply_max_mins` | `number` | `120` | 潜水主动搭话最大沉默时长（分钟） |

### 3. 人格与准则 (Persona & Behavior)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `persona` | `string` | *(内置)* | 助手的人格设定（注入 System Prompt 动态段） |
| `behavior` | `string` | *(内置)* | 行为约束准则（注入 System Prompt 动态段） |

### 4. 记忆 (Memory)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `memory_storage_dir` | `string` | `".dsh/kujira/memory"` | 双层记忆 Markdown 文件存储根目录 |
| `user_profile_budget_chars` | `number` | `2200` | 单个用户画像文件的写入字符上限 |
| `session_memory_budget_chars` | `number` | `2200` | 单个会话规则文件的写入字符上限 |

### 5. 表情包 (Face)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `face_store_max` | `number` | `100` | 本地表情库存储容量上限（张） |
| `face_store_dir` | `string` | `".dsh/kujira/faces"` | 本地表情库文件存储目录 |
| `face_evict_policy` | `'reject' \| 'evict_lru'` | `'reject'` | 库容满额策略（`reject` 拒绝 / `evict_lru` 淘汰最久未用） |

### 6. 黑话学习 (Slang)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `slang_max_entries` | `number` | `300` | 黑话知识库条数上限 |
| `slang_evict_policy` | `'reject' \| 'evict_lru'` | `'reject'` | 黑话满额策略（`reject` 拒绝 / `evict_lru` 淘汰查阅最少词条） |

### 7. 更多配置 (More)
| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `admins` | `string[]` | `[]` | 管理员名单（存内部脱敏 `peer`）；为空按 1 对 1 开放，非空时仅管理员可审批与执行 `/权限`、`/模型 -默认`、`/思考 -默认` |
| `privacy_tools_enabled` | `boolean` | `false` | 隔离可能泄露隐私的工具总开关（Shell/文件/目录/环境/技能，保留发文件与识图），保存即对存活会话热生效 |
| `privacy_tools_list_mode` | `'whitelist' \| 'blacklist'` | `'whitelist'` | 隐私工具隔离名单模式（`whitelist` 白名单豁免 / `blacklist` 黑名单精准隔离） |
| `privacy_tools_whitelist` | `string[]` | `[]` | 隐私工具白名单用户 `peer` 列表（白名单模式下放行；空表时开启开关即全员隔离） |
| `privacy_tools_blacklist` | `string[]` | `[]` | 隐私工具黑名单用户 `peer` 列表（黑名单模式下仅隔离名单内用户） |
| `idle_reply_list_mode` | `'blacklist' \| 'whitelist'` | `'blacklist'` | 冷场主动搭话名单过滤模式（`blacklist` 黑名单排除 / `whitelist` 白名单仅允许） |
| `idle_reply_blacklist` | `string[]` | `[]` | 冷场主动搭话黑名单用户 `peer` 列表（黑名单模式排除） |
| `idle_reply_whitelist` | `string[]` | `[]` | 冷场主动搭话白名单用户 `peer` 列表（白名单模式仅允许） |

---

## 💬 10 大纯两字中文斜杠命令

在 QQ 单聊中发送带有 `/` 前缀的中文指令，可直接操控当前 Agent 运行时状态（配置 `admins` 后，高危/默认配置项自动受管理员门控）：

| 指令 | 权限级别 | 说明 | 示例 |
|---|---|---|---|
| `/状态` | 全员 | 查看当前会话状态、模型版本、思考档位与运行时指标 | `/状态` |
| `/模型` | 全员（`-默认` 仅管理员） | 查看或切换当前会话模型；追加 `-默认` 设为新建会话默认模型 | `/模型 deepseek-v4-flash -默认` |
| `/思考` | 全员（`-默认` 仅管理员） | 查看或切换当前会话思考深度；追加 `-默认` 设为新建会话默认思考深度 | `/思考 high -默认` 或 `/思考 关` |
| `/新建` | 全员 | 结束当前会话轮次，就地开启新会话（记忆跨轮次保留） | `/新建` |
| `/会话` | 全员 | 浏览历史会话列表并按序号或标题无损切回 | `/会话` 或 `/会话 2` |
| `/用量` | 全员 | 查询当前会话 Token 消耗明细与上下文占比 | `/用量` |
| `/压缩` | 全员 | 立即对当前会话历史进行结构化摘要压缩，释放上下文空间 | `/压缩` |
| `/停止` | 全员 | 紧急中断正在运行中的 Agent 思考与生成回合 | `/停止` |
| `/权限` | 仅管理员（配置 `admins` 后） | 查看或切换会话运行权限模式（`只读` / `编辑` / `完全`） | `/权限 编辑` |
| `/帮助` | 全员 | 显示所有可用指令与使用简要指南 | `/帮助` |

---

## 🛠️ 开发与测试

```bash
# 1. 克隆仓库
git clone https://github.com/Jiangsubei/kujira.git
cd Kujira

# 2. 安装依赖并编译
pnpm install
pnpm build         # 同步预设、tsc 编译与客户端面板构建

# 3. 运行测试
pnpm test:quick    # 快速运行测试套件
pnpm check:privacy # 隐私守卫检查（确保无真实凭据/敏感信息入库）
pnpm test          # 完整构建测试（pnpm build + vitest run）
```

---

## 📚 文档索引

面向使用者的开源专题文档存放于 `docs/` 目录：

- [文档中心索引 (docs/README.md)](docs/README.md)：专题文档总览与快速导航入口。
- [快速上手指南 (docs/getting-started.md)](docs/getting-started.md)：详细环境准备、QQ 开放平台操作图解、双端安装与验证排查。
- [系统架构与设计哲学 (docs/architecture.md)](docs/architecture.md)：仿生动态时序引擎数学模型、正向网关、静默出站体系深度解析。
- [运行时配置全景参考 (docs/configuration.md)](docs/configuration.md)：29 项核心配置详尽字典、管理员权限与隐私工具热隔离、调优配方与自愈机制。
- [Agent 工具集与斜杠命令手册 (docs/tools-and-commands.md)](docs/tools-and-commands.md)：16 大专属工具 Lossless JSON 契约与 10 大命令。
- [常见问题排查与实测手册 (docs/troubleshooting.md)](docs/troubleshooting.md)：实测避坑（40054005 跨天去重、40034024 ID混淆、流式 50015001、2 分钟撤回）、探针使用指南。

---

## 📄 License & Credits

- **Logo & Artwork**: 图标形象源自 B 站用户 **ZipZipPipe** 与 **上善无形**，为社区开源共创形象，特别致谢创作者对社区的支持与贡献！
- **Author**: Jiangsubei
- **License**: [MIT](LICENSE)
