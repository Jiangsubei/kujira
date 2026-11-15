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
  PROACTIVE_CHECK_INTERVAL_MS,
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
import type { AttachmentDescriptor } from './attachment/types.js';
import { MessageDatabase } from './storage/database.js';
import { MediaStorageManager, startMediaCleanupTask } from './storage/media.js';
import {
  KujiraGatewayClient,
  MessageWaitRegistry,
  type WaitCollectedMessage,
} from './gateway/server.js';
import {
  descriptorsFromForwardEntries,
  resolveInboundAttachments,
  resolveEmbeddedForwardMedia,
} from './gateway/inbound-media.js';
import {
  shouldWakeup,
  extractMessageRefIdx,
  extractQuotedRefIdx,
  isForwardLikeContent,
  isPermanentRefIdx,
  msgElementsRawContents,
  type QuotedMessageRecord,
} from './gateway/wakeup.js';
import { SessionManager } from './gateway/session.js';
import { SystemEventHub } from './gateway/system-event-hub.js';
import { ProactiveManager, shouldPoolInbound } from './gateway/proactive.js';
import { extractRecentTurnsFromRecords } from './gateway/proactive/momentum.js';
import type { SystemWakeupEvent } from './types/system-event.js';
import {
  describeInboundAttachments,
  toMessageMediaFields,
} from './attachment/classify.js';
import { serializeAttachments } from './attachment/store.js';
import { localizeInboundAttachments } from './attachment/localize.js';
import { renderAttachment, renderAttachments } from './attachment/render.js';
import { mapWithConcurrency } from './utils/concurrency.js';
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
  // turn/end 聚合 flush 的挂载点：section 4.1 创建管理器后回填，避免顺序耦合
  let flushAggregatedOnTurnEnd: ((peer: string) => void) | null = null;
  const unregisterTurnInitiator = (ctx as any).on?.('session/event', (session: any, event: any) => {
    try {
      turnInitiatorTracker.observe(session, event);
    } catch (err) {
      logger.warn?.('[Plugin] 本轮唤醒者追踪器处理 session/event 失败:', err);
    }
    try {
      if (event?.type === 'turn/end') {
        const sessionId = session?.id === undefined || session?.id === null ? '' : String(session.id);
        if (sessionId && sessionManager.isKujiraSession(sessionId)) {
          const peer = sessionManager.sessionIdToPeer(sessionId);
          if (peer) flushAggregatedOnTurnEnd?.(peer);
        }
      }
    } catch (err) {
      logger.warn?.('[Plugin] turn/end 聚合 flush 调度失败:', err);
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

  const systemEventHub = new SystemEventHub({
    sessionManager,
    logger,
    // 聚合轮次的审批发起人：从身份映射表解析真实 openid（解析不到则 Fail-Closed）
    resolveOpenid: (peer: string) => {
      try {
        return db.getOpenidByPeer(peer) ?? undefined;
      } catch {
        return undefined;
      }
    },
  });
  sessionManager.setSystemEventHub(systemEventHub);

  // 4.1 单聊主动能力：消息聚合回复与冷场主动搭话（巡检固定 60s，两个开关各自独立门控）
  const proactiveManager = new ProactiveManager();
  // 等待用户输入的判活回调：由下方 questionProvider / approvalResponder 装配后回填。
  // 巡检时才求值，故此处先用闭包占位，避免与 section 7 的创建顺序耦合。
  let isAwaitingUserInput: (peer: string) => boolean = () => false;
  const dispatchProactiveEvent = async (event: SystemWakeupEvent): Promise<void> => {
    // 冷场搭话必须拿得到有效被动锚点才能发信；无锚点时直接跳过，绝不降级为纯主动消息
    if (event.kind === 'idle_reply') {
      const anchor = outboundBridge.resolvePassiveMsgId(event.peer);
      if (!anchor) {
        logger.debug?.(`[Plugin] 冷场搭话跳过：无可用被动锚点 (peer: ${event.peer})`);
        return;
      }
    }
    await systemEventHub.dispatchSystemEvent(event);
  };
  const buildProactiveOptions = () => ({
    config: currentConfig(),
    dispatch: dispatchProactiveEvent,
    // 等待提问答复或审批决策期间跳过投递，池保留到下一轮
    isAwaitingUserInput: (peer: string) => isAwaitingUserInput(peer),
    // Agent 正在运行一轮时绝不打断，由 turn/end flush 投递
    isAgentRunning: (peer: string) => sessionManager.isAgentRunning(peer),
    // 活跃会话门控：口径与 `/状态` 命令一致
    hasActiveSession: (peer: string) => sessionManager.hasActiveSession(peer),
    // 冷场搭话 / 聚合重试时：曾有互动但会话已不在 → 允许新建会话
    ensureSession: (peer: string) => sessionManager.ensureSession(peer),
    // 沉默起点以库中最新入站消息为准，重启后依然准确
    lastHumanMessageAt: (peer: string) => {
      try {
        const slot = db.getLatestValidInboundSlot(peer);
        return slot?.received_at ?? null;
      } catch {
        return null;
      }
    },
    // 上一轮 Bot 出站回复时刻（微观时延计算）
    lastBotOutboundAt: (peer: string) => {
      try {
        const history = db.readHistory(peer, { limit: 15, order: 'desc' });
        const botMsg = history.messages.find((m) => m.self === true);
        return botMsg?.time ?? null;
      } catch {
        return null;
      }
    },
    // 最近已完成交互轮次摘要（宏观历史动量计算）
    recentTurns: (peer: string) => {
      try {
        const history = db.readHistory(peer, { limit: 30, order: 'desc' });
        return extractRecentTurnsFromRecords(history.messages).recentTurns;
      } catch {
        return [];
      }
    },
    // 仅「曾经真实互动过」的 peer（peer_openid_map 已登记）才参与冷场搭话扫描
    knownPeers: () => {
      try {
        return db.getAllPeers();
      } catch {
        return [];
      }
    },
  });
  proactiveManager.startChecker(buildProactiveOptions, PROACTIVE_CHECK_INTERVAL_MS);
  flushAggregatedOnTurnEnd = (peer: string) => {
    void proactiveManager
      .flushPendingMessages(peer, { ...buildProactiveOptions(), now: Date.now() })
      .catch((err) => logger.warn?.('[Plugin] turn/end 聚合 flush 失败:', err));
  };

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
  provideService(ctx, 'kujira-proactive', proactiveManager);

  (ctx as any).inject?.(['agentPresets'], async (presetCtx: Context) => {
    const agentPresetsSvc = (presetCtx as any).agentPresets;
    if (agentPresetsSvc && typeof agentPresetsSvc.register === 'function') {
      try {
        const presetsList = await agentPresetsSvc.list?.();
        const exists = Array.isArray(presetsList) && presetsList.some((p: any) => p.id === QQ_PRESET_ID);
        if (!exists) {
          await agentPresetsSvc.register(getRuntimePresetDefinition());
        }
        // 核心装配：向 Cordis 根上下文广播 settings/document-updated 事件，
        // 触发 dsh-api-remotes 向前端客户端推送变更，通知 dsh-client-ui-agent-preset 重新执行 list 并刷新 Store，
        // 从而实现安装插件后无需重启 DSH 即可即时呈现 Kujira 预设。
        const targetCtx = (presetCtx as any).root ?? presetCtx;
        targetCtx.emit?.('settings/document-updated', 'agent-preset-registry');
        setTimeout(() => {
          targetCtx.emit?.('settings/document-updated', 'agent-preset-registry');
        }, 50);
      } catch (err: any) {
        logger.debug?.(`[Plugin] 动态注册/刷新 ${QQ_PRESET_ID} 预设异常:`, err?.message);
      }
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

  // 回填「等待用户输入」判活：提问或审批任一挂起即视为等待中，主动能力暂停计时。
  isAwaitingUserInput = (peer: string): boolean => {
    try {
      return questionProvider.isWaiting(peer) || approvalResponder.isWaiting(peer);
    } catch {
      // 判活异常一律视为未等待，绝不因巡检探针异常而永久冻结计时
      return false;
    }
  };

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
    // 直发与引用消息 `msg_elements[].attachments` 共用同一落盘管线（`attachment/localize.ts`）
    const descriptors = await resolveInboundAttachments(
      event,
      peer,
      mediaManager,
      logger,
      (md5) => db.getFaceByMd5(md5)
    );

    // message_type=102 合并转发全量内嵌媒体裸 GET 落盘 + 结构化排版 + 本地表情库匹配
    let formatForwardContent: ((raw: string) => string) | undefined;
    let forwardDescriptors: AttachmentDescriptor[] = [];
    if (event.message_type === QQ_INBOUND_MSG_TYPE_FORWARD && typeof event.content === 'string') {
      const resolvedFwd = await resolveEmbeddedForwardMedia(
        event.content,
        peer,
        mediaManager,
        {
          logger,
          getFaceByMd5: (md5) => db.getFaceByMd5(md5),
        }
      );
      formatForwardContent = () => resolvedFwd.formattedContent;
      forwardDescriptors = descriptorsFromForwardEntries(resolvedFwd.entries);
    }

    // 引用消息：先查本地库；仅在未命中时落盘引用附件并生成本地化文案
    const quotedRefIdx = extractQuotedRefIdx(event);
    const prefetchedQuoted = isPermanentRefIdx(quotedRefIdx)
      ? toQuotedRecord(db.getMessageByRefIdx(quotedRefIdx))
      : null;
    let quotedContentReplacements: Map<string, string> | undefined;
    let quotedElementMedia: Map<number, string> | undefined;
    if (!prefetchedQuoted) {
      // (1) 合并转发式引用片段：解析文本内嵌 `[附件k] ... URL:` 并本地化
      const quotedParts = msgElementsRawContents(event).filter((raw) => isForwardLikeContent(raw));
      if (quotedParts.length > 0) {
        const resolvedParts = await mapWithConcurrency(quotedParts, 4, (part) =>
          resolveEmbeddedForwardMedia(part, peer, mediaManager, {
            logger,
            getFaceByMd5: (md5) => db.getFaceByMd5(md5),
          })
        );
        const merged = new Map<string, string>();
        for (const resolved of resolvedParts) {
          for (const [url, placeholder] of resolved.replacements) {
            merged.set(url, placeholder);
          }
        }
        if (merged.size > 0) {
          quotedContentReplacements = merged;
        }
      }

      // (2) 结构化引用附件：实测引用图片/视频时官方直接下发 msg_elements[].attachments[]
      const elements = Array.isArray(event.msg_elements) ? event.msg_elements : [];
      const mediaElements = elements
        .map((el, index) => ({
          index,
          attachments: Array.isArray(el.attachments)
            ? el.attachments.filter((att) => Boolean(att) && typeof att === 'object')
            : [],
        }))
        .filter((entry) => entry.attachments.length > 0);

      if (mediaElements.length > 0) {
        const localized = await mapWithConcurrency(mediaElements, 4, (entry) =>
          localizeInboundAttachments(entry.attachments, {
            peer,
            mediaManager,
            logger,
            getFaceByMd5: (md5) => db.getFaceByMd5(md5),
          })
        );
        const mediaTexts = new Map<number, string>();
        mediaElements.forEach((entry, i) => {
          const text = localized[i]!
            .map((descriptor) => renderAttachment(descriptor))
            .filter((value): value is string => Boolean(value))
            .join(' ');
          if (text) mediaTexts.set(entry.index, text);
        });
        if (mediaTexts.size > 0) {
          quotedElementMedia = mediaTexts;
        }
      }
    }

    const decision = await shouldWakeup(event, {
      descriptors,
      prefetchedQuoted,
      ...(quotedContentReplacements ? { quotedContentReplacements } : {}),
      ...(quotedElementMedia ? { quotedElementMedia } : {}),
      ...(formatForwardContent ? { formatForwardContent } : {}),
      botName: gateway.getStatus().botName,
      getMessageByRefIdx: (idx) => toQuotedRecord(db.getMessageByRefIdx(idx)),
      getFaceByMd5: (md5) => db.getFaceByMd5(md5),
    });

    if (!decision.wakeup || !decision.payload) {
      logger.debug?.(`[Plugin] 忽略空入站事件 (peer: ${peer}, msg_id: ${msgId || '?'})`);
      return;
    }

    const content = decision.payload.content;
    const description = describeInboundAttachments(event, [
      ...descriptors,
      ...forwardDescriptors,
    ]);
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

    // 拦截 5：消息聚合回复门控
    // 聚合开启时，普通消息默认入内存池等待轮次边界投递；
    // 唯一例外是「一轮正在运行 + new_message_behavior = steer」——即时插话，不入池。
    // 提问/审批答案、wait_for_user_messages 收集都在此之前被消费，天然不入池。
    const activeConfig = currentConfig();
    if (activeConfig.aggregation_enabled) {
      outboundBridge.trackInboundContext(peer, inboundContext);

      const behavior: 'steer' | 'queue' =
        activeConfig.new_message_behavior === 'queue' ? 'queue' : 'steer';
      const agentRunning = sessionManager.isAgentRunning(peer);
      const pooled = shouldPoolInbound({
        aggregationEnabled: true,
        behavior,
        isAgentRunning: agentRunning,
      });

      if (!pooled) {
        // 插话：消息原样即时给到运行中的 Agent，不收集、不等待周期
        try {
          await sessionManager.dispatchWakeup(decision.payload, {
            onMessageCreated: (userMsg) => {
              if (userMsg?.id) {
                outboundBridge.trackPendingMessage(userMsg.id, peer, inboundContext);
              }
            },
          });
        } catch (err) {
          logger.error?.('[Plugin] 聚合期间即时插话唤醒失败:', err);
        }
        return;
      }

      // 附件占位符单独成行；正文中的同一占位符剔除，避免重复展示
      const renderedAttachments = renderAttachments(descriptors);
      let aggregatedText = content;
      for (const attachment of renderedAttachments) {
        aggregatedText = aggregatedText.split(attachment).join('');
      }
      aggregatedText = aggregatedText
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      proactiveManager.recordMessage(
        peer,
        {
          ...(savedShortId ? { short_id: savedShortId } : {}),
          content: aggregatedText,
          time: receivedAt,
          ...(decision.payload.quoted ? { quoted: decision.payload.quoted } : {}),
          ...(renderedAttachments.length > 0 ? { attachments: renderedAttachments } : {}),
        },
        openid,
        {
          config: activeConfig,
          isAgentRunning: agentRunning,
          now: receivedAt,
        }
      );
      logger.debug?.(
        `[Plugin] 消息已入聚合池 (peer: ${peer}, 运行中: ${agentRunning}, 模式: ${behavior})`
      );
      return;
    }

    // 拦截 6：正常唤醒 Agent（先更新入站上下文与输入中状态，再入队唤醒）
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
    proactiveManager.dispose();
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
