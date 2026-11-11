/**
 * kujira: QQ 官方 Bot 单聊敏感工具二元审批模块
 * 接入 Cordis `approval/request` waterfall。
 *
 * 契约规范：
 * - 单聊好友均具备审批权限（彻底移除 admins 白名单与群聊分支）；
 * - 严格保留无人值守定时任务 (`scheduled_task`) Fail-Closed 门控：
 *   当 `applicantId === null || ''`，或通过 `turnInitiatorTracker.getInitiator(sessionId)` 查得 `undefined` 时，
 *   立即返回 `'rejected'` 且绝不下发审批提示；
 * - 出站统一通过 `OutboundStreamBridge.sendTextReply` 下发（共享 `msg_seq` 槽位与被动/主动降级）。
 */

import {
  OutboundStreamBridge,
  type KujiraGatewayClientLike,
  type OutboundSlotDb,
  type SessionManagerLike,
} from '../outbound/stream.js';
import type { SerialSender } from '../types/index.js';
import type { TurnInitiatorTracker } from './turn-initiator.js';

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalRequestPayload {
  peer: string;
  toolName: string;
  callId?: string;
  reason?: string;
  /** 关联的 DSH SessionId（用于配合 turnInitiatorTracker 校验当前轮次是否存在真实发送者） */
  sessionId?: string;
  /** 本轮唤醒者标识（openid / peer）；显式传入 null 或 '' 时表示无人值守系统唤醒，Fail-Closed 拒绝 */
  applicantId?: string | null;
  signal?: AbortSignal;
}

export interface ApprovalResponderOptions {
  /** 优先使用的出站桥接器实例（调用其 sendTextReply 下发审批提示） */
  outboundBridge?: OutboundStreamBridge;
  /** 简化依赖：仅提供 gateway（+ 可选 db/sessionManager/sender）时委托共享 OutboundStreamBridge 发送 */
  gateway?: KujiraGatewayClientLike;
  sessionManager?: SessionManagerLike;
  db?: OutboundSlotDb;
  /** 共享 per-peer 串行发送器（仅在未注入 outboundBridge 时辅助排队） */
  sender?: SerialSender;
  /** 审批「本轮唤醒者」追踪器（保留无人值守 scheduled_task Fail-Closed 防护） */
  turnInitiatorTracker?: TurnInitiatorTracker;
  /** 可选默认关联的 DSH SessionId */
  sessionId?: string;
  /** 审批超时时间 (ms)，默认 300_000ms (5 分钟) */
  timeoutMs?: number;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

interface PendingApproval {
  req: ApprovalRequestPayload;
  timer: NodeJS.Timeout | null;
  onAbort: (() => void) | null;
  resolve: (decision: ApprovalOutcome) => void;
  reject: (err: Error) => void;
}

const SYSTEM_PSEUDO_IDENTITIES = new Set(['system', 'agent', 'self']);

/**
 * 接入 Cordis `approval/request` waterfall 的 Kujira 单聊审批响应器
 */
export class KujiraApprovalResponder {
  private pendingByPeer = new Map<string, PendingApproval>();
  private readonly fallbackBridge?: OutboundStreamBridge;

  constructor(private readonly options?: ApprovalResponderOptions) {
    if (!options?.outboundBridge && options?.gateway) {
      this.fallbackBridge = new OutboundStreamBridge({} as any, {
        gateway: options.gateway,
        sessionManager: options.sessionManager,
        db: options.db,
        logger: options.logger,
      });
    }
  }

  private getActiveBridge(): OutboundStreamBridge | undefined {
    return this.options?.outboundBridge ?? this.fallbackBridge;
  }

  private async sendPrompt(peer: string, text: string): Promise<void> {
    const bridge = this.getActiveBridge();
    if (!bridge) {
      throw new Error('缺少可用的 OutboundStreamBridge / QQ Gateway');
    }

    const doSend = () => bridge.sendTextReply(peer, text);
    const customSender = this.options?.sender;
    const res =
      !this.options?.outboundBridge &&
      customSender &&
      typeof customSender.enqueue === 'function' &&
      typeof (bridge as any).getSender === 'function' &&
      customSender !== (bridge as any).getSender()
        ? await customSender.enqueue(peer, doSend)
        : await doSend();

    if (res && typeof res === 'object' && 'ok' in res && !res.ok) {
      throw new Error((res as any).message || `QQ 出站发送失败 (status=${String((res as any).status ?? 'unknown')})`);
    }
  }

  private hasValidInitiator(req: ApprovalRequestPayload): boolean {
    if (req.applicantId === null) {
      return false;
    }
    if (typeof req.applicantId === 'string') {
      const trimmedApplicant = req.applicantId.trim();
      if (!trimmedApplicant || SYSTEM_PSEUDO_IDENTITIES.has(trimmedApplicant.toLowerCase())) {
        return false;
      }
    }

    const sessionId = req.sessionId?.trim() || this.options?.sessionId?.trim();
    if (sessionId && this.options?.turnInitiatorTracker) {
      const initiator = this.options.turnInitiatorTracker.getInitiator(sessionId);
      if (initiator === undefined) {
        return false;
      }
    }

    return true;
  }

  async handleApprovalRequest(req: ApprovalRequestPayload): Promise<ApprovalOutcome> {
    if (req.signal?.aborted) {
      return 'cancelled';
    }

    const peer = typeof req.peer === 'string' ? req.peer.trim() : '';
    const bridge = this.getActiveBridge();

    // 无 peer 或无出站通道：直接拒绝，绝不替用户放行，也不挂起等待
    if (!peer || !bridge) {
      this.options?.logger?.warn?.(
        `[KujiraApprovalResponder] ${!peer ? '缺少目标 peer' : '无可用出站连接'}，审批请求 ${req.toolName} 已拒绝`
      );
      return 'rejected';
    }

    // 保留无人值守定时任务 (scheduled_task) Fail-Closed 门控
    if (!this.hasValidInitiator(req)) {
      this.options?.logger?.warn?.(
        `[KujiraApprovalResponder] 无人值守或无本轮真实发起人触发审批请求 ${req.toolName} (peer: ${peer})，已 Fail-Closed 拒绝且不下发`
      );
      return 'rejected';
    }

    // 顶替机制：同一 peer 发起新审批请求时，前序挂起请求被顶替收敛为 cancelled
    if (this.pendingByPeer.has(peer)) {
      const prev = this.pendingByPeer.get(peer)!;
      try {
        if (prev.timer) clearTimeout(prev.timer);
        if (prev.onAbort && prev.req.signal) {
          prev.req.signal.removeEventListener('abort', prev.onAbort);
        }
        prev.resolve('cancelled');
      } catch {}
      this.pendingByPeer.delete(peer);
    }

    const msg = [
      '【审批请求】',
      `Agent 请求执行工具: ${req.toolName}`,
      `原因: ${req.reason || '无'}`,
      '请回复 y (同意) 或 n (拒绝)',
    ].join('\n');

    let resolveHolder!: (decision: ApprovalOutcome) => void;
    let rejectHolder!: (err: Error) => void;
    const pendingPromise = new Promise<ApprovalOutcome>((resolve, reject) => {
      resolveHolder = resolve;
      rejectHolder = reject;
    });

    const timeoutMs = this.options?.timeoutMs ?? 300_000;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    let settled = false;

    let pendingEntry!: PendingApproval;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (onAbort && req.signal) {
        req.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
      if (this.pendingByPeer.get(peer) === pendingEntry) {
        this.pendingByPeer.delete(peer);
      }
    };

    const settleResolve = (decision: ApprovalOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveHolder(decision);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectHolder(err);
    };

    if (req.signal) {
      onAbort = () => settleResolve('cancelled');
      req.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        this.options?.logger?.warn?.(
          `[KujiraApprovalResponder] 审批请求 ${req.toolName} 超时 (${timeoutMs}ms)，自动 fail-closed 拒绝`
        );
        settleResolve('rejected');
      }, timeoutMs);
    }

    pendingEntry = {
      req,
      timer,
      onAbort,
      resolve: settleResolve,
      reject: settleReject,
    };

    // 先同步入 pending 表再异步下发审批提示：确保快速回复与并发顶替不会漏单
    this.pendingByPeer.set(peer, pendingEntry);

    try {
      await this.sendPrompt(peer, msg);
    } catch (err: any) {
      this.options?.logger?.error?.(
        `[KujiraApprovalResponder] 下发审批请求到 ${peer} 失败:`,
        err
      );
      settleResolve('rejected');
    }

    return pendingPromise;
  }

  /**
   * 处理 QQ 单聊端用户的审批决策 (y/n)
   */
  handleInboundReply(peer: string, text: string): boolean {
    const key = typeof peer === 'string' ? peer.trim() : '';
    const pending = key ? this.pendingByPeer.get(key) : undefined;
    if (!pending) {
      return false;
    }

    const trimmed = text.trim().toLowerCase();
    const isApprove = trimmed === 'y' || trimmed === 'yes' || trimmed === '同意' || trimmed === '允许';
    const isReject = trimmed === 'n' || trimmed === 'no' || trimmed === '拒绝' || trimmed === '不同意';

    if (!isApprove && !isReject) {
      return false;
    }

    if (isApprove) {
      pending.resolve('allowed-once');
      return true;
    }

    pending.resolve('rejected');
    return true;
  }
}
