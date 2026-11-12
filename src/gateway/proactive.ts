/**
 * kujira: 单聊主动能力管理器 (ProactiveManager)
 *
 * 只服务 QQ 官方 Bot 单聊（C2C），管理两件彼此解耦的事：
 *   1. 消息聚合回复：周期窗口到点后，把池内未回复消息整批交给模型一次性回复；
 *   2. 冷场主动搭话：长时间无新消息时，由系统自发唤醒模型主动发起话题。
 *
 * 与旧 dsh-napcat-bridge 群聊版的本质差异：
 *   - 私聊无需滑动窗口：所有消息本就落在同一 session，池子只装「本轮窗口内未回复的消息」，
 *     消费即清空，不需要 replied 标记、条数上限与截断；
 *   - 巡检周期固定 60 秒，绝不复用窗口配置键（旧版一个键同时充当巡检周期与冷却窗口）；
 *   - 聚合与搭话各自独立开关、独立阈值，互不捆绑。
 */

import type { AggregatedMessage, BridgePluginConfig } from '../types/index.js';
import type { SystemWakeupEvent } from '../types/system-event.js';

export interface ProactiveManagerOptions {
  config: BridgePluginConfig;
  /** 统一投递入口：真实装配下由 SystemEventHub.dispatchSystemEvent 承接 */
  dispatch?: (event: SystemWakeupEvent) => Promise<unknown> | unknown;
  /** 会话繁忙时跳过本轮，保留池内消息等待下一轮 */
  isSessionBusy?: (peer: string) => boolean;
  /**
   * 是否正在等待用户输入（提问 / 审批挂起）。
   * 返回 true 时暂停该 peer 的全部计时：暂停期间不计时、不投递，
   * 且每轮巡检把计时锚点推到当前时刻，使恢复后从此刻重新累计完整窗口。
   */
  isAwaitingUserInput?: (peer: string) => boolean;
  /**
   * 该 peer 是否存在**当前活跃会话**。
   * 判定口径与 `/状态` 命令一致：以 peer 当前映射的会话为准。
   * 缺省（未提供）时放行，保持对既有调用方的向后兼容。
   */
  hasActiveSession?: (peer: string) => boolean;
  now?: number;
  /** 已知会话 peer 枚举器：用于冷场搭话扫描（仅 user_ 单聊会话参与） */
  knownPeers?: () => string[];
}

/**
 * 周期窗口锚点与冷场标记的 per-peer 状态。
 * `windowStartedAt` 从该轮首条入池消息起算，窗口内新消息不前移（固定周期抓取语义）。
 */
interface PeerState {
  /** 本轮聚合窗口起始时间戳；窗口投递后清空，由下一条消息重新起算 */
  windowStartedAt?: number;
  /** 最后一次人类消息时间戳（含进入聚合池的消息） */
  lastHumanAt?: number;
  /** 本轮沉默周期内是否已搭过话（防死循环，人类新消息时复位） */
  idleFired: boolean;
}

export class ProactiveManager {
  private readonly states = new Map<string, PeerState>();
  private readonly pending = new Map<string, AggregatedMessage[]>();
  /** peer → 该池内消息的真实发送者 openid（用于聚合轮次登记审批发起人） */
  private readonly fromUsers = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  private stateOf(peer: string): PeerState {
    let st = this.states.get(peer);
    if (!st) {
      st = { idleFired: false };
      this.states.set(peer, st);
    }
    return st;
  }

  /** 记录一次人类发言时间戳；复位冷场标记，使下一轮沉默可再次搭话 */
  recordHumanMessage(peer: string, timestamp = Date.now()): void {
    if (!peer) return;
    const st = this.stateOf(peer);
    st.lastHumanAt = timestamp;
    st.idleFired = false;
  }

  /**
   * 将一条普通消息记入聚合池。
   * 仅在 `aggregation_enabled` 开启时生效；关闭时不入池（由上层保持即时唤醒语义）。
   * 无论是否入池，都会刷新人类发言时间，保证冷场判定准确。
   *
   * @param fromUser 该消息真实发送者 openid，用于聚合轮次登记审批发起人
   */
  recordMessage(
    peer: string,
    message: AggregatedMessage,
    config: BridgePluginConfig,
    fromUser?: string
  ): void {
    if (!peer) return;
    this.recordHumanMessage(peer, message.time);

    if (typeof fromUser === 'string' && fromUser.trim() !== '') {
      this.fromUsers.set(peer, fromUser.trim());
    }

    if (!config.aggregation_enabled) {
      return;
    }

    const st = this.stateOf(peer);
    if (st.windowStartedAt === undefined) {
      st.windowStartedAt = message.time;
    }

    const list = this.pending.get(peer) ?? [];
    list.push({ ...message });
    // 私聊不做滑动窗口：按时间升序保序，不设条数上限
    list.sort((a, b) => a.time - b.time);
    this.pending.set(peer, list);
  }

  /** 获取某单聊会话当前池内的未回复消息快照（升序，永不为 undefined） */
  getPendingMessages(peer: string): AggregatedMessage[] {
    return (this.pending.get(peer) ?? []).map((m) => ({ ...m }));
  }

  /** 原子消费并清空某会话的消息池（投递即已读，杜绝重复打扰） */
  consumePendingMessages(peer: string): AggregatedMessage[] {
    const list = this.pending.get(peer);
    this.pending.delete(peer);
    const st = this.states.get(peer);
    if (st) {
      st.windowStartedAt = undefined;
    }
    return list ? list.map((m) => ({ ...m })) : [];
  }

  /** 判断某会话的聚合窗口是否已到点（池非空且尚未投递） */
  private isAggregationDue(peer: string, config: BridgePluginConfig, now: number): boolean {
    const st = this.states.get(peer);
    if (!st || st.windowStartedAt === undefined) return false;
    const list = this.pending.get(peer);
    if (!list || list.length === 0) return false;

    const intervalMins = Number(config.aggregation_interval_mins ?? 0);
    if (!Number.isFinite(intervalMins) || intervalMins <= 0) {
      // 阈值非法或为 0：视为每轮巡检都到点，绝不因此把消息永久滞留
      return true;
    }
    return now - st.windowStartedAt >= intervalMins * 60 * 1000;
  }

  /**
   * 集中巡检：逐 peer 判定聚合投递与冷场搭话。
   * 判定优先级：聚合（池非空）> 冷场搭话，两者绝不同轮叠加。
   */
  async checkProactive(options: ProactiveManagerOptions): Promise<void> {
    const { config, dispatch } = options;
    const now = options.now ?? Date.now();
    if (!dispatch) return;
    if (!config.aggregation_enabled && !config.idle_reply_enabled) return;

    const peers = new Set<string>([
      ...this.pending.keys(),
      ...this.states.keys(),
    ]);
    if (typeof options.knownPeers === 'function') {
      for (const peer of options.knownPeers() ?? []) {
        if (typeof peer === 'string' && peer.startsWith('user_')) {
          peers.add(peer);
        }
      }
    }

    for (const peer of peers) {
      const st = this.states.get(peer);
      if (!st) continue;

      // 0. 活跃会话门控：无当前活跃会话的 peer 一律跳过（口径对齐 `/状态` 命令），
      //    池内消息与计时锚点原样保留，待会话恢复活跃后继续。
      if (options.hasActiveSession && !options.hasActiveSession(peer)) continue;

      // 1. 会话繁忙：保留池内消息与窗口计时，跳过本轮避免与进行中的回合冲突
      if (options.isSessionBusy?.(peer)) continue;

      // 2. 等待用户输入（提问 / 审批挂起）：暂停计时。
      //    把两个计时锚点持续推到当前时刻，等价于「暂停期间不计时」，
      //    恢复后的第一个巡检会把起点定在当下，重新累计完整窗口后才投递。
      if (options.isAwaitingUserInput?.(peer)) {
        if (st.windowStartedAt !== undefined) {
          st.windowStartedAt = now;
        }
        if (st.lastHumanAt !== undefined) {
          st.lastHumanAt = now;
        }
        // 暂停期间不投递、不消耗池内消息，但也不重置 idleFired：
        // 若本沉默周期已搭过话，恢复后不应立刻再搭一次。
        continue;
      }

      // 3. 聚合回复优先
      if (config.aggregation_enabled && this.isAggregationDue(peer, config, now)) {
        const messages = this.consumePendingMessages(peer);
        if (messages.length === 0) continue;
        const intervalMins = Number(config.aggregation_interval_mins ?? 0);
        const fromUser = this.fromUsers.get(peer);
        try {
          await dispatch({
            kind: 'aggregated_messages',
            peer,
            messages,
            ...(fromUser ? { fromUser } : {}),
            ...(Number.isFinite(intervalMins) && intervalMins > 0 ? { intervalMinutes: intervalMins } : {}),
            timestamp: now,
          });
        } catch {
          // 投递失败：消息已消费，绝不回滚重投（避免重复打扰）；仅静默跳过本轮
        }
        continue;
      }

      // 4. 冷场主动搭话（池为空且沉默达阈值）
      if (!config.idle_reply_enabled) continue;
      if (st.idleFired) continue;
      if (this.getPendingMessages(peer).length > 0) continue;

      const lastHumanAt = st.lastHumanAt;
      if (typeof lastHumanAt !== 'number') continue;

      const timeoutMins = Number(config.idle_reply_timeout_mins ?? 0);
      if (!Number.isFinite(timeoutMins) || timeoutMins <= 0) continue;

      const silenceMs = now - lastHumanAt;
      if (silenceMs < timeoutMins * 60 * 1000) continue;

      // 先置标记再投递：即便投递异常，本轮沉默周期内也绝不重复搭话
      st.idleFired = true;
      try {
        await dispatch({
          kind: 'idle_reply',
          peer,
          idleMinutes: timeoutMins,
          timestamp: now,
        });
      } catch {
        // 静默容错，保持标记已置位
      }
    }
  }

  /** 启动后台集中巡检定时器（默认 60 秒一次） */
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
    this.pending.clear();
    this.fromUsers.clear();
  }
}
