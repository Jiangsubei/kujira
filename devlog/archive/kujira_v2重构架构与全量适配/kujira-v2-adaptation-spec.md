# kujira 改造架构规范（QQ 官方 Bot API v2 · 合规 C2C 单聊）

> **状态**：已归档（Batch 1–4 代码重构、打包构建与全仓 92/92 契约与单元测试均已通过，待真机实联验证）
> **前置实证依据**：参见 [`devlog/archive/QQ官方Bot_API实测与踩坑/`](../QQ官方Bot_API实测与踩坑/) 全部 5 份实测报告。严禁采信腾讯官方文档未实测条款。
> **规范约束**：严格遵守根目录 [`AGENTS.md`](../../AGENTS.md) 的隐私守卫（`privacy-guard`）、TDD、DSH Lossless JSON、禁止造假与提交前强制 `pnpm build` 红线。

---

## 1. 插件品牌、命名与数据目录（彻底独立，零旧项目兼容）

- **包名 / 插件名 / 配置命名空间**：统一为 **`kujira`**（不再保留 `dsh-napcat-bridge` / `napcat` 命名，不编写旧版 `settings.yaml` / `.dsh/napcat/` 兼容迁移）。
- **Tools 插件**：
  - 导出路径：`kujira/tools`（`dist/tools/plugin.js`）
  - 插件 `name`：`'kujira-tools'`，服务键：`'kujiraBridgeTools'`
- **WebUI 服务端路由**：`/plugins/kujira/config`、`/plugins/kujira/faces`、`/plugins/kujira/slang`
- **WebUI 扩展槽**：`id: 'kujira'`，`label: () => 'QQ Kujira'`（按 `locale` 输出中英文）
- **预设 Preset**：`KUJIRA_PRESET_ID = 'kujira-session'`（`cordis.patch.yml` 插入 `- id: kujira` 与 `- id: preset-kujira-session`）
- **本地存储路径（相对 `$DSH_HOME`）**：
  - 数据库：`.dsh/kujira/messages.sqlite`
  - 下载媒体：`.dsh/kujira/downloads`
  - 双层记忆根目录：`.dsh/kujira/memory`
  - 表情包库：`.dsh/kujira/faces`
  - 黑话导出参考路径：`.dsh/kujira/slang/slang.md`
  - 默认工作区：`.dsh/workspace/kujira`

---

## 2. 身份标识映射方案（方案 A：短 Hash + 数据库双向映射）

- **外部入站标识**：实测 `C2C_MESSAGE_CREATE` 的 `d.author.user_openid` 为 32 位大写十六进制（亦防备未来含 `-` 或大小写混用）。
- **内部标准化 Hash**：
  - `computeOpenidHash16(openid)`: `crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16)`（16 位小写 `[0-9a-f]{16}`）。
  - **内部 Peer**：`user_<hash16>`
  - **DSH SessionId**：`kujira-user-<hash16>`（支持 `-r<round>-<version>[-<hash6>]` 多轮归档后缀，由 [`id-resolver.ts`](../../src/gateway/session/id-resolver.ts) 解析）。
- **数据库双向映射**：
  - SQLite `peer_openid_map(peer TEXT PRIMARY KEY, openid TEXT UNIQUE NOT NULL, remark TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`。
  - 首条入站事件处理前必须先调用 `upsertPeerOpenid(peer, openid)`；所有出站接口调用前通过 `getOpenidByPeer(peer)` 反查真实 `openid`。
- **单聊强隔离边界**：
  - 记忆（`session` + `user`）与历史检索工具**禁止跨会话调用**：两层记忆均以当前会话 `peer` 为物理主键，移除工具参数中的 `peer` / `user_id` 跨会话指定能力，移除 `default.md` 跨会话兜底。仅 `slang` 黑话知识库全局共享。

---

## 3. 凭据管理规范（DSH 官方 `ctx.credentials`）

- **不入配置文件**：`app_id` 与 `app_secret` 不写入插件 `BridgeConfigSchema` 与 `cordis.patch.yml`，全部交给 DSH 原生 `@deepseek-ai/dsh-credentials`（落盘 `$DSH_HOME/.credentials.yaml` `refs:`）。
- **引用键名**：`QQ_BOT_APP_ID`、`QQ_BOT_SECRET`（与 `scripts/lib/qq-probe-client.ts` 一致）。
- **解析层级**：
  - 运行时通过 DSH `ctx.credentials.resolve(credentialRef(...))`（内置优先级：`$DSH_HOME/.credentials.yaml > process.env > <cwd>/.env > $DSH_HOME/.env`）；若宿主未注入 `ctx.credentials`（独立测试/CLI），回退同序本地文件与 `process.env` 读取器。
- **WebUI 配置交互**：
  - WebUI「连接配置」卡片提供 `AppID` 与 `AppSecret` 两个 write-only 输入框。
  - `GET /plugins/kujira/config` 通过 `ctx.credentials.describe(...)` 返回状态元数据 `{ appId: { configured, source, writable }, appSecret: { configured, source, writable } }`，**均不回显明文**。
  - `POST /plugins/kujira/config` 若提交了非空 `credentials.app_id` / `credentials.app_secret`，由服务端调用 `ctx.credentials.set(...)` 安全写入 `$DSH_HOME/.credentials.yaml` 并触发热重连（亦支持 `reset` / `unset` 清空后回落环境变量）。

---

## 4. 三 ID 严格隔离、发送调度与实测协议硬约束

1. **三 ID 模型**：
   - **入站被动锚点 `msg_id`**：仅来自 `C2C_MESSAGE_CREATE` `d.id`（`ROBOT1.0_...` 字符串）。**严禁将出站响应 `body.id` 写入锚点**（混用必报 `40034024`）。
   - **出站撤回 ID**：发送成功响应 `body.id`（被动约 97 字 / 主动约 117 字），仅用于 `DELETE /v2/users/{openid}/messages/{message_id}`（**严格 120s 时限，超限 `40064004`**；撤回入站 ID 报 `40061002`；撤回自身具备幂等性返回 `200 {}`）。
   - **引用索引 `ref_idx`**：`REFIDX_...` 字符串（入站 `message_scene.ext` 中 `msg_idx=REFIDX_...`，出站 `body.ext_info.ref_idx`）。仅可用于 `message_reference.message_id`。
2. **`msg_seq` 槽位与被动/主动降级**：
   - SQLite `inbound_reply_slots(msg_id TEXT PRIMARY KEY, peer TEXT NOT NULL, openid TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)` 持久化每个入站 `msg_id` 的递增值，经 `PerPeerSerialSender` 串行分配（跨 `msg_type=0/2/6/7`、命令回执、提问/审批与流式共享）；
   - `(msg_id, msg_seq)` 去重跨天残留，遇 `40054005` 自动取下一未使用 `msg_seq` 重试；
   - 发信策略：**优先使用最近有效入站 `msg_id`**（实测跨数小时及 28h+ 均有效；定时任务唤醒不得清除历史有效入站 `msg_id`），当无入站锚点或遇到锚点超限报错时，普通消息（`msg_type=0/2/7`）降级为**主动消息**（不传 `msg_id`/`msg_seq`）；**严禁在无 `msg_id` 时调用 `stream_messages`**（必报 `50015001`）。
3. **Markdown 与分段上限**：
   - 单聊 `msg_type=2` 原生完整支持 Markdown（表格、围栏代码块、四级标题、裸 URL、无白名单限制）。开启 `markdown_enabled` 时只传 `markdown: { content }` 且保证非空（防 `40034011`），并将无空格 `#标题` 规范化为 `# 标题`。
   - **严禁按字符数静默截断**：分段严格按 **UTF-8 字节数**（普通消息按 16 KiB 切分多条发送；流式分片按 8 KiB 且仅用 `append` 模式，忽视恒为 `0` 的 `remain_msg_len`）。
4. **富媒体四步上传与入站下载**：
   - 本地媒体走 `upload_prepare` -> **1-based `parts[].index` 升序 + 累积 `offset` + 每片自身 `block_size`** 切片并裸 `PUT` -> `upload_part_finish`（传该片 `block_size`） -> `files` -> `msg_type=7`。按 `(openid, md5, file_type)` 缓存 `file_info` 复用（`ttl=86400s`），不假设服务端秒传。
   - 入站 `attachments[]` 均直接裸 `GET`（不带 Token）；下载错误与日志及正文中**严禁暴露带 query 凭证的完整 URL**；语音以 `content_type === 'voice'` 为准（忽略错误响应头 `audio/mp3`），优先拉取 `voice_wav_url` 并提取 `asr_refer_text`；文件执行 `path.basename` + 非法字符净化；入站 `.png` 若标 `content_type === 'file'` 需结合魔数识别。
   - 入站引用（`message_type=103`）解析 `ref_msg_idx=REFIDX_...` 或 `TMP_...` 回退 `msg_elements`；入站合并转发（`message_type=102`）已由平台展开于 `content` 中；入站卡片（`message_type=3`）直取 `d.ark_data` 与 `content`。

---

## 5. 配置项、去群聊、去鉴权与工具收敛清单

1. **移除全部群聊、OneBot、主动插话、安全配置、`admins` 与夜间免打扰**：
   - `BridgeConfigSchema` 精简为 **17 项核心单聊配置**：
     `image_ttl_days`, `markdown_enabled`, `input_notify_enabled`, `new_message_behavior`, `persona`, `behavior`, `memory_storage_dir`, `user_profile_budget_chars`, `session_memory_budget_chars`, `face_enabled`, `face_store_max`, `face_store_dir`, `face_evict_policy`, `slang_enabled`, `slang_max_entries`, `slang_evict_policy`, `slang_storage_path`。
   - **安全配置与 `admins` 全部移除**：不设黑名单、不设 `session_permission_*` / `coding_tools_*`、`admins` 鉴权一并去掉；单聊新会话默认采用 `'workspace-write'` 权限并装载 Preset 内置 Coding 工具（可通过 `/permission` 命令单会话动态切换）；斜杠命令与 `approval/request` 放行给已接入的 C2C 好友。
   - **保留无配置的内部 [`TurnInitiatorTracker`](../../src/approval/turn-initiator.ts)**：区分「真人 C2C 唤醒（`'direct'`）」与「`scheduled_task` 系统后台唤醒（`is_system: true`）」，确保后台定时任务触发需审批工具时仍维持 Fail-Closed。
   - 移除群夜间免打扰拦截（`isNightDnd` / `proactive_night_dnd`）。
2. **老工具去留**：
   - 删除群聊、OneBot、跨 Agent 已清理模块，及 `group-file-resolve.ts`、`private-file.ts`；
   - **暂时保留**：`expand_forward_message` 与 `fetch_chat_resource`（顺势适配 `message_type=102` 内嵌文本/裸 GET URL 与本地 `attachments` 重新拉取，剥离所有 OneBot Action 与 `busid`/WSL 依赖）。
