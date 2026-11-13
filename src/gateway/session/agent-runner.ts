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

export interface AgentRunnerDelegate {
  peerToSessionId(peer: string): string;
  sessionIdToPeer(sessionId: string): string;
  onSessionReassigned?(peer: string, newSessionId: string): void;
  onClearPendingCleared?(peer: string, sessionId: string): void;
  isSessionDeleted?(sessionId: string): boolean;
}

export class SessionAgentRunner {
  private activeHandles = new Map<string, AgentHandle>();
  private busySessions = new Set<string>();
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
  ) {}

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

  /**
   * 只读查询会话标题（优先活跃 handle 的 sessionTitle 投影，其次 sessionsSvc.get(sid)），
   * 绝不调用 sessionTitle.rename 锁定或覆盖 DSH 原生 AI 总结标题。
   */
  public getSessionTitle(sessionId: string): string | undefined {
    if (!sessionId || typeof sessionId !== 'string') return undefined;
    const titleSvc = safeGetService(this.ctx, 'sessionTitle') || (this.ctx as any)?.sessionTitle;
    const sessionsSvc = safeGetService(this.ctx, 'sessions') || (this.ctx as any)?.sessions;

    const readFromSession = (session: any): string | undefined => {
      if (!session) return undefined;
      try {
        const snapshot = titleSvc?.get?.(session);
        if (typeof snapshot?.title === 'string' && snapshot.title.trim()) {
          return snapshot.title.trim();
        }
      } catch {}
      if (typeof session.title === 'string' && session.title.trim()) {
        return session.title.trim();
      }
      return undefined;
    };

    const handle = this.activeHandles.get(sessionId);
    const fromHandle = readFromSession((handle?.agent as any)?.session);
    if (fromHandle) return fromHandle;

    try {
      const storedSession = sessionsSvc?.get?.(sessionId);
      const fromStore = readFromSession(storedSession);
      if (fromStore) return fromStore;
    } catch {}

    try {
      const agentsSvc = safeGetService(this.ctx, 'agents') || (this.ctx as any)?.agents;
      const liveAgent = agentsSvc?.get?.(sessionId as any);
      const fromAgent = readFromSession((liveAgent as any)?.session);
      if (fromAgent) return fromAgent;
    } catch {}

    return undefined;
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

  /** 只读判定：该 peer / 会话的 Agent 当前是否正在运行一轮 */
  public isAgentRunning(peerOrSessionId: string): boolean {
    try {
      return this.getAgent(peerOrSessionId)?.status === 'running';
    } catch {
      return false;
    }
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
          const resumedHandle = await agents.resume({
            resumeSessionId: sessionId as any,
            agentOptions: {
              provider,
              model,
              ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            },
            setup: setupFn,
          });
          if (resumedHandle) {
            handle = resumedHandle;
            isResumed = true;
          }
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

    const promptText =
      payload.is_system && payload.system_event
        ? formatSystemEventPrompt(payload.system_event)
        : formatWakeupPrompt(payload);

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: promptText }],
      source: { kind: 'user' },
    });

    // 审批「本轮唤醒者」登记：按 trigger 判定，与提示词是否走系统事件格式解耦。
    // - 真实用户来源（direct / quote / aggregated）：登记真实发起人，本轮可正常审批；
    // - 系统自发（scheduled / idle_reply）：result 为 null，审批保持 Fail-Closed。
    const wakeupInitiator = resolveWakeupInitiator(payload.trigger, payload.from_user);
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
      // 聚合批次只允许在轮次边界投递：绝不 steer 打断进行中的轮次，
      // 一律 followup 排队到下一轮（turn/end / 空闲 tick 都是这个入口）。
      const isAggregatedBatch = payload.trigger === 'aggregated';
      if (
        !isAggregatedBatch &&
        isAgentRunning &&
        behavior === 'steer' &&
        typeof (agent as any).steer === 'function'
      ) {
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
    this.busySessions.clear();
  }
}
