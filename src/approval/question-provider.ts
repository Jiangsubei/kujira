/**
 * kujira: QQ 官方 Bot 单聊交互式提问 Provider 模块
 * 接入 DSH UserQuestionService / `user-questions/request` waterfall。
 * 负责单聊卡片分发、选项解析、串行多题推进与出站回执下发。
 */

import type {
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions';
import {
  isKujiraSession,
  parseSessionId,
  sessionIdToPeer,
} from '../gateway/session/id-resolver.js';
import {
  OutboundStreamBridge,
  type KujiraGatewayClientLike,
  type OutboundSlotDb,
  type SessionManagerLike,
} from '../outbound/stream.js';
import type { SerialSender } from '../types/index.js';

export interface QuestionProviderOptions {
  /** 共享出站桥接器（优先通过 outboundBridge.sendTextReply 下发提问卡片与回执） */
  outboundBridge?: OutboundStreamBridge;
  /** 简化依赖：仅提供 gateway（+ 可选 db/sessionManager/sender）时委托共享 OutboundStreamBridge 发送 */
  gateway?: KujiraGatewayClientLike;
  sessionManager?: SessionManagerLike;
  db?: OutboundSlotDb;
  /** 共享 per-peer 串行发送器（仅在未注入 outboundBridge 时辅助排队） */
  sender?: SerialSender;
  /** 提问超时时间 (ms)，默认 300_000ms (5 分钟) */
  timeoutMs?: number;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
}

/**
 * 串行多题问答的挂起状态：
 * agent 一次传 N 道题 → 插件逐题下发（每次只渲染当前题卡片），全部答完才一次性 resolve。
 */
interface PendingSerialQuestion {
  request: AskUserQuestionRequest;
  peer: string;
  /** 已作答缓存：逐题推进，最后一道答完一次性交回 agent */
  answers: AskUserQuestionAnswer['answers'];
  /** 当前题下标（0-based） */
  index: number;
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (err: Error) => void;
}

/**
 * 接入 DSH UserQuestionService 的 Kujira 单聊提问 Provider
 *
 * 串行多题问答状态机：
 * - agent 一次传 N 道题 → 只渲染第 1 题卡片发给用户，挂起等该题答案；
 * - 用户答完当前题 → 缓存该题 answer 并立即渲染下一题；
 * - 逐题推进，最后一道答完 → 一次性 resolve({ answers: [题1…题N] }) 交回 agent；
 * - 全程 agent 只等待一次；abort signal 任一节点生效 → 清理 pending + reject。
 */
export class KujiraQuestionProvider {
  private pendingByPeer = new Map<string, PendingSerialQuestion>();
  private readonly fallbackBridge?: OutboundStreamBridge;

  constructor(private readonly options?: QuestionProviderOptions) {
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

  private async sendText(peer: string, text: string): Promise<void> {
    const bridge = this.getActiveBridge();
    if (!bridge) {
      throw new Error('QQ Gateway 未连接 (outboundBridge/gateway 不可用)');
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

  private resolvePeerFromSessionId(sessionId?: string): string | null {
    if (!sessionId || typeof sessionId !== 'string') return null;
    if (this.options?.sessionManager?.sessionIdToPeer) {
      return this.options.sessionManager.sessionIdToPeer(sessionId);
    }
    const parsed = parseSessionId(sessionId);
    if (parsed) {
      return parsed.peer;
    }
    return sessionIdToPeer(sessionId);
  }

  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new Error('AskUserQuestion was aborted before the user answered');
    }

    const sessionId = request.agent?.session?.id;
    const peer = this.resolvePeerFromSessionId(sessionId);
    const bridge = this.getActiveBridge();

    // 未绑定具体单聊 Peer 或无可用出站通道：不得自动作答替 agent 决策
    if (!peer || !bridge) {
      throw new Error(
        `[KujiraQuestionProvider] 无法向 QQ 下发提问: ${!peer ? '未解析到 QQ 会话(peer)' : 'QQ Gateway 未连接 (outboundBridge/gateway 不可用)'}，请确认提问发生在 QQ 单聊会话中`
      );
    }

    if (request.questions.length === 0) {
      throw new Error('[KujiraQuestionProvider] 提问请求必须包含至少一道问题 (questions 不能为空)');
    }

    // 顶替机制：同一 peer 存在前序挂起提问时，显式取消前序请求，防止永久悬挂
    if (this.pendingByPeer.has(peer)) {
      const prev = this.pendingByPeer.get(peer)!;
      try {
        prev.reject(new Error('AskUserQuestion was superseded by a newer question on the same peer'));
      } catch {}
      this.pendingByPeer.delete(peer);
    }

    let resolveHolder!: (answer: AskUserQuestionAnswer) => void;
    let rejectHolder!: (err: Error) => void;
    const pendingPromise = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      resolveHolder = resolve;
      rejectHolder = reject;
    });

    const timeoutMs = this.options?.timeoutMs ?? 300_000;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      this.pendingByPeer.delete(peer);
      if (request.signal) {
        request.signal.removeEventListener('abort', abortHandler);
      }
    };

    const abortHandler = () => {
      cleanup();
      rejectHolder(new Error('AskUserQuestion aborted by caller signal'));
    };

    if (request.signal) {
      request.signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        rejectHolder(new Error(`AskUserQuestion timed out after ${timeoutMs}ms without user response`));
      }, timeoutMs);
    }

    const pending: PendingSerialQuestion = {
      request,
      peer,
      answers: [],
      index: 0,
      resolve: (answer) => {
        cleanup();
        resolveHolder(answer);
      },
      reject: (err) => {
        cleanup();
        rejectHolder(err);
      },
    };

    // 先入 pending 表再下发第一题卡片：快速回复不错失
    this.pendingByPeer.set(pending.peer, pending);

    try {
      await this.sendCurrentCard(pending);
    } catch (err: any) {
      // 发送失败必须 reject，避免 Promise 永久 pending 卡死 agent
      pending.reject(
        new Error(`[KujiraQuestionProvider] 发送提问消息到 ${pending.peer} 失败: ${err?.message || String(err)}`)
      );
    }

    return pendingPromise;
  }

  private async sendCurrentCard(pending: PendingSerialQuestion): Promise<void> {
    const q = pending.request.questions[pending.index];
    const card = KujiraQuestionProvider.formatQuestionCard(q);
    await this.sendText(pending.peer, card);
  }

  private async sendReceipt(peer: string, text: string): Promise<void> {
    try {
      await this.sendText(peer, text);
    } catch (err) {
      this.options?.logger?.warn?.(`[KujiraQuestionProvider] 发送提问回执到 ${peer} 失败:`, err);
    }
  }

  /**
   * 单聊提问卡片展示（唯一档，恒带自定义）：
   * 题文 + detail + 选项行 + 「或者输入自定义答案」 + 「请直接回复数字序号，或者直接输入你的答案」
   */
  static formatQuestionCard(q: AskUserQuestionItem): string {
    const lines: string[] = ['【请回答问题】'];
    const promptText = (q as any).prompt || q.question || q.id;
    if (promptText) lines.push(promptText);
    if (q.detail) lines.push(q.detail);
    if (q.options && q.options.length > 0) {
      lines.push('选项:');
      q.options.forEach((opt, idx) => {
        const desc = opt.description ? ` (${opt.description})` : '';
        lines.push(`${idx + 1}. ${opt.label}${desc}`);
      });
    }
    lines.push('或者输入自定义答案');
    lines.push('请直接回复数字序号，或者直接输入你的答案');
    return lines.join('\n');
  }

  /**
   * 回复解析（越界数字不判定、不提示重答，直接当自定义）：
   * - 单选：文本命中选项序号（N∈[1,选项数]，纯数字串）→ selected=[label_N]；否则整体当 custom。
   * - 多选（multiSelect）：英文逗号分隔；数字段在区间内 → 各进 selected；非数字/越界段 → 拼接为 custom。
   * - 纯自定义输入框（无 options）：恒走 custom。
   */
  static parseAnswerForQuestion(q: AskUserQuestionItem, rawText: string): AskUserQuestionAnswer['answers'][number] {
    const trimmed = rawText.trim();
    const options = q.options || [];

    if (q.multiSelect) {
      const selected: string[] = [];
      const customParts: string[] = [];
      for (const part of trimmed.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        if (/^\d+$/.test(seg)) {
          const num = Number(seg);
          if (num >= 1 && num <= options.length) {
            selected.push(options[num - 1].label);
            continue;
          }
        }
        customParts.push(seg);
      }
      const answer: AskUserQuestionAnswer['answers'][number] = { id: q.id, selected };
      if (customParts.length > 0) answer.custom = customParts.join(',');
      return answer;
    }

    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num >= 1 && num <= options.length) {
        return { id: q.id, selected: [options[num - 1].label] };
      }
    }
    return { id: q.id, selected: [], custom: trimmed };
  }

  /**
   * 判活：该 peer 当前是否有挂起中的提问（等待用户作答）。
   * 供主动能力巡检判定「是否暂停计时」使用；同步、O(1)、无副作用。
   */
  isWaiting(peer: string): boolean {
    const key = typeof peer === 'string' ? peer.trim() : '';
    if (!key) return false;
    return this.pendingByPeer.has(key) || this.pendingByPeer.has(sessionIdToPeer(key));
  }

  /**
   * 处理 QQ 单聊端用户的回复。命中当前 pending 提问则推进/收尾串行问答并返回 true；
   * 未命中返回 false —— 调用方按普通消息继续流转。
   */
  handleInboundReply(peer: string, text: string): boolean {
    const key = typeof peer === 'string' ? peer.trim() : '';
    const pending =
      (key ? this.pendingByPeer.get(key) : undefined) ??
      (key ? this.pendingByPeer.get(sessionIdToPeer(key)) : undefined);
    if (!pending) {
      return false;
    }

    const q = pending.request.questions[pending.index];
    const answer = KujiraQuestionProvider.parseAnswerForQuestion(q, text);
    pending.answers.push(answer);

    const totalQuestions = pending.request.questions.length;
    const currentIndex = pending.index;

    if (pending.index === pending.request.questions.length - 1) {
      void this.sendReceipt(pending.peer, '已成功回答');
      pending.resolve({ answers: pending.answers });
      return true;
    }

    void this.sendReceipt(pending.peer, `已收到第 ${currentIndex + 1}/${totalQuestions} 题回答`);

    pending.index += 1;
    void this.sendCurrentCard(pending).catch((err: any) => {
      pending.reject(
        new Error(`[KujiraQuestionProvider] 发送提问消息到 ${pending.peer} 失败: ${err?.message || String(err)}`)
      );
    });

    return true;
  }
}

/**
 * 接入 DSH 官方 `user-questions/request` waterfall 提问渠道：
 * - 若为 Kujira 单聊会话，由 KujiraQuestionProvider 处理并返回；
 * - 非 Kujira 会话，调用 next() 委托给宿主 Web UI 或后续 provider。
 */
export interface RegisterQuestionChannelOptions {
  /** Kujira 单聊提问 Provider */
  questionProvider: KujiraQuestionProvider;
  /** 判断 session id 是否属于 Kujira 会话（缺省使用 isKujiraSession） */
  isKujiraSession?: (sessionId: string) => boolean;
  /** 兼容别名：等价于 isKujiraSession */
  isQQSession?: (sessionId: string) => boolean;
  logger?: QuestionProviderOptions['logger'];
}

export function registerKujiraQuestionChannel(
  ctx: {
    on(event: string, handler: (...args: any[]) => void, options?: any): any;
  },
  options: RegisterQuestionChannelOptions & { prepend?: boolean }
): () => void {
  const checkKujiraSession =
    options.isKujiraSession || options.isQQSession || isKujiraSession;
  const { questionProvider } = options;

  const off = (ctx as any).on(
    'user-questions/request',
    async (req: any, next: any) => {
      const sessionId =
        req.agent?.session?.id || req.agent?.id || (req.agent as any)?.sessionId || '';
      if (sessionId && checkKujiraSession(sessionId)) {
        return await questionProvider.ask(req);
      }
      return next ? next() : Promise.reject(new Error('no user-questions answerer accepted the request'));
    },
    { prepend: options.prepend !== false }
  );

  options.logger?.info?.('[RegisterQuestionChannel] 已接入官方 user-questions/request waterfall 提问渠道');

  return () => {
    try {
      off?.();
    } catch {}
  };
}
