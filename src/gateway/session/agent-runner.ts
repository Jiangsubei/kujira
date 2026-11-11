/**
 * kujira: Agent 运行时生命周期与执行调度模块
 * 负责 Agent 创建与恢复、会话独占锁与 Web 只读看门狗、以及入站唤醒 (dispatchWakeup) 的消息排队下发。
 */

import { promises as fsp } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { QQ_PRESET_ID } from '../../constants/preset.js';
import { DEFAULT_NEW_MESSAGE_BEHAVIOR, PLUGIN_NAME } from '../../constants/index.js';
import type { WakeupPayload } from '../../types/index.js';
import { TurnInitiatorTracker, resolveWakeupInitiator } from '../../approval/turn-initiator.js';
import {
  RemoteError,
  SessionAlreadyOwnedError,
  type OutboundBridgeLike,
  type SessionManagerOptions,
} from './types.js';
import {
  parseSessionId,
  buildSessionId,
  generateSessionHash,
  formatSessionTitle,
  extractNameFromSessionTitle,
  formatWakeupPrompt,
  isKujiraSession,
} from './id-resolver.js';
import { formatSystemEventPrompt } from '../system-event-hub.js';
import type { SessionWorkspaceManager } from './workspace.js';
import type { SessionPersistenceManager } from './persistence.js';
import type { SessionModelSelector } from './model-selector.js';

export function safeGetService(ctx: any, name: string): any {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const val = ctx.get(name);
      if (val !== undefined) return val;
    }
  } catch {}
  try {
    if (ctx.root && typeof ctx.root.get === 'function') {
      const rootVal = ctx.root.get(name);
      if (rootVal !== undefined) return rootVal;
    }
  } catch {}
  return undefined;
}

export function parsePeerTarget(peer: string): { type: 'user'; id: string } {
  if (peer.startsWith('user_')) {
    return { type: 'user', id: peer.slice(5) };
  }
  if (peer.startsWith('user:')) {
    return { type: 'user', id: peer.slice(5) };
  }
  if (peer.startsWith('kujira-user-')) {
    const parsed = parseSessionId(peer);
    if (parsed) {
      return { type: 'user', id: parsed.id };
    }
    const stripped = peer.slice(12);
    return { type: 'user', id: stripped.split('-')[0] || stripped };
  }
  return { type: 'user', id: peer };
}

/**
 * 系统触发器可能写入 `payload.from_name` 的伪发送者名称。
 * 这些名称绝不能进入会话标题或昵称缓存，否则单聊会话会被永久改名成系统身份。
 */
const SYSTEM_SENDER_NAMES = new Set([
  '系统定时任务',
  '系统主动唤醒',
  '协同 Agent',
  '系统协作总线',
  '内部通讯',
]);

/**
 * 只有真实单聊入站触发源的 from_name 才能代表真实 QQ 发送者。
 */
const REAL_SENDER_TRIGGERS = new Set(['direct', 'quote']);

function isUserPeer(peer: string): boolean {
  return peer.startsWith('user_') || peer.startsWith('kujira-user-');
}

/** 判断名称是否为系统伪发送者名称（用于标题与昵称缓存的历史污染清理） */
export function isSystemSenderName(name: string | undefined): boolean {
  return typeof name === 'string' && SYSTEM_SENDER_NAMES.has(name.trim());
}

export interface AgentRunnerDelegate {
  peerToSessionId(peer: string): string;
  sessionIdToPeer(sessionId: string): string;
  onSessionReassigned?(peer: string, newSessionId: string): void;
  onClearPendingCleared?(peer: string, sessionId: string): void;
  isSessionDeleted?(sessionId: string): boolean;
}

export class SessionAgentRunner {
  /** 单聊昵称持久化键（跨重启保留，避免标题退化为纯 hash） */
  private static readonly PEER_NAMES_KEY = 'kujira_peer_names';

  private activeHandles = new Map<string, AgentHandle>();
  private busySessions = new Set<string>();
  private peerNames = new Map<string, string>();
  private persistedSessions = new Set<string>();
  private pendingFirstTurnSessions = new Set<string>();
  private outboundBridge?: OutboundBridgeLike;
  /** 审批「本轮唤醒者」追踪器（由插件根 Context 注入并订阅 session/event） */
  private turnInitiatorTracker?: TurnInitiatorTracker;

  constructor(
    private readonly ctx: Context,
    private readonly workspace: SessionWorkspaceManager,
    private readonly persistence: SessionPersistenceManager,
    private readonly modelSelector: SessionModelSelector,
    private readonly delegate: AgentRunnerDelegate,
    private readonly options?: SessionManagerOptions
  ) {
    this.loadPeerNames();
  }

  public getConfig(): any {
    const getter: any = this.options?.configGetter || safeGetService(this.ctx, 'kujira-bridge-config');
    return (typeof getter === 'function' ? getter() : getter) || (this.ctx as any).config || (this.ctx.root as any)?.config || {};
  }

  private resolveNewMessageBehavior(): 'steer' | 'queue' {
    const config = this.getConfig();
    return config?.new_message_behavior || DEFAULT_NEW_MESSAGE_BEHAVIOR;
  }

  public setOutboundBridge(bridge: OutboundBridgeLike): void {
    this.outboundBridge = bridge;
  }

  public getOutboundBridge(): OutboundBridgeLike | undefined {
    return this.outboundBridge;
  }

  public setTurnInitiatorTracker(tracker: TurnInitiatorTracker | undefined): void {
    this.turnInitiatorTracker = tracker;
  }

  public getTurnInitiatorTracker(): TurnInitiatorTracker | undefined {
    return this.turnInitiatorTracker;
  }

  public getActiveTurn(peer: string): number | undefined {
    return (this.outboundBridge as any)?.getActiveTurn?.(peer);
  }

  public isPendingFirstTurn(sessionId: string): boolean {
    if (this.persistedSessions.has(sessionId)) {
      this.pendingFirstTurnSessions.delete(sessionId);
      return false;
    }
    return this.pendingFirstTurnSessions.has(sessionId);
  }

  public markPendingFirstTurn(sessionId: string): void {
    if (!this.persistedSessions.has(sessionId)) {
      this.pendingFirstTurnSessions.add(sessionId);
    }
  }

  public clearPendingFirstTurn(sessionId: string): void {
    this.pendingFirstTurnSessions.delete(sessionId);
  }

  public markSessionPersistedIfPresent(sessionId: string): boolean {
    if (this.persistence.isSessionPhysicallyPresent(sessionId)) {
      this.persistedSessions.add(sessionId);
      this.pendingFirstTurnSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  public isSessionZombie(sessionId: string): boolean {
    if (this.isPendingFirstTurn(sessionId)) {
      return false;
    }
    if (this.markSessionPersistedIfPresent(sessionId)) {
      return false;
    }
    return this.persistedSessions.has(sessionId);
  }

  public markSessionPersisted(sessionId: string): void {
    this.persistedSessions.add(sessionId);
  }

  public setPeerName(peer: string, name: string): void {
    if (name && typeof name === 'string' && name.trim()) {
      const trimmed = name.trim();
      if (isUserPeer(peer) && isSystemSenderName(trimmed)) {
        return;
      }
      this.peerNames.set(peer, trimmed);
      this.persistPeerNames();
    }
  }

  public getPeerName(peer: string): string | undefined {
    return this.peerNames.get(peer);
  }

  /**
   * 确保 peer 显示名称已解析：
   * 1. 优先返回内存/KV 持久化缓存；
   * 2. 回退从本地历史入站消息中提取最近非系统发送者名称；
   * 3. 若 `kujira-gateway` 提供可选的自定义备注/昵称查询接口，带超时尝试获取。
   */
  public async resolvePeerName(peer: string, timeoutMs = 3000): Promise<string | undefined> {
    const cached = this.getPeerName(peer);
    if (cached) return cached;

    const fromDb = this.persistence.getLatestInboundSenderName(peer);
    if (fromDb && !isSystemSenderName(fromDb)) {
      this.setPeerName(peer, fromDb);
      return fromDb;
    }

    const gateway: any =
      safeGetService(this.ctx, 'kujira-gateway') || (this.ctx as any)['kujira-gateway'];
    if (!gateway) return undefined;

    const { id } = parsePeerTarget(peer);
    if (!id) return undefined;

    try {
      const getter =
        typeof gateway.getPeerName === 'function'
          ? gateway.getPeerName(peer)
          : typeof gateway.getRemark === 'function'
            ? gateway.getRemark(peer)
            : undefined;
      if (!getter || typeof getter.then !== 'function') {
        if (typeof getter === 'string' && getter.trim() && !isSystemSenderName(getter)) {
          this.setPeerName(peer, getter.trim());
          return getter.trim();
        }
        return undefined;
      }

      const res: any = await Promise.race([
        getter,
        new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);
      const rawName =
        typeof res === 'string'
          ? res
          : res?.name || res?.remark || res?.nickname || '';
      const name = String(rawName).trim();
      if (!name || isSystemSenderName(name)) return undefined;

      this.setPeerName(peer, name);
      return name;
    } catch {
      return undefined;
    }
  }

  private loadPeerNames(): void {
    try {
      const raw = this.persistence.getPluginConfig(SessionAgentRunner.PEER_NAMES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      let dropped = false;
      for (const [peer, name] of Object.entries(parsed)) {
        if (typeof peer === 'string' && peer && typeof name === 'string' && name.trim()) {
          const trimmed = name.trim();
          if (isUserPeer(peer) && isSystemSenderName(trimmed)) {
            dropped = true;
            continue;
          }
          this.peerNames.set(peer, trimmed);
        }
      }
      if (dropped) this.persistPeerNames();
    } catch {
      // 持久化数据损坏时忽略，按无缓存继续
    }
  }

  private persistPeerNames(): void {
    try {
      this.persistence.setPluginConfig(
        SessionAgentRunner.PEER_NAMES_KEY,
        JSON.stringify(Object.fromEntries(this.peerNames))
      );
    } catch {}
  }

  private getSessionTitle(session: any, sessionId: string): string | undefined {
    const titleSvc = safeGetService(this.ctx, 'sessionTitle');
    try {
      const snapshot = titleSvc?.get?.(session);
      if (typeof snapshot?.title === 'string') return snapshot.title;
    } catch {}

    const sessionsSvc = safeGetService(this.ctx, 'sessions');
    try {
      const s = sessionsSvc?.get?.(sessionId);
      return typeof s?.title === 'string' ? s.title : undefined;
    } catch {
      return undefined;
    }
  }

  public hasActiveHandle(sessionId: string): boolean {
    return this.activeHandles.has(sessionId);
  }

  public getActiveHandle(sessionId: string): AgentHandle | undefined {
    return this.activeHandles.get(sessionId);
  }

  public getActiveHandleKeys(): IterableIterator<string> {
    return this.activeHandles.keys();
  }

  public async releaseActiveHandle(sessionId: string): Promise<void> {
    this.clearPendingFirstTurn(sessionId);
    this.persistedSessions.delete(sessionId);
    const handle = this.activeHandles.get(sessionId);
    if (handle) {
      this.activeHandles.delete(sessionId);
      if (typeof handle.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {});
      }
    }
  }

  public markSessionBusy(sessionId: string, busy: boolean): void {
    if (busy) {
      this.busySessions.add(sessionId);
    } else {
      this.busySessions.delete(sessionId);
    }
  }

  public isSessionBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  public getAgent(peerOrSessionId: string): Agent | undefined {
    const sessionId = isKujiraSession(peerOrSessionId)
      ? peerOrSessionId
      : this.delegate.peerToSessionId(peerOrSessionId);

    const fromHandle = this.activeHandles.get(sessionId);
    if (fromHandle?.agent) {
      return fromHandle.agent;
    }

    const agents = this.ctx.get?.('agents') || (this.ctx as any).agents;
    return agents?.get?.(sessionId as any);
  }

  /**
   * 拦截 Web UI 发送消息 (sessionController.prompt)：
   * 当 Kujira 会话处于活跃状态或独占持有时，强制拒绝并返回只读提示
   */
  public guardSessionController(sc?: any): void {
    let target = sc;
    if (!target) {
      try {
        target = (this.ctx as any).root?.sessionController || (this.ctx as any).sessionController;
      } catch {
        try {
          target = this.ctx.get?.('sessionController');
        } catch {}
      }
    }
    if (target && typeof target.prompt === 'function' && !(target.prompt as any).__dsh_kujira_guarded) {
      const originalPrompt = target.prompt.bind(target);
      const guardedPrompt = async (request: any) => {
        const sid = request?.sessionId;
        if (sid && (this.activeHandles.has(sid) || (isKujiraSession(sid) && this.isSessionBusy(sid)))) {
          throw new RemoteError(
            'session/agent-busy',
            '该会话当前正由 QQ Kujira 独占使用中，Web 端处于只读监视模式。请在 QQ 端发送消息。',
            { reason: 'EXCLUSIVE_QQ_SESSION', sessionId: sid }
          );
        }
        return originalPrompt(request);
      };
      (guardedPrompt as any).__dsh_kujira_guarded = true;
      (guardedPrompt as any).__originalPrompt = originalPrompt;
      target.prompt = guardedPrompt;
    }
  }

  public updateSessionTitle(session: any, peer: string, sessionId: string, name?: string): void {
    if (!session) return;
    if (name) {
      this.setPeerName(peer, name);
    }

    const existingTitle = this.getSessionTitle(session, sessionId);
    const existingName = extractNameFromSessionTitle(existingTitle, peer);
    const isPollutedName = isUserPeer(peer) && isSystemSenderName(existingName);

    const currentName =
      (name && !isSystemSenderName(name) ? name : undefined) ||
      this.getPeerName(peer) ||
      (isPollutedName ? undefined : existingName);

    // 已知标题且非系统污染但无法解析出昵称时，不降级覆盖已有标题
    if (!currentName && existingTitle && !isPollutedName) return;

    const title = formatSessionTitle(peer, sessionId, currentName);
    if (existingTitle === title) return;

    const sessionTitleSvc = this.ctx.get?.('sessionTitle') || (this.ctx as any).sessionTitle;
    if (sessionTitleSvc && typeof sessionTitleSvc.rename === 'function') {
      try {
        sessionTitleSvc.rename(session, title);
      } catch (err: any) {
        this.ctx.logger?.(PLUGIN_NAME)?.debug?.(
          `[SessionAgentRunner] 锁定会话标题 ${sessionId} 失败:`,
          err?.message
        );
      }
    }
  }

  public async getOrCreateAgent(peerOrSessionId: string): Promise<Agent> {
    let sessionId = this.delegate.peerToSessionId(peerOrSessionId);
    const peer = this.delegate.sessionIdToPeer(peerOrSessionId);

    if (this.persistence.isSessionPhysicallyPresent(sessionId)) {
      this.persistedSessions.add(sessionId);
      this.clearPendingFirstTurn(sessionId);
    }

    // 二次确认：若当前已持有该会话句柄或 live agent，但在运行时被归档或底层物理文件已被删除（僵尸句柄），销毁旧句柄并重新寻址
    const isCurrentZombie =
      this.persistence.isSessionArchived(sessionId) ||
      this.isSessionZombie(sessionId) ||
      Boolean(this.delegate.isSessionDeleted?.(sessionId));

    if (isCurrentZombie) {
      await this.releaseActiveHandle(sessionId);
      this.delegate.onSessionReassigned?.(peer, '');
      sessionId = this.delegate.peerToSessionId(peer);
    }

    const selectionRef = this.modelSelector.getOrCreateSelectionRef(sessionId);
    const agents = this.ctx.get?.('agents') || (this.ctx as any).agents;

    // 1. 若当前会话已由 Kujira 持有专属写句柄，检查其归档状态与物理有效性
    if (this.activeHandles.has(sessionId)) {
      const handle = this.activeHandles.get(sessionId)!;
      const isHandleValid =
        !this.persistence.isSessionArchived(sessionId) &&
        !this.isSessionZombie(sessionId) &&
        !this.delegate.isSessionDeleted?.(sessionId);

      if (isHandleValid) {
        (handle.agent as any).modelSelection = selectionRef;
        this.updateSessionTitle((handle.agent as any).session, peer, sessionId);
        return handle.agent;
      }
      this.activeHandles.delete(sessionId);
      if (typeof handle.dispose === 'function') {
        await Promise.resolve(handle.dispose()).catch(() => {});
      }
      this.delegate.onSessionReassigned?.(peer, '');
      sessionId = this.delegate.peerToSessionId(peer);
    }

    // 2. 内存中已存在该会话的 live agent（由 Web UI 会话控制器等其它 owner 创建/持有）：
    //    只复用同一 agent，让新消息经 agent.followup() 排队等待（同 peer 串行）
    const existingAgent = agents?.get?.(sessionId as any);
    if (existingAgent && !this.persistence.isSessionArchived(sessionId)) {
      const isExistingZombie =
        this.isSessionZombie(sessionId) ||
        Boolean(this.delegate.isSessionDeleted?.(sessionId));

      if (!isExistingZombie) {
        (existingAgent as any).modelSelection = selectionRef;
        this.updateSessionTitle((existingAgent as any).session, peer, sessionId);
        return existingAgent;
      }
      this.delegate.onSessionReassigned?.(peer, '');
      sessionId = this.delegate.peerToSessionId(peer);
    }

    let cwd = this.workspace.resolveCwd(sessionId);
    await fsp.mkdir(cwd, { recursive: true });

    const defaultSel = this.modelSelector.getDefaultModelSelection();
    const provider = selectionRef.current?.provider || defaultSel.provider;
    const model = selectionRef.current?.model || defaultSel.model;

    let effort: any = selectionRef.current?.reasoningEffort || defaultSel.reasoningEffort;
    if (effort === undefined) {
      effort = await this.modelSelector.resolveDefaultEffort(provider, model);
    }
    if (effort !== undefined) {
      selectionRef.current = {
        provider,
        model,
        reasoningEffort: effort,
      };
      let state = this.persistence.getSessionState(peer);
      if (!state) {
        state = {
          peer,
          current_session_id: sessionId,
          cleared_round: 0,
          cleared_version: 1,
          updated_at: Date.now(),
        };
      }
      if (!state.model_reasoning_effort) {
        state.model_provider = provider;
        state.model_name = model;
        state.model_reasoning_effort = effort;
        this.persistence.saveSessionState(state);
      }
    }

    const setupFn = (agentCtx: any) => {
      if (typeof agentCtx?.on === 'function') {
        installModelSelection(agentCtx, selectionRef);
      }
      const presets: any =
        agentCtx?.get?.('agentPresets') || (this.ctx as any).agentPresets;
      if (presets?.mount) {
        return presets
          .mount(agentCtx, QQ_PRESET_ID)
          .then(() => undefined)
          .catch((err: any) => {
            this.ctx.logger?.(PLUGIN_NAME)?.debug?.(
              `[SessionAgentRunner] mount preset ${QQ_PRESET_ID} failed, falling back:`,
              err?.message
            );
            const toolsProvider =
              (this.ctx as any).kujiraBridgeTools ||
              (this.ctx.root as any)?.kujiraBridgeTools;
            toolsProvider?.registerTools?.(agentCtx);
            return undefined;
          });
      }
      const toolsProvider =
        (this.ctx as any).kujiraBridgeTools ||
        (this.ctx.root as any)?.kujiraBridgeTools;
      toolsProvider?.registerTools?.(agentCtx);
      return undefined;
    };

    let handle: AgentHandle | undefined;
    let isSessionLocked = false;
    let isResumed = false;

    // 3. 若该会话此前已持久化在磁盘上，优先通过 agents.resume 恢复会话（带锁冲突退避重试）
    if (typeof agents?.resume === 'function') {
      const delays = this.options?.retryDelays || [300, 600, 900];
      const maxRetries = delays.length;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          handle = await agents.resume({
            resumeSessionId: sessionId as any,
            agentOptions: {
              provider,
              model,
              ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            },
            setup: setupFn,
          });
          isResumed = true;
          break;
        } catch (err: any) {
          const isOwnedError =
            err?.name === 'SessionAlreadyOwnedError' ||
            err?.constructor?.name === 'SessionAlreadyOwnedError' ||
            (typeof err?.message === 'string' &&
              (err.message.includes('SessionAlreadyOwnedError') ||
               err.message.includes('already has a live persistence owner') ||
               err.message.includes('while it is live') ||
               err.message.includes('already owned')));

          if (isOwnedError) {
            isSessionLocked = true;
            this.ctx.logger?.(PLUGIN_NAME)?.warn?.(
              `[SessionAgentRunner] 会话 ${sessionId} 正在被其他进程或控制台占用 (SessionAlreadyOwnedError)，正在进行第 ${attempt + 1}/${maxRetries} 次重试...`
            );

            if (attempt < maxRetries - 1) {
              await new Promise((res) => setTimeout(res, delays[attempt]));
              continue;
            }
            throw new SessionAlreadyOwnedError(
              sessionId,
              `会话 ${sessionId} 当前正被其他控制台或任务占用（排他锁冲突），请稍后重试或在 Web 端切换其他会话以释放锁。`
            );
          }

          this.ctx.logger?.(PLUGIN_NAME)?.debug?.(
            `[SessionAgentRunner] Resume session ${sessionId} 未命中或异常:`,
            err?.message
          );
          break;
        }
      }
    }

    // 4. 若磁盘无历史记录或未恢复（且绝非持锁冲突状态），则创建全新的 session
    if (!handle && !isSessionLocked) {
      if (typeof agents?.create !== 'function') {
        throw new Error('agents.create is not available');
      }
      try {
        handle = await agents.create({
          sessionId: sessionId as any,
          agentOptions: {
            provider,
            model,
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          },
          meta: { cwd, agentPreset: QQ_PRESET_ID },
          setup: setupFn,
        });
      } catch (createErr: any) {
        if (
          typeof createErr?.message === 'string' &&
          (createErr.message.includes('already exists') || createErr.message.includes('already attached'))
        ) {
          const hash = generateSessionHash();
          const parsed = parseSessionId(sessionId);
          const fallbackSid = parsed
            ? buildSessionId(
                `kujira-user-${parsed.id}`,
                parsed.round,
                parsed.version,
                hash
              )
            : `${sessionId}-${hash}`;
          this.ctx.logger?.(PLUGIN_NAME)?.warn?.(
            `[SessionAgentRunner] 创建会话 ${sessionId} 遭遇宿主内存残留冲突 (${createErr.message})，自动切换短哈希防撞会话: ${fallbackSid}`
          );
          sessionId = fallbackSid;
          this.delegate.onSessionReassigned?.(peer, sessionId);
          cwd = this.workspace.resolveCwd(sessionId);
          await fsp.mkdir(cwd, { recursive: true });
          handle = await agents.create({
            sessionId: sessionId as any,
            agentOptions: {
              provider,
              model,
              ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            },
            meta: { cwd, agentPreset: QQ_PRESET_ID },
            setup: setupFn,
          });
        } else {
          throw createErr;
        }
      }
    }

    if (!handle) {
      throw new Error(`Failed to create or resume agent for session ${sessionId}`);
    }

    this.activeHandles.set(sessionId, handle);

    // 单聊新会话统一默认装配 workspace-write 权限，不限制 Preset 内置工作区与 Shell 工具
    if (!isResumed) {
      const permissionPresets: any = safeGetService(this.ctx, 'permissionPresets');
      if (permissionPresets && typeof permissionPresets.set === 'function') {
        try {
          permissionPresets.set(handle.agent.session, 'workspace-write');
        } catch (permErr: any) {
          this.ctx.logger?.(PLUGIN_NAME)?.warn?.(
            `[SessionAgentRunner] 设置会话 ${sessionId} 权限预设 (workspace-write) 异常:`,
            permErr?.message
          );
        }
      }
    }

    if (isResumed) {
      this.markSessionPersisted(sessionId);
      this.clearPendingFirstTurn(sessionId);
    } else {
      // 全新创建的会话打入新建保护期，防止首轮交互完成落盘前被误判死亡
      this.markPendingFirstTurn(sessionId);
    }

    // 自动在 DSH workspaceRegistry 中登记单一 Kujira 顶级工作区并关联活跃会话
    await this.workspace.registerWorkspace(cwd, sessionId, 'Kujira');

    // 锁定会话标题，防止 LLM 自动总结覆盖
    this.updateSessionTitle(handle.agent.session, peer, sessionId);

    // 固化 agentPreset 投影至 session，确保冷重启恢复时绝不 fallback 至默认 coding 预设
    const presets: any = safeGetService(this.ctx, 'agentPresets');
    const sessionProjections: any = safeGetService(this.ctx, 'sessionProjections');
    const currentPreset = sessionProjections?.stateOf?.(handle.agent.session, 'agentPreset');
    if (currentPreset !== QQ_PRESET_ID) {
      if (presets?.select && typeof presets.select === 'function') {
        try {
          await presets.select(handle.agent, QQ_PRESET_ID);
        } catch (selErr: any) {
          this.ctx.logger?.(PLUGIN_NAME)?.debug?.(
            `[SessionAgentRunner] presets.select(${sessionId}, ${QQ_PRESET_ID}) 忽略非致命异常:`,
            selErr?.message
          );
          if (handle.agent.session?.append && typeof handle.agent.session.append === 'function') {
            try {
              (handle.agent.session as any).append('agent-preset/selected', { agentPreset: QQ_PRESET_ID });
            } catch {}
          }
        }
      } else if (handle.agent.session?.append && typeof handle.agent.session.append === 'function') {
        try {
          (handle.agent.session as any).append('agent-preset/selected', { agentPreset: QQ_PRESET_ID });
        } catch {}
      }
    }

    (handle.agent as any).modelSelection = selectionRef;
    this.delegate.onClearPendingCleared?.(peer, sessionId);
    return handle.agent;
  }

  public async dispatchWakeup(
    payload: WakeupPayload,
    options?: {
      onMessageCreated?: (userMsg: any) => void;
    }
  ): Promise<any> {
    const isSystemWakeup =
      Boolean(payload.is_system) ||
      payload.trigger === 'scheduled' ||
      (!(payload as any).msg_id && !payload.from_user);

    // 关键约束：系统合成唤醒绝不传 msg_id: undefined 或空串，以免覆盖或擦除历史有效入站被动 msg_id 锚点
    if (isSystemWakeup && this.outboundBridge) {
      this.outboundBridge.trackInboundContext(payload.peer, {
        is_synthetic: true,
        trigger: 'scheduled',
      });
    }

    const agent = await this.getOrCreateAgent(payload.peer);
    const sessionId = (agent as any).session?.id || this.delegate.peerToSessionId(payload.peer);

    // 仅当唤醒来源是真实 QQ 单聊发送者（direct / quote）时才允许用 from_name 更新单聊标题
    if (
      !payload.is_system &&
      payload.from_name &&
      REAL_SENDER_TRIGGERS.has(String(payload.trigger)) &&
      isUserPeer(payload.peer)
    ) {
      this.updateSessionTitle((agent as any).session, payload.peer, sessionId, payload.from_name);
    }

    const promptText =
      payload.is_system && payload.system_event
        ? formatSystemEventPrompt(payload.system_event)
        : formatWakeupPrompt(payload);

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: promptText }],
      source: { kind: 'user' },
    });

    // 审批「本轮唤醒者」登记：只登记真实 QQ 单聊发送者唤醒（系统触发返回 null）
    const wakeupInitiator = payload.is_system
      ? null
      : resolveWakeupInitiator(payload.trigger, payload.from_user);
    if (wakeupInitiator) {
      this.turnInitiatorTracker?.expect(userMsg?.id, sessionId, wakeupInitiator);
    }

    if (isSystemWakeup && this.outboundBridge && userMsg?.id) {
      this.outboundBridge.trackPendingMessage?.(userMsg.id, payload.peer, {
        is_synthetic: true,
        trigger: 'scheduled',
      });
    }

    this.markSessionBusy(sessionId, true);
    try {
      options?.onMessageCreated?.(userMsg);
      const isAgentRunning = (agent as any).status === 'running';
      const behavior = this.resolveNewMessageBehavior();
      if (isAgentRunning && behavior === 'steer' && typeof (agent as any).steer === 'function') {
        (agent as any).steer(userMsg);
      } else {
        agent.followup(userMsg);
      }
      return userMsg;
    } finally {
      this.markSessionBusy(sessionId, false);
      if (this.persistence.isSessionPhysicallyPresent(sessionId)) {
        this.clearPendingFirstTurn(sessionId);
        this.markSessionPersisted(sessionId);
      }
    }
  }

  public async dispose(): Promise<void> {
    const sc = this.ctx.get?.('sessionController') || (this.ctx as any).sessionController;
    if (sc && (sc.prompt as any)?.__dsh_kujira_guarded) {
      sc.prompt = (sc.prompt as any).__originalPrompt;
    }
    for (const [id, handle] of this.activeHandles.entries()) {
      try {
        await handle.dispose();
      } catch (err) {
        this.ctx.logger?.(PLUGIN_NAME)?.warn?.(`[SessionAgentRunner] 销毁 Agent ${id} 失败:`, err);
      }
    }
    this.activeHandles.clear();
    this.pendingFirstTurnSessions.clear();
    this.persistedSessions.clear();
    this.peerNames.clear();
    this.busySessions.clear();
  }
}
