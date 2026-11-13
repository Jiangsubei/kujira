/**
 * kujira: 单聊主动能力管理器 (ProactiveManager)
 *
 * 只服务 QQ 官方 Bot 单聊（C2C），管理两件彼此解耦的事：
 *   1. 消息聚合回复：周期内把未投递消息池化，轮次边界一次性逐条注入；
 *   2. 冷场主动搭话：长时间无新消息时，由系统自发唤醒模型主动发起话题。
 *
 * 设计要点：
 *   - **纯内存消息池**：池只装「尚未投递」的真实入站消息，投递成功后清空，
 *     投递失败整批保留待重试；数据库仍是历史记录的唯一可信源。
 *   - **不在池内做去重判断**：提问/审批答案、`wait_for_user_messages` 收集、
 *     运行中 steer 即时投递的消息都由上层拦截，根本不入池，因此模型不会重复看到。
 *   - **只在轮次边界投递**：空闲时由自由周期时钟 tick；运行中绝不打断，
 *     等 `turn/end` 由 `flushPendingMessages` 投递。
 *   - **自由周期时钟**：相位来自插件启动（或配置启用）时刻，不因消息到达、
 *     投递、轮次结束而重置。
 *   - **等待用户输入时暂停**：提问/审批挂起期间跳过 tick 与 flush，池保留。
 *   - **冷场按周期重复唤醒**：沉默达到阈值后唤醒一次；此后必须再经过一个
 *     冷场周期，才允许下一次。出站消息不重置沉默起点，起点只看库中最新入站时间。
 */

import type { AggregatedMessage, BridgePluginConfig } from '../types/index.js';
import type { SystemWakeupEvent } from '../types/system-event.js';

export interface ProactiveManagerOptions {
  config: BridgePluginConfig;
  /** 统一投递入口：真实装配下由 SystemEventHub.dispatchSystemEvent 承接 */
  dispatch?: (event: SystemWakeupEvent) => Promise<unknown> | unknown;
  /**
   * 是否正在等待用户输入（提问 / 审批挂起）。
   * 返回 true 时跳过本轮 tick 与 flush，池完整保留。
   */
  isAwaitingUserInput?: (peer: string) => boolean;
  /**
   * 该 peer 的 Agent 当前是否正在运行一轮。
   * 返回 true 时 tick 绝不打断，池保留到 `turn/end` flush。
   */
  isAgentRunning?: (peer: string) => boolean;
  /**
   * 该 peer 是否存在**当前活跃会话**。
   * - 聚合：无活跃会话时尝试 ensureSession，失败则保留池等下次重试；
   * - 冷场搭话：返回 false 时按「曾有互动但会话已不在」处理，允许新建会话后唤醒。
   */
  hasActiveSession?: (peer: string) => boolean;
  /**
   * 确保该 peer 拥有可用会话（必要时创建）。
   * 仅在 `hasActiveSession` 为 false 时调用。
   */
  ensureSession?: (peer: string) => Promise<boolean> | boolean;
  /**
   * 取该 peer 最后一条**入站**消息时间（毫秒）；无记录返回 null。
   * 以数据库为准，进程重启后沉默时长依然准确。
   */
  lastHumanMessageAt?: (peer: string) => number | null;
  /** 枚举「曾经真实互动过」的 peer（peer_openid_map 中已登记的），用于冷场搭话扫描 */
  knownPeers?: () => string[];
  now?: number;
}

/** 每 peer 的池状态：只保存未投递消息与冷场时刻 */
interface PeerState {
  /** 尚未投递的消息（按时间升序） */
  pending: AggregatedMessage[];
  /** 池内最后一位真实发送者 openid（用于聚合轮次登记审批发起人） */
  lastFromUser?: string;
  /** 投递单飞锁：同一 peer 任何时刻只允许一个投递在途 */
  delivering: boolean;
  /**
   * 上次冷场唤醒时刻（毫秒）。
   * null 表示本进程内尚未冷场唤醒过。
   * 距今未满一个冷场周期则不再唤醒；只由冷场唤醒自身写下，入站与出站都不改它。
   */
  lastIdleWakeupAt: number | null;
}

/**
 * 入站消息是否应进入聚合池（而非即时唤醒）。
 *
 * - 聚合关闭：不入池，走原有即时链路；
 * - 聚合开启且 Agent 正在运行：
 *   - `steer`：即时插话，不入池；
 *   - `queue`：入池，等本轮 `turn/end` 一次性注入；
 * - 聚合开启且空闲：入池，等自由周期 tick。
 */
export function shouldPoolInbound(params: {
  aggregationEnabled: boolean;
  behavior: 'steer' | 'queue';
  isAgentRunning: boolean;
}): boolean {
  if (!params.aggregationEnabled) return false;
  if (!params.isAgentRunning) return true;
  return params.behavior === 'queue';
}

function cloneMessage(message: AggregatedMessage): AggregatedMessage {
  return {
    ...message,
    ...(message.quoted
      ? {
          quoted: {
            ...(message.quoted.short_id ? { short_id: message.quoted.short_id } : {}),
            ...(typeof message.quoted.time === 'number' ? { time: message.quoted.time } : {}),
            text: message.quoted.text,
          },
        }
      : {}),
    ...(message.attachments ? { attachments: [...message.attachments] } : {}),
  };
}

export class ProactiveManager {
  private readonly states = new Map<string, PeerState>();
  private timer: NodeJS.Timeout | null = null;
  /** 自由周期时钟的下一次到点时刻 */
  private nextTickAt = 0;
  /** 当前生效的周期长度（毫秒），用于识别配置变更并重新对齐时钟 */
  private activeIntervalMs = 0;

  private stateOf(peer: string): PeerState {
    let st = this.states.get(peer);
    if (!st) {
      st = { pending: [], delivering: false, lastIdleWakeupAt: null };
      this.states.set(peer, st);
    }
    return st;
  }

  /**
   * 记录一条尚未投递的入站消息：入池并刷新真实发送者。
   * 调用方负责拦截已消费的消息（提问/审批答案、wait 收集、steer 即时投递），
   * 本方法不做任何去重或内容裁剪。
   */
  recordMessage(peer: string, message: AggregatedMessage, fromUser?: string): void {
    if (!peer || !message) return;
    const st = this.stateOf(peer);
    st.pending.push(cloneMessage(message));
    st.pending.sort((a, b) => a.time - b.time);
    const uid = typeof fromUser === 'string' ? fromUser.trim() : '';
    if (uid) st.lastFromUser = uid;
  }

  /** 查询某会话池内是否有未投递消息（只读，不消费） */
  hasPendingMessage(peer: string): boolean {
    return (this.states.get(peer)?.pending.length ?? 0) > 0;
  }

  /** 取池内消息快照（深拷贝，按时间升序；外部修改不影响池内状态） */
  getPendingMessages(peer: string): AggregatedMessage[] {
    return (this.states.get(peer)?.pending ?? []).map(cloneMessage);
  }

  /** 取池内最后一位真实发送者（审批发起人兜底用） */
  getLastFromUser(peer: string): string | undefined {
    return this.states.get(peer)?.lastFromUser;
  }

  /** 清空某会话全部状态（会话被外部删除等场景） */
  clearPeer(peer: string): void {
    this.states.delete(peer);
  }

  private resolveIntervalMs(config: BridgePluginConfig): number {
    const mins = Number(config.aggregation_interval_mins ?? 0);
    if (!Number.isFinite(mins) || mins <= 0) return 0;
    return mins * 60 * 1000;
  }

  /**
   * 推进自由周期时钟：返回本次是否应当 tick。
   * 周期变更（用户改配置）时立即以当前时刻重新对齐相位。
   */
  private advanceClock(config: BridgePluginConfig, now: number): boolean {
    const intervalMs = this.resolveIntervalMs(config);
    if (intervalMs <= 0) {
      this.activeIntervalMs = 0;
      this.nextTickAt = 0;
      return false;
    }

    // 周期变更：重新对齐相位，避免残留旧周期节奏
    if (this.activeIntervalMs !== intervalMs) {
      this.activeIntervalMs = intervalMs;
      this.nextTickAt = now + intervalMs;
      return false;
    }

    if (this.nextTickAt === 0) {
      this.nextTickAt = now + intervalMs;
      return false;
    }

    if (now < this.nextTickAt) return false;

    // 与真实时钟对齐推进，绝不因巡检迟到而累积"补发"多次 tick
    this.nextTickAt = now + intervalMs;
    return true;
  }

  /**
   * 单飞投递：把当前池快照作为一次 `aggregated_messages` 事件投递。
   * 成功后只移除快照内的消息（投递期间新到的留在池内），失败整批保留。
   */
  private async deliverPending(
    peer: string,
    st: PeerState,
    reason: 'period' | 'turn_end',
    options: ProactiveManagerOptions
  ): Promise<boolean> {
    const dispatch = options.dispatch;
    if (!dispatch) return false;
    if (st.delivering) return false;
    if (st.pending.length === 0) return false;

    const originals = st.pending.slice();
    const batch = originals.map(cloneMessage);
    const now = options.now ?? Date.now();

    st.delivering = true;
    try {
      const intervalMins = Number(options.config.aggregation_interval_mins ?? 0);
      await dispatch({
        kind: 'aggregated_messages',
        peer,
        messages: batch,
        reason,
        ...(st.lastFromUser ? { fromUser: st.lastFromUser } : {}),
        ...(reason === 'period' && Number.isFinite(intervalMins) && intervalMins > 0
          ? { intervalMinutes: intervalMins }
          : {}),
        timestamp: now,
      });
      // 只移除本次快照，投递期间新到的消息保留
      st.pending = st.pending.filter((message) => !originals.includes(message));
      return true;
    } catch {
      // 投递失败整批保留，下一次 tick / flush 重试
      return false;
    } finally {
      st.delivering = false;
    }
  }

  /**
   * 轮次结束（`turn/end`）时投递排队消息。
   * 仅在聚合开启、池非空、非等待用户输入且会话可用时投递；单飞防重。
   */
  async flushPendingMessages(peer: string, options: ProactiveManagerOptions): Promise<boolean> {
    if (!options.config.aggregation_enabled || !options.dispatch) return false;

    const st = this.states.get(peer);
    if (!st || st.pending.length === 0) return false;
    if (st.delivering) return false;
    if (options.isAwaitingUserInput?.(peer)) return false;

    if (options.hasActiveSession && !options.hasActiveSession(peer)) {
      const ready = await options.ensureSession?.(peer);
      if (!ready) return false;
    }

    return this.deliverPending(peer, st, 'turn_end', options);
  }

  /**
   * 集中巡检：推进自由周期时钟，到点则投递池内的周期消息；冷场搭话独立判定。
   */
  async checkProactive(options: ProactiveManagerOptions): Promise<void> {
    const { config, dispatch } = options;
    if (!dispatch) return;

    const now = options.now ?? Date.now();
    const aggregationEnabled = Boolean(config.aggregation_enabled);
    const idleEnabled = Boolean(config.idle_reply_enabled);

    // 聚合关闭：池失去投递通道，直接清空（消息仍在库中，可由 read_chat_history 捡回）
    if (!aggregationEnabled) {
      for (const st of this.states.values()) {
        st.pending = [];
        st.lastFromUser = undefined;
      }
    }

    if (!aggregationEnabled && !idleEnabled) return;

    // ---- 1. 聚合回复：自由周期时钟到点才处理 ----
    const deliveredThisTick = new Set<string>();
    if (aggregationEnabled && this.advanceClock(config, now)) {
      const peers = new Set<string>();
      for (const [peer, st] of this.states) {
        if (st.pending.length > 0) peers.add(peer);
      }

      for (const peer of peers) {
        // 等待用户输入：跳过本轮，池保留，等恢复后一并处理
        if (options.isAwaitingUserInput?.(peer)) continue;
        // Agent 正在运行：绝不打断，池保留到 turn/end flush
        if (options.isAgentRunning?.(peer)) continue;
        // 无活跃会话：尝试建立（消息仍在池与库中），失败保留待重试
        if (options.hasActiveSession && !options.hasActiveSession(peer)) {
          const ready = await options.ensureSession?.(peer);
          if (!ready) continue;
        }

        const st = this.states.get(peer);
        if (!st) continue;
        if (await this.deliverPending(peer, st, 'period', options)) {
          deliveredThisTick.add(peer);
        }
      }
    }

    // ---- 2. 冷场主动搭话：独立于聚合时钟 ----
    // 两道闸门同时满足才唤醒：沉默时长达标，且距上次冷场唤醒已满一个周期。
    // 模型发消息或输出结束都不参与；出站也不重置沉默起点。
    if (!idleEnabled) return;

    const timeoutMins = Number(config.idle_reply_timeout_mins ?? 0);
    if (!Number.isFinite(timeoutMins) || timeoutMins <= 0) return;
    const timeoutMs = timeoutMins * 60 * 1000;

    const candidates = new Set<string>(this.states.keys());
    for (const peer of options.knownPeers?.() ?? []) {
      if (typeof peer === 'string' && peer.startsWith('user_')) candidates.add(peer);
    }

    for (const peer of candidates) {
      const st = this.stateOf(peer);
      // 距上次冷场唤醒未满一个周期：不再触发
      if (st.lastIdleWakeupAt !== null && now - st.lastIdleWakeupAt < timeoutMs) continue;
      // 本轮刚投递过聚合：绝不在同一轮叠加搭话
      if (deliveredThisTick.has(peer)) continue;
      // 池内有未投递消息时优先让聚合处理，绝不叠加搭话
      if (aggregationEnabled && st.pending.length > 0) continue;
      // 等待用户输入期间同样暂停搭话（不记下唤醒时刻，恢复后仍可触发）
      if (options.isAwaitingUserInput?.(peer)) continue;

      // 沉默起点以库中最新入站消息时间为准，重启后依然准确。出站消息不写入该时间。
      const lastHumanAt = options.lastHumanMessageAt?.(peer) ?? null;
      if (typeof lastHumanAt !== 'number') continue;
      if (now - lastHumanAt < timeoutMs) continue;

      // 会话不存在时尝试建立（仅对「曾经互动过」的 peer——候选集已按此过滤）
      // 建立失败不记唤醒时刻，下一轮巡检可立即重试
      if (options.hasActiveSession && !options.hasActiveSession(peer)) {
        const ready = await options.ensureSession?.(peer);
        if (!ready) continue;
      }

      // 先记下唤醒时刻再投递：投递异常也不会在同一周期内紧循环
      st.lastIdleWakeupAt = now;
      try {
        await dispatch({
          kind: 'idle_reply',
          peer,
          idleMinutes: timeoutMins,
          timestamp: now,
        });
      } catch {
        // 静默容错，唤醒时刻保持已记下
      }
    }
  }

  /** 启动后台巡检定时器（默认 60 秒扫描一次，由内部时钟判断是否到点） */
  startChecker(getOptions: () => ProactiveManagerOptions, intervalMs = 60_000): void {
    this.stopChecker();
    this.timer = setInterval(async () => {
      try {
        await this.checkProactive(getOptions());
      } catch {
        // 巡检异常一律容错，绝不中断定时器
      }
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stopChecker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 清空全部内存状态（插件卸载时使用） */
  dispose(): void {
    this.stopChecker();
    this.states.clear();
    this.nextTickAt = 0;
    this.activeIntervalMs = 0;
  }
}
