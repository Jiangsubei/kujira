/**
 * kujira: 单聊主动能力管理器 (ProactiveManager)
 *
 * 只服务 QQ 官方 Bot 单聊（C2C），管理两件彼此解耦的事：
 *   1. 消息聚合回复：自由周期时钟到点，若该会话「有新消息」则唤醒模型；
 *   2. 冷场主动搭话：长时间无新消息时，由系统自发唤醒模型主动发起话题。
 *
 * 设计要点（与早期「消息池」实现的本质差异）：
 *   - **不维护消息池**：所有消息本就已落库，数据库是唯一可信源。
 *     本管理器只维护一个布尔标志「自上次触发以来是否有新消息」，
 *     绝不复制、裁剪或缓存消息内容。
 *   - **不向模型喂消息**：系统事件只告知「有新消息，去看」，由模型自行调用
 *     `read_chat_history` 取回内容并判断是否需要回复。这消除了我们在格式化、
 *     附件渲染、上下文裁剪上的全部维护成本。
 *   - **自由周期时钟**：相位来自插件启动（或配置启用）时刻，不因消息到达、
 *     投递、轮次结束而重置。消息恰好在 tick 前一秒到达并被一并带走，属自然节奏。
 *   - **等待用户输入时暂停**：提问/审批挂起期间跳过唤醒（池化到下一轮），
 *     时钟继续走，不冻结、不重置。
 */

import type { BridgePluginConfig } from '../types/index.js';
import type { SystemWakeupEvent } from '../types/system-event.js';

export interface ProactiveManagerOptions {
  config: BridgePluginConfig;
  /** 统一投递入口：真实装配下由 SystemEventHub.dispatchSystemEvent 承接 */
  dispatch?: (event: SystemWakeupEvent) => Promise<unknown> | unknown;
  /**
   * 是否正在等待用户输入（提问 / 审批挂起）。
   * 返回 true 时**跳过本轮唤醒**，但时钟继续走、新消息标志保留，
   * 待用户作答/决策完成后由下一轮 tick 一并处理。
   */
  isAwaitingUserInput?: (peer: string) => boolean;
  /**
   * 该 peer 是否存在**当前活跃会话**。
   * - 聚合：无活跃会话时跳过（消息仍在库中，等会话恢复后继续）；
   * - 冷场搭话：返回 false 时按「曾有互动但会话已不在」处理，允许新建会话后唤醒。
   */
  hasActiveSession?: (peer: string) => boolean;
  /**
   * 确保该 peer 拥有可用会话（必要时创建）。
   * 仅在冷场搭话且 `hasActiveSession` 为 false 时调用。
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

/** 每 peer 的极简状态：只剩「有没有新消息」与冷场搭话的本轮标记 */
interface PeerState {
  /** 自上次触发聚合以来是否有新增入站消息 */
  hasNewMessage: boolean;
  /** 本轮沉默周期内是否已搭过话（防死循环，人类新消息时复位） */
  idleFired: boolean;
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
      st = { hasNewMessage: false, idleFired: false };
      this.states.set(peer, st);
    }
    return st;
  }

  /**
   * 记录一次入站消息：只置「有新消息」标志并复位冷场标记。
   * **不保存任何消息内容** —— 内容已在调用方落库。
   */
  recordMessage(peer: string): void {
    if (!peer) return;
    const st = this.stateOf(peer);
    st.hasNewMessage = true;
    st.idleFired = false;
  }

  /** 查询某会话当前是否标记为「有新消息」（只读，不消费） */
  hasPendingMessage(peer: string): boolean {
    return this.states.get(peer)?.hasNewMessage ?? false;
  }

  /** 消费「有新消息」标志（tick 触发后调用，避免同一批消息被反复唤醒） */
  consumePendingMessage(peer: string): boolean {
    const st = this.states.get(peer);
    if (!st || !st.hasNewMessage) return false;
    st.hasNewMessage = false;
    return true;
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
   * 集中巡检：推进自由周期时钟，到点则处理聚合；冷场搭话独立判定。
   */
  async checkProactive(options: ProactiveManagerOptions): Promise<void> {
    const { config, dispatch } = options;
    if (!dispatch) return;

    const now = options.now ?? Date.now();
    const aggregationEnabled = Boolean(config.aggregation_enabled);
    const idleEnabled = Boolean(config.idle_reply_enabled);

    if (!aggregationEnabled && !idleEnabled) return;

    // ---- 1. 聚合回复：自由周期时钟到点才处理 ----
    const aggregatedThisTick = new Set<string>();
    if (aggregationEnabled && this.advanceClock(config, now)) {
      const peers = new Set<string>();
      for (const [peer, st] of this.states) {
        if (st.hasNewMessage) peers.add(peer);
      }

      for (const peer of peers) {
        // 等待用户输入：跳过本轮唤醒，标志保留，等下一轮一并处理
        if (options.isAwaitingUserInput?.(peer)) continue;
        // 无活跃会话：尝试建立（用户真实发过消息，消息已在库中）
        if (options.hasActiveSession && !options.hasActiveSession(peer)) {
          const ready = await options.ensureSession?.(peer);
          if (!ready) continue;
        }
        // 原子消费标志：即便投递失败也不回滚，避免同一批消息被反复唤醒
        if (!this.consumePendingMessage(peer)) continue;

        aggregatedThisTick.add(peer);
        const intervalMins = Number(config.aggregation_interval_mins ?? 0);
        try {
          await dispatch({
            kind: 'aggregated_messages',
            peer,
            ...(Number.isFinite(intervalMins) && intervalMins > 0 ? { intervalMinutes: intervalMins } : {}),
            timestamp: now,
          });
        } catch {
          // 投递失败静默跳过；消息仍在库中，模型下次被唤醒时仍可读到
        }
      }
    }

    // ---- 2. 冷场主动搭话：独立于聚合时钟，按沉默时长判定 ----
    if (!idleEnabled) return;

    const timeoutMins = Number(config.idle_reply_timeout_mins ?? 0);
    if (!Number.isFinite(timeoutMins) || timeoutMins <= 0) return;

    const candidates = new Set<string>(this.states.keys());
    for (const peer of options.knownPeers?.() ?? []) {
      if (typeof peer === 'string' && peer.startsWith('user_')) candidates.add(peer);
    }

    for (const peer of candidates) {
      const st = this.stateOf(peer);
      if (st.idleFired) continue;
      // 本轮刚投递过聚合：绝不在同一轮叠加搭话
      if (aggregatedThisTick.has(peer)) continue;
      // 池内有新消息时优先让聚合处理，绝不叠加搭话
      // （仅当聚合开启时该标志才有意义；聚合关闭时不应因标志残留而永久挡住搭话）
      if (aggregationEnabled && st.hasNewMessage) continue;
      // 等待用户输入期间同样暂停搭话
      if (options.isAwaitingUserInput?.(peer)) continue;

      // 沉默起点以库中最新消息时间为准，重启后依然准确
      const lastHumanAt = options.lastHumanMessageAt?.(peer) ?? null;
      if (typeof lastHumanAt !== 'number') continue;
      if (now - lastHumanAt < timeoutMins * 60 * 1000) continue;

      // 会话不存在时尝试建立（仅对「曾经互动过」的 peer——候选集已按此过滤）
      if (options.hasActiveSession && !options.hasActiveSession(peer)) {
        const ready = await options.ensureSession?.(peer);
        if (!ready) continue;
      }

      // 先置标记再投递：即便异常也不重复搭话
      st.idleFired = true;
      try {
        await dispatch({
          kind: 'idle_reply',
          peer,
          idleMinutes: timeoutMins,
          timestamp: now,
        });
      } catch {
        // 静默容错，标记保持已置位
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
