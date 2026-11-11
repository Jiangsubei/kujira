/**
 * kujira: 主插件入口 (Cordis Plugin)
 * 接入 QQ 官方 Bot API v2（合规单聊 C2C），整合网关、SQLite 存储、双层记忆、
 * 黑话学习、表情包资产库、工具集、定时调度、提问/审批瀑布流与 WebUI 配置路由。
 */

import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import {
  PLUGIN_NAME,
  SETTINGS_NAMESPACE,
  DEFAULT_MEMORY_DIR,
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  DEFAULT_DATABASE_PATH,
  DEFAULT_FACE_STORE_MAX,
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_SLANG_STORAGE_PATH,
  DEFAULT_SLANG_MAX_ENTRIES,
  DEFAULT_SLANG_EVICT_POLICY,
} from './constants/index.js';

const QQ_INBOUND_MSG_TYPE_FORWARD = 102;
import { getRuntimePresetDefinition, QQ_PRESET_ID } from './constants/preset.js';
import { BridgeConfigSchema } from './config/schema.js';
import { sanitizeConfigPayload, healProfileConfigFile } from './config/heal.js';
import { resolveCredentials } from './config/credentials.js';
import { resolveDshPath } from './utils/path.js';
import { isValidOpenid, openidToPeer } from './utils/peer.js';
import type {
  BridgePluginConfig,
  MessageRecord,
  QQC2CMessageCreateEvent,
} from './types/index.js';
import { MessageDatabase } from './storage/database.js';
import { MediaStorageManager, startMediaCleanupTask, computeFileMd5 } from './storage/media.js';
import {
  KujiraGatewayClient,
  MessageWaitRegistry,
  type WaitCollectedMessage,
} from './gateway/server.js';
import {
  resolveInboundAttachments,
  resolveEmbeddedForwardImages,
  sanitizeForwardContentUrls,
} from './gateway/inbound-media.js';
import {
  shouldWakeup,
  extractMessageRefIdx,
  extractQuotedRefIdx,
  type QuotedMessageRecord,
} from './gateway/wakeup.js';
import { SessionManager } from './gateway/session.js';
import { SystemEventHub } from './gateway/system-event-hub.js';
import {
  describeInboundAttachments,
  toMessageMediaFields,
} from './attachment/classify.js';
import { deserializeAttachments, serializeAttachments } from './attachment/store.js';
import { OutboundStreamBridge } from './outbound/stream.js';
import { recordOutboundSelfMessage } from './outbound/self-record.js';
import {
  KujiraQuestionProvider,
  registerKujiraQuestionChannel,
  KujiraApprovalResponder,
  TurnInitiatorTracker,
} from './approval/index.js';
import { TaskScheduler } from './scheduler/index.js';
import { setupSnapshotHub, type SnapshotManager } from './prompt/snapshot.js';
import { setupMemoryService } from './memory/index.js';
import { setupSlangService } from './slang/index.js';
import {
  registerAgentTools,
  createMemoryToolDefinitions,
  type AgentToolsOptions,
} from './tools/index.js';
import { setGlobalBridgeToolsProvider, type KujiraBridgeToolsProvider } from './tools/plugin.js';
import { isSlashCommand, handleSlashCommand } from './commands/index.js';
import { registerConfigRoute } from './server/routes.js';
import { registerFacesRoutes } from './server/face-routes.js';
import { registerSlangRoutes } from './server/slang-routes.js';

export * from './memory/index.js';
export * from './slang/index.js';

export const name = PLUGIN_NAME;
export const inject = ['tools', 'systemPrompt', 'agents'];
export const Config: any = BridgeConfigSchema;

function resolvePluginDshHome(): string {
  return path.resolve(
    process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.dsh')
  );
}

function extractConfigValues(cfg: unknown): BridgePluginConfig {
  if (!cfg || typeof cfg !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(cfg as Record<string, unknown>)) {
    if (val && typeof val === 'object' && typeof (val as { get?: unknown }).get === 'function') {
      out[key] = (val as { get: () => unknown }).get();
    } else {
      out[key] = val;
    }
  }
  return out as BridgePluginConfig;
}

function readHostSettingsConfig(ctx: Context): BridgePluginConfig {
  const settingsService = (ctx as any).get?.('settings');
  if (!settingsService) return {};
  try {
    if (typeof settingsService.describe === 'function') {
      const desc = settingsService.describe().find((d: any) => d.ns === SETTINGS_NAMESPACE);
      if (desc?.value) return desc.value as BridgePluginConfig;
    }
    if (typeof settingsService.get === 'function') {
      const val = settingsService.get(SETTINGS_NAMESPACE);
      if (val && typeof val === 'object') return val as BridgePluginConfig;
    }
  } catch {
    // 忽略 settings 尚未就绪或不可读的场景
  }
  return {};
}

function mergeBridgeConfigs(base: BridgePluginConfig, overrides: BridgePluginConfig): BridgePluginConfig {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined && val !== '') {
      result[key] = val;
    } else if (result[key] === undefined) {
      result[key] = val;
    }
  }
  return result as BridgePluginConfig;
}

function parseIsoTimeMs(raw?: string): number {
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function toQuotedRecord(row: MessageRecord | null | undefined): QuotedMessageRecord | null {
  if (!row) return null;
  const images: string[] = [];
  if (row.local_path) images.push(row.local_path);
  for (const desc of deserializeAttachments(row.attachments)) {
    const p = desc.local?.path;
    if (p && (desc.kind === 'image' || desc.kind === 'sticker') && !images.includes(p)) {
      images.push(p);
    }
  }
  return {
    msg_id: row.msg_id,
    short_id: row.short_id ?? null,
    ref_idx: row.ref_idx ?? null,
    user_id: row.user_id,
    sender_name: row.sender_name,
    time: row.time,
    content: row.content,
    self: row.self,
    local_path: row.local_path,
    type: row.type,
    ...(images.length > 0 ? { images } : {}),
  };
}

function provideService(ctx: Context, key: string, value: unknown): void {
  try {
    if (typeof (ctx as any).provide === 'function') {
      (ctx as any).provide(key, value);
    }
  } catch {}
  (ctx as any)[key] = value;
  try {
    if (typeof (ctx as any).set === 'function') {
      (ctx as any).set(key, value);
    }
  } catch {}
}

export function apply(ctx: Context, config: BridgePluginConfig = {}) {
  const logger = typeof (ctx as any).logger === 'function' ? (ctx as any).logger(PLUGIN_NAME) : console;
  const dshHome = resolvePluginDshHome();
  let isDisposed = false;

  const currentConfig = (): BridgePluginConfig => {
    const fromSettings = readHostSettingsConfig(ctx);
    const fromArgs = extractConfigValues(config);
    return sanitizeConfigPayload(mergeBridgeConfigs(fromArgs, fromSettings)).valid;
  };

  // 1. 初始化存储层（SQLite 与本地媒体管理）
  const dbPath = resolveDshPath(dshHome, undefined, DEFAULT_DATABASE_PATH);
  const db = new MessageDatabase(dbPath);
  db.init();

  const mediaManager = new MediaStorageManager({
    dshHome,
    db,
    ttlDays: currentConfig().image_ttl_days ?? DEFAULT_IMAGE_TTL_DAYS,
  });
  const stopCleanupTask = startMediaCleanupTask(ctx, mediaManager);

  // 2. 初始化 QQ 官方 Bot v2 正向网关与自记录回执
  const waitRegistry = new MessageWaitRegistry();
  const gateway = new KujiraGatewayClient({
    logger,
    onReady: (info) => {
      logger.info?.(`[Plugin] QQ Gateway 已就绪 (botId=${info.botId || 'unknown'})`);
    },
    onDispatch: (eventName, data) => {
      if (eventName === 'READY' || eventName === 'C2C_MESSAGE_CREATE') return;
      if (eventName === 'FRIEND_ADD') {
        const rawOpenid =
          data && typeof data === 'object' ? String((data as any).openid ?? (data as any).user_openid ?? '') : '';
        const peerTag = rawOpenid && isValidOpenid(rawOpenid) ? ` peer=${openidToPeer(rawOpenid)}` : '';
        logger.info?.(`[Plugin] 收到好友添加事件 (FRIEND_ADD${peerTag})`);
        return;
      }
      logger.debug?.(`[Plugin] 收到网关分发事件: ${eventName}`);
    },
    onMessageSent: (event) => {
      try {
        const status = gateway.getStatus();
        recordOutboundSelfMessage(event, {
          db,
          ...(status.botId ? { botId: status.botId } : {}),
          senderName: status.botName || '智能助手',
          logger,
        });
      } catch (err) {
        logger.warn?.('[Plugin] 出站消息自记录异常:', err);
      }
    },
  });

  // 3. 声明自定义设置卡片并挂载 WebUI 配置/表情/黑话 HTTP REST 路由
  (ctx as any).inject?.(['settings'], (s: any) => s?.settings?.configure?.({ auto: false }, (ctx as any).fiber));

  // 4. 初始化会话管理器、本轮唤醒者追踪器、出站调度中枢与定时任务引擎
  const sessionManager = new SessionManager(ctx, dshHome, db, { configGetter: currentConfig });

  const turnInitiatorTracker = new TurnInitiatorTracker({ maxExpectations: 256 });
  sessionManager.setTurnInitiatorTracker(turnInitiatorTracker);
  const unregisterTurnInitiator = (ctx as any).on?.('session/event', (session: any, event: any) => {
    try {
      turnInitiatorTracker.observe(session, event);
    } catch (err) {
      logger.warn?.('[Plugin] 本轮唤醒者追踪器处理 session/event 失败:', err);
    }
  });

  sessionManager.registerWorkspace(sessionManager.resolveCwd(), undefined, 'Kujira').catch((wsErr) => {
    logger.warn?.('[Plugin] 初始化注册 Kujira 工作区失败:', wsErr);
  });

  const outboundBridge = new OutboundStreamBridge(ctx, {
    gateway,
    sessionManager,
    db,
    getConfig: currentConfig,
    logger,
  });
  sessionManager.setOutboundBridge(outboundBridge);
  const stopOutboundBridge = outboundBridge.start();
  const serialSender = outboundBridge.getSender();

  const systemEventHub = new SystemEventHub({ sessionManager, logger });
  sessionManager.setSystemEventHub(systemEventHub);

  const taskScheduler = new TaskScheduler({
    systemEventHub,
    db,
    dispatchWakeup: async (payload) => {
      await sessionManager.dispatchWakeup(payload);
    },
    configGetter: currentConfig,
    logger,
  });
  taskScheduler.start();

  // 5. 初始化单聊强隔离双层记忆、黑话学习与 System Prompt SnapshotHub
  const rawMemoryDir = currentConfig().memory_storage_dir;
  const memoryService = setupMemoryService(ctx, {
    storageDir: resolveDshPath(dshHome, rawMemoryDir, DEFAULT_MEMORY_DIR),
    dshHome,
    registerGlobalTools: false,
    registerPromptContext: false,
    userProfileBudgetChars: currentConfig().user_profile_budget_chars,
    sessionMemoryBudgetChars: currentConfig().session_memory_budget_chars,
    getUserProfileBudgetChars: () =>
      currentConfig().user_profile_budget_chars ?? DEFAULT_USER_PROFILE_BUDGET_CHARS,
    getSessionMemoryBudgetChars: () =>
      currentConfig().session_memory_budget_chars ?? DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  });

  const rawSlangPath = currentConfig().slang_storage_path;
  const slangService = setupSlangService(ctx, {
    db,
    storagePath: resolveDshPath(dshHome, rawSlangPath, DEFAULT_SLANG_STORAGE_PATH),
    dshHome,
    registerGlobalTools: false,
    registerPromptContext: false,
    maxEntries: currentConfig().slang_max_entries,
    getMaxEntries: () => currentConfig().slang_max_entries ?? DEFAULT_SLANG_MAX_ENTRIES,
    evictPolicy: currentConfig().slang_evict_policy,
    getEvictPolicy: () => currentConfig().slang_evict_policy ?? DEFAULT_SLANG_EVICT_POLICY,
    enabled: currentConfig().slang_enabled,
    getEnabled: () => currentConfig().slang_enabled ?? true,
  });

  let snapshotManager: SnapshotManager | null = setupSnapshotHub({
    ctx,
    db,
    memoryStorage: memoryService.storage,
    slangStorage: slangService.storage,
    getSlangEnabled: () => currentConfig().slang_enabled ?? true,
    getFaceEnabled: () => Boolean(currentConfig().face_enabled),
    getFaceStoreMax: () => currentConfig().face_store_max ?? DEFAULT_FACE_STORE_MAX,
    getPersona: () => currentConfig().persona || '',
    getBehavior: () => currentConfig().behavior || '',
    logger,
  });
  if (typeof (ctx as any).reflect?.provide === 'function') {
    try {
      (ctx as any).reflect.provide('snapshotManager', snapshotManager);
    } catch {}
  }

  // 6. 装配 Agent 工具提供者 (通过 kujira-session 预设挂载，不污染 Web 会话)
  const toolsOptions: AgentToolsOptions = {
    db,
    outboundBridge,
    gateway,
    mediaManager,
    sender: serialSender,
    dshHome,
    waitRegistry,
    scheduler: taskScheduler,
    slangStorage: slangService.storage,
    config: currentConfig,
    inboundMsgIdGetter: (peer: string) => {
      const inboundCtx = outboundBridge.getActiveTurnContext(peer);
      if (inboundCtx && ((inboundCtx as any).is_synthetic || (inboundCtx as any).synthetic)) {
        return undefined;
      }
      return typeof inboundCtx?.msg_id === 'string' ? inboundCtx.msg_id : undefined;
    },
  };

  const kujiraBridgeTools: KujiraBridgeToolsProvider = {
    registerTools(targetCtx: Context) {
      const unregAgent = registerAgentTools(targetCtx, toolsOptions);
      const unregMemory: Array<() => void> = [];
      if (memoryService?.tools) {
        const toolsService =
          (targetCtx as any).tools ||
          (typeof (targetCtx as any).get === 'function' ? (targetCtx as any).get('tools') : undefined);
        if (toolsService && typeof toolsService.register === 'function') {
          for (const def of createMemoryToolDefinitions(memoryService.tools)) {
            if (typeof toolsService.get === 'function' && toolsService.get(def.name)) {
              continue;
            }
            unregMemory.push(toolsService.register(def));
          }
        }
      }
      return () => {
        try {
          unregAgent();
        } catch {}
        for (const unreg of unregMemory) {
          try {
            unreg();
          } catch {}
        }
      };
    },
  };

  setGlobalBridgeToolsProvider(kujiraBridgeTools);
  provideService(ctx, 'kujiraBridgeTools', kujiraBridgeTools);
  provideService(ctx, 'kujira-session', sessionManager);
  provideService(ctx, 'kujira-system-event-hub', systemEventHub);
  provideService(ctx, 'kujira-bridge-config', currentConfig);
  provideService(ctx, 'kujira-gateway', gateway);
  provideService(ctx, 'kujira-outbound-bridge', outboundBridge);

  (ctx as any).inject?.(['agentPresets'], (presetCtx: Context) => {
    const agentPresetsSvc = (presetCtx as any).agentPresets;
    if (agentPresetsSvc && typeof agentPresetsSvc.register === 'function') {
      agentPresetsSvc.list?.().then((presetsList: any[]) => {
        const exists = Array.isArray(presetsList) && presetsList.some((p: any) => p.id === QQ_PRESET_ID);
        if (!exists) {
          agentPresetsSvc.register(getRuntimePresetDefinition()).catch((err: any) => {
            logger.debug?.(`[Plugin] 动态注册 ${QQ_PRESET_ID} 预设已跳过或失败:`, err?.message);
          });
        }
      }).catch(() => {});
    }
  });

  // 7. 接入单聊提问 & 审批 waterfall（单聊好友均开放；scheduled_task 无发起人保留 Fail-Closed）
  const approvalResponder = new KujiraApprovalResponder({
    outboundBridge,
    gateway,
    sessionManager,
    db,
    sender: serialSender,
    turnInitiatorTracker,
    logger,
  });

  const questionProvider = new KujiraQuestionProvider({
    outboundBridge,
    gateway,
    sessionManager,
    db,
    sender: serialSender,
    logger,
  });

  let unregisterQuestionChannel: (() => void) | null = null;
  try {
    unregisterQuestionChannel = registerKujiraQuestionChannel(ctx as any, {
      questionProvider,
      isQQSession: (sid) => sessionManager.isKujiraSession(sid),
      logger,
    });
  } catch (channelErr) {
    logger.warn?.('[Plugin] 注册 Kujira 提问渠道异常:', channelErr);
  }

  const unregisterApproval = (ctx as any).on?.(
    'approval/request',
    async (req: any, next: any) => {
      const sessionId = req.agent?.session?.id;
      if (!sessionId || !sessionManager.isKujiraSession(sessionId)) {
        return next ? next() : 'unavailable';
      }
      const peer = sessionManager.sessionIdToPeer(sessionId);
      const applicantId = turnInitiatorTracker.getInitiator(sessionId);
      return await approvalResponder.handleApprovalRequest({
        peer,
        sessionId,
        toolName: req.toolName,
        callId: req.callId,
        reason: req.reason,
        applicantId: applicantId ?? null,
        signal: req.signal,
      });
    },
    { prepend: true }
  );

  // 8. Reconcile 热对齐（设置与凭据）+ 路由注册
  let activeCredSignature = '';
  let gatewayStarted = false;

  const syncGatewayCredentials = async (): Promise<void> => {
    const resolved = await resolveCredentials(ctx, { dshHome });
    const appId = (resolved.credential?.appId ?? '').trim();
    const appSecret = (resolved.credential?.appSecret ?? '').trim();
    const nextSig = appId && appSecret ? `${appId}\n${appSecret}` : '';

    if (!nextSig) {
      if (gatewayStarted) {
        logger.warn?.('[Plugin] QQ Bot 凭据已清空或移除，停止 Gateway 连接');
        gateway.stop();
        gatewayStarted = false;
      }
      activeCredSignature = '';
      return;
    }

    if (nextSig !== activeCredSignature || !gatewayStarted) {
      activeCredSignature = nextSig;
      if (gatewayStarted) {
        logger.info?.('[Plugin] 检测到 QQ Bot 凭据变更，正在热重启 Gateway...');
        await gateway.restart({ appId, appSecret });
      } else {
        gateway.updateCredentials({ appId, appSecret });
        gatewayStarted = true;
        logger.info?.('[Plugin] 已读取 QQ Bot 凭据，正在连接官方 Gateway...');
        await gateway.start();
      }
    }
  };

  const reconcile = async (forcedConfig?: BridgePluginConfig): Promise<void> => {
    if (isDisposed) return;
    const active = forcedConfig
      ? sanitizeConfigPayload({ ...currentConfig(), ...extractConfigValues(forcedConfig) }).valid
      : currentConfig();

    if (active.memory_storage_dir) {
      const updatedMemoryDir = resolveDshPath(dshHome, active.memory_storage_dir, DEFAULT_MEMORY_DIR);
      if (memoryService.storage.getBaseDir() !== updatedMemoryDir) {
        memoryService.storage.setBaseDir(updatedMemoryDir, dshHome);
      }
    }

    try {
      await syncGatewayCredentials();
    } catch (err) {
      logger.warn?.('[Plugin] 对齐 QQ Bot 凭据并连接 Gateway 失败:', err);
    }
  };

  let reconcileRunning = false;
  let hasPendingReconcile = false;
  let pendingConfig: BridgePluginConfig | undefined;

  const queueReconcile = async (newVal?: BridgePluginConfig): Promise<void> => {
    if (newVal) pendingConfig = newVal;
    hasPendingReconcile = true;
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      while (hasPendingReconcile) {
        hasPendingReconcile = false;
        const nextCfg = pendingConfig;
        pendingConfig = undefined;
        await reconcile(nextCfg);
      }
    } finally {
      reconcileRunning = false;
    }
  };

  const unregisterConfigRoute = registerConfigRoute(ctx, currentConfig, queueReconcile, { dshHome });
  const unregisterFacesRoutes = registerFacesRoutes({ ctx, db, getConfig: currentConfig, dshHome });
  const unregisterSlangRoutes = registerSlangRoutes({ ctx, storage: slangService.storage });

  const unregVolatile = (ctx as any).on?.('loader/volatile-update', () => {
    if (!isDisposed) void queueReconcile();
  });
  const unregSettingsDoc = (ctx as any).on?.('settings/document-updated', (ns: string) => {
    if (!isDisposed && (!ns || ns === SETTINGS_NAMESPACE)) {
      void queueReconcile();
    }
  });
  const unregCredUpdate = (ctx as any).on?.('credentials/reference-updated', () => {
    if (!isDisposed) void queueReconcile();
  });

  // 9. 入站 C2C_MESSAGE_CREATE 全链路：落盘媒体 → 记录槽位/映射 → 存库 → 命令 → 等待 → 提问 → 审批 → 唤醒
  const handleInboundC2CMessage = async (event: QQC2CMessageCreateEvent): Promise<void> => {
    if (isDisposed || !event || event.author?.bot === true) return;

    const openid = typeof event.author?.user_openid === 'string' ? event.author.user_openid.trim() : '';
    if (!isValidOpenid(openid)) {
      logger.debug?.('[Plugin] 忽略缺少有效 user_openid 的入站事件');
      return;
    }

    const peer = openidToPeer(openid);
    const receivedAt = parseIsoTimeMs(event.timestamp);
    const msgId = typeof event.id === 'string' ? event.id.trim() : '';
    const refIdx = extractMessageRefIdx(event) ?? null;
    const refMsgIdx = extractQuotedRefIdx(event) ?? null;
    const senderName =
      (typeof event.author?.username === 'string' && event.author.username.trim()) || '';

    // 注册 peer <-> openid 双向映射，并登记最新入站 msg_id 被动回复槽位
    try {
      db.upsertPeerOpenid(peer, openid, senderName || undefined);
    } catch (err) {
      logger.warn?.('[Plugin] 写入 peer_openid_map 失败:', err);
    }
    outboundBridge.registerPeerOpenid(peer, openid);

    if (msgId) {
      try {
        db.recordInboundReplySlot(msgId, peer, openid, receivedAt);
      } catch (err) {
        logger.warn?.('[Plugin] 登记 inbound_reply_slots 失败:', err);
      }
    }

    // 并发下载入站附件（裸 GET 无鉴权头）并识别命中表情库
    const descriptors = await resolveInboundAttachments(event, peer, mediaManager, logger);
    for (const desc of descriptors) {
      if ((desc.kind === 'image' || desc.kind === 'sticker') && desc.local?.path) {
        const md5 = desc.local.md5 ?? computeFileMd5(desc.local.path) ?? undefined;
        if (md5) {
          if (!desc.local.md5) desc.local.md5 = md5;
          const matchedFace = db.getFaceByMd5(md5);
          if (matchedFace && matchedFace.enabled && !matchedFace.deleted_at) {
            desc.face = {
              id: matchedFace.id,
              ...(matchedFace.mood ? { mood: matchedFace.mood } : {}),
              ...(matchedFace.tags && matchedFace.tags.length > 0 ? { tags: matchedFace.tags } : {}),
            };
          }
        }
      }
    }

    // message_type=102 合并转发内嵌图片限量裸 GET 落盘 + rkey 凭证彻底脱敏
    let forwardImages: string[] | undefined;
    let sanitizeForwardContent: ((raw: string) => string) | undefined;
    if (event.message_type === QQ_INBOUND_MSG_TYPE_FORWARD && typeof event.content === 'string') {
      const resolvedFwd = await resolveEmbeddedForwardImages(
        event.content,
        peer,
        mediaManager,
        10,
        logger
      );
      if (resolvedFwd.localPaths.length > 0) {
        forwardImages = resolvedFwd.localPaths;
      }
      sanitizeForwardContent = (raw: string) =>
        sanitizeForwardContentUrls(raw, resolvedFwd.replacements);
    }

    const decision = await shouldWakeup(event, {
      descriptors,
      ...(forwardImages ? { forwardImages } : {}),
      ...(sanitizeForwardContent ? { sanitizeForwardContent } : {}),
      botName: gateway.getStatus().botName,
      getMessageByRefIdx: (idx) => toQuotedRecord(db.getMessageByRefIdx(idx)),
      getFaceByMd5: (md5) => db.getFaceByMd5(md5),
    });

    if (!decision.wakeup || !decision.payload) {
      logger.debug?.(`[Plugin] 忽略空入站事件 (peer: ${peer}, msg_id: ${msgId || '?'})`);
      return;
    }

    const content = decision.payload.content;
    const description = describeInboundAttachments(event, descriptors);
    const mediaFields = toMessageMediaFields(description);

    let savedShortId: string | undefined;
    if (msgId) {
      const inboundRecord: MessageRecord = {
        msg_id: msgId,
        peer,
        user_id: openid,
        sender_name: senderName,
        time: receivedAt,
        type: mediaFields.type,
        content,
        raw: JSON.stringify(event),
        file_id: mediaFields.file_id,
        local_path: mediaFields.local_path,
        fingerprint: mediaFields.fingerprint,
        recalled: 0,
        self: 0,
        reply_to: refMsgIdx,
        ref_idx: refIdx,
        source: 'qq',
        attachments: serializeAttachments(description.attachments),
      };
      try {
        db.saveMessage(inboundRecord);
        const resolvedShortId =
          (typeof inboundRecord.short_id === 'string' && inboundRecord.short_id.trim() !== ''
            ? inboundRecord.short_id.trim()
            : undefined) ?? (db.resolveShortId(peer, msgId) ?? undefined);
        if (resolvedShortId) {
          savedShortId = resolvedShortId;
        }
      } catch (err) {
        logger.error?.('[Plugin] 入站消息落库失败:', err);
      }
    }

    if (savedShortId) {
      decision.payload.short_id = savedShortId;
    }

    // 拦截 1：斜杠命令
    if (isSlashCommand(content)) {
      try {
        const agent = await sessionManager.getOrCreateAgent(peer);
        const result = await handleSlashCommand(content, {
          userId: openid,
          session: (agent as any).session,
          agent,
          ctx,
          sessionManager,
        });
        const replyText = result.reply || result.error;
        if (replyText) {
          await outboundBridge.sendTextReply(peer, replyText, {
            openid,
            ...(msgId ? { msgId } : {}),
          });
        }
        if (typeof result.followUp === 'function') {
          void (async () => {
            try {
              const followUpText = await result.followUp!();
              if (followUpText) {
                await outboundBridge.sendTextReply(peer, followUpText, {
                  openid,
                  ...(msgId ? { msgId } : {}),
                });
              }
            } catch (followErr) {
              logger.error?.('[Plugin] 执行斜杠命令 followUp 异常:', followErr);
            }
          })();
        }
      } catch (cmdErr: any) {
        logger.error?.('[Plugin] 执行斜杠命令异常:', cmdErr);
        await outboundBridge
          .sendTextReply(peer, `执行指令失败：${cmdErr?.message || String(cmdErr)}`, {
            openid,
            ...(msgId ? { msgId } : {}),
          })
          .catch(() => {});
      }
      return;
    }

    const inboundContext = {
      ...(msgId ? { msg_id: msgId } : {}),
      ...(refIdx ? { ref_idx: refIdx } : {}),
      openid,
      from_user: openid,
      trigger: decision.trigger,
    };

    // 拦截 2：wait_for_user_messages 单轮等待收集门控
    if (waitRegistry.isWaiting(peer)) {
      const rawQuotedShortId =
        decision.payload.quoted?.short_id ??
        (refMsgIdx ? db.getMessageByRefIdx(refMsgIdx)?.short_id ?? undefined : undefined);
      const quotedShortId =
        typeof rawQuotedShortId === 'string' && rawQuotedShortId.trim() !== ''
          ? rawQuotedShortId.trim()
          : undefined;
      const deliveredMsg: WaitCollectedMessage = {
        msg_id: savedShortId || '',
        content,
        time: receivedAt,
        ...(quotedShortId ? { reply_to: quotedShortId } : {}),
        ...(decision.payload.quoted ? { quoted: decision.payload.quoted } : {}),
      };
      if (waitRegistry.tryDeliver(peer, deliveredMsg) && msgId) {
        outboundBridge.trackInboundContext(peer, inboundContext);
        outboundBridge.updateActiveTurnContext(peer, inboundContext);
      }
      return;
    }

    // 拦截 3：交互式提问回复
    try {
      if (questionProvider.handleInboundReply(peer, content)) {
        logger.info?.(`[Plugin] 提问回复已消费 (peer: ${peer})`);
        return;
      }
    } catch (qErr) {
      logger.warn?.('[Plugin] 提问回复拦截异常 (忽略继续流转):', qErr);
    }

    // 拦截 4：工具审批决策回复 (y/n)
    if (approvalResponder.handleInboundReply(peer, content)) {
      logger.info?.(`[Plugin] 审批决策已消费 (peer: ${peer})`);
      return;
    }

    // 拦截 5：正常唤醒 Agent（先更新入站上下文与输入中状态，再入队唤醒）
    outboundBridge.trackInboundContext(peer, inboundContext);
    if (msgId) {
      void outboundBridge.sendInputNotifyIfEnabled(peer, { openid, msgId }).catch(() => {});
    }

    try {
      await sessionManager.dispatchWakeup(decision.payload, {
        onMessageCreated: (userMsg) => {
          if (userMsg?.id) {
            outboundBridge.trackPendingMessage(userMsg.id, peer, inboundContext);
          }
        },
      });
    } catch (err) {
      logger.error?.('[Plugin] 唤醒下发异常:', err);
    }
  };

  const unregC2CMessage = gateway.onC2CMessage((event) => handleInboundC2CMessage(event));

  // 10. 启动生命周期对齐
  const startPlugin = async () => {
    logger.info?.(`${PLUGIN_NAME} 插件已加载并就绪`);
    try {
      const initialCreds = await resolveCredentials(ctx, { dshHome });
      if (!initialCreds.credential?.appId?.trim() || !initialCreds.credential?.appSecret?.trim()) {
        logger.warn?.(
          '[Plugin] 未配置 QQ Bot 凭据 (QQ_BOT_APP_ID / QQ_BOT_SECRET)，Gateway 暂处于待机状态；请在 WebUI 设置卡片或凭据文件中配置后自动连接'
        );
      }
      await syncGatewayCredentials();
    } catch (err) {
      logger.warn?.('[Plugin] 启动时连接 QQ Gateway 告警:', err);
    }
  };

  const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
  const bootTask = () => {
    try {
      healProfileConfigFile(dshHome, undefined, logger);
    } catch {}
    void startPlugin().catch(() => {});
  };
  if (appReady && typeof appReady.onReady === 'function') {
    appReady.onReady(bootTask);
  } else {
    bootTask();
  }

  const onProcessExit = () => {
    gateway.stop();
  };
  process.once('SIGINT', onProcessExit);
  process.once('SIGTERM', onProcessExit);
  process.once('beforeExit', onProcessExit);

  const disposePlugin = async () => {
    if (isDisposed) return;
    isDisposed = true;
    logger.info?.(`${PLUGIN_NAME} 插件正在卸载`);

    process.removeListener('SIGINT', onProcessExit);
    process.removeListener('SIGTERM', onProcessExit);
    process.removeListener('beforeExit', onProcessExit);

    const safeCall = (fn: unknown) => {
      if (typeof fn === 'function') {
        try {
          fn();
        } catch {}
      }
    };

    safeCall(unregisterConfigRoute);
    safeCall(unregisterFacesRoutes);
    safeCall(unregisterSlangRoutes);
    safeCall(unregVolatile);
    safeCall(unregSettingsDoc);
    safeCall(unregCredUpdate);
    safeCall(unregC2CMessage);
    safeCall(unregisterApproval);
    safeCall(unregisterQuestionChannel);
    safeCall(unregisterTurnInitiator);

    stopCleanupTask();
    waitRegistry.clear();
    memoryService.dispose();
    slangService.dispose();
    taskScheduler.dispose();
    safeCall(stopOutboundBridge);
    try {
      outboundBridge.dispose();
      sessionManager.setOutboundBridge?.(null as any);
    } catch {}
    turnInitiatorTracker.clear();
    if (snapshotManager) {
      snapshotManager.dispose();
      snapshotManager = null;
    }

    gateway.stop();
    await sessionManager.dispose().catch(() => {});
    db.close();
  };

  if (typeof (ctx as any).effect === 'function') {
    (ctx as any).effect(() => () => disposePlugin());
  }
  (ctx as any).on?.('dispose', () => disposePlugin());
}
