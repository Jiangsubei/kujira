/**
 * kujira: 单聊仿生时序主动能力管理器 (ProactiveManager)
 *
 * 只服务 QQ 官方 Bot 单聊（C2C），管理两件彼此解耦的事：
 *   1. 仿生消息聚合回复：基于 Peer 独立的事件驱动时序器，结合历史动量、
 *      温和折减（25%）、下限锁定与高热度概率秒回；
 *   2. 仿生潜水主动搭话：长时间无新消息时，在随机区间 [T_idle_min, T_idle_max] 内
 *      采样潜水目标时刻，由系统自发唤醒模型主动发起话题。
 *
 * 核心设计：
 *   - **纯内存消息池**：池只装「尚未投递」的真实入站消息，投递成功后清空；
 *   - **Peer 独立事件驱动**：彻底废弃全局固定自由时钟，每 Peer 独立维护时钟与下限锁定状态；
 *   - **温和折减与下限锁定**：周期内新消息温和折减 25% 剩余时间；一旦触及底限锁定，
 *     后续新消息绝不推迟，到点自然释放，彻底防饥饿并保障拟人插话体感；
 *   - **秒回机制**：连续热聊高活跃度下支持概率秒回（targetWakeupAt = now）；
 *   - **等待用户输入时暂停**：提问/审批挂起期间跳过 tick 与 flush，池与时序完整保留。
 */

import type { AggregatedMessage, BridgePluginConfig, ProactiveAttitude } from '../types/index.js';
import type { SystemWakeupEvent } from '../types/system-event.js';
import {
  DEFAULT_AGGREGATION_ENABLED,
  DEFAULT_AGGREGATION_MIN_SECONDS,
  DEFAULT_AGGREGATION_MAX_SECONDS,
  DEFAULT_IDLE_REPLY_ENABLED,
  DEFAULT_IDLE_REPLY_MIN_MINS,
  DEFAULT_IDLE_REPLY_MAX_MINS,
  DEFAULT_PROACTIVE_ATTITUDE,
  DEFAULT_INSTANT_REPLY_ENABLED,
} from '../constants/index.js';
import {
  computeTurnDelta,
  computeTurnMomentum,
  computeActivityScore,
  sampleInterval,
  isInstantReplyTriggered,
  type CompletedTurnSummary,
} from './proactive/momentum.js';

export type { CompletedTurnSummary, ProactiveAttitude };

/** 消息入池时的可选上下文（微观时延、历史动量、时间与运行状态） */
export interface RecordMessageContext {
  recentTurns?: CompletedTurnSummary[];
  lastBotOutboundAt?: number | null;
  now?: number;
  isAgentRunning?: boolean;
  config?: BridgePluginConfig;
  rng?: () => number;
}

/** Peer 时序状态只读快照（供契约测试断言） */
export interface PeerTimingSnapshot {
  cycleStartTime: number | null;
  targetWakeupAt: number | null;
  floorWakeupAt: number | null;
  isFloorLocked: boolean;
  idleTargetWakeupAt: number | null;
  lastIdleWakeupAt: number | null;
  pendingCount: number;
  delivering: boolean;
}

export interface ProactiveManagerOptions {
  config: BridgePluginConfig;
  /** 统一投递入口：真实装配下由 SystemEventHub.dispatchSystemEvent 承接 */
  dispatch?: (event: SystemWakeupEvent) => Promise<unknown> | unknown;
  /**
   * 是否正在等待用户输入（提问 / 审批挂起）。
   * 返回 true 时跳过本轮 tick 与 flush，池与时序完整保留。
   */
  isAwaitingUserInput?: (peer: string) => boolean;
  /**
   * 该 peer 的 Agent 当前是否正在运行一轮。
   * 返回 true 时 tick 绝不打断，池保留到 `turn/end` flush。
   */
  isAgentRunning?: (peer: string) => boolean;
  /**
   * 该 peer 是否存在当前活跃会话。
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
   * 取该 peer 最后一条入站消息时间（毫秒）；无记录返回 null。
   * 以数据库为准，进程重启后沉默时长依然准确。
   */
  lastHumanMessageAt?: (peer: string) => number | null;
  /** 取该 peer 上一轮 Bot 出站回复时间（毫秒）；无记录返回 null */
  lastBotOutboundAt?: (peer: string) => number | null;
  /** 取该 peer 最近已完成轮次摘要（用于宏观动量计算） */
  recentTurns?: (peer: string) => CompletedTurnSummary[];
  /** 枚举「曾经真实互动过」的 peer（peer_openid_map 中已登记的），用于冷场搭话扫描 */
  knownPeers?: () => string[];
  now?: number;
  /** 可选的自定义伪随机生成器，用于确定性单测断言 */
  rng?: () => number;
}

/** 每 peer 的独立池与时序状态 */
interface PeerState {
  /** 尚未投递的消息（按时间升序） */
  pending: AggregatedMessage[];
  /** 池内最后一位真实发送者 openid（用于聚合轮次登记审批发起人） */
  lastFromUser?: string;
  /** 投递单飞锁：同一 peer 任何时刻只允许一个投递在途 */
  delivering: boolean;
  /** 上次冷场唤醒时刻（毫秒），null 表示进程内尚未冷场唤醒过 */
  lastIdleWakeupAt: number | null;
  /** 聚合周期启动时刻（毫秒），null 表示当前无活动聚合周期 */
  cycleStartTime: number | null;
  /** 当前目标触发时刻（毫秒） */
  targetWakeupAt: number | null;
  /** 绝对硬底线时刻（毫秒，cycleStartTime + T_min） */
  floorWakeupAt: number | null;
  /** 是否已触底下限锁定 */
  isFloorLocked: boolean;
  /** 目标冷场唤醒时刻（毫秒） */
  idleTargetWakeupAt: number | null;
  /** 上次计算潜水目标所依据的沉默基准时刻（毫秒） */
  lastSampledBaseTime: number | null;
}

/**
 * 入站消息是否应进入聚合池（而非即时唤醒）。
 *
 * - 聚合关闭：不入池，走原有即时链路；
 * - 聚合开启且 Agent 正在运行：
 *   - `steer`：即时插话，不入池；
 *   - `queue`：入池，等本轮 `turn/end` 一次性注入；
 * - 聚合开启且空闲：入池，等事件驱动倒计时到点。
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

interface ResolvedProactiveConfig {
  aggregation_enabled: boolean;
  aggregation_min_seconds: number;
  aggregation_max_seconds: number;
  idle_reply_enabled: boolean;
  idle_reply_min_mins: number;
  idle_reply_max_mins: number;
  proactive_attitude: ProactiveAttitude;
  instant_reply_enabled: boolean;
}

function resolveProactiveConfig(cfg?: BridgePluginConfig): ResolvedProactiveConfig {
  const c = cfg ?? {};

  const hasMinMins = typeof c.idle_reply_min_mins === 'number';
  const hasMaxMins = typeof c.idle_reply_max_mins === 'number';
  const legacyTimeoutMins =
    typeof (c as any).idle_reply_timeout_mins === 'number'
      ? (c as any).idle_reply_timeout_mins
      : undefined;

  let idleMinMins = hasMinMins ? c.idle_reply_min_mins! : DEFAULT_IDLE_REPLY_MIN_MINS;
  let idleMaxMins = hasMaxMins ? c.idle_reply_max_mins! : DEFAULT_IDLE_REPLY_MAX_MINS;

  if (!hasMinMins && !hasMaxMins && legacyTimeoutMins !== undefined) {
    idleMinMins = legacyTimeoutMins;
    idleMaxMins = legacyTimeoutMins;
  }

  const hasMinSec = typeof c.aggregation_min_seconds === 'number';
  const hasMaxSec = typeof c.aggregation_max_seconds === 'number';
  const legacyIntervalMins =
    typeof (c as any).aggregation_interval_mins === 'number'
      ? (c as any).aggregation_interval_mins
      : undefined;

  let aggMinSec = hasMinSec ? c.aggregation_min_seconds! : DEFAULT_AGGREGATION_MIN_SECONDS;
  let aggMaxSec = hasMaxSec ? c.aggregation_max_seconds! : DEFAULT_AGGREGATION_MAX_SECONDS;

  if (!hasMinSec && !hasMaxSec && legacyIntervalMins !== undefined) {
    aggMinSec = legacyIntervalMins * 60;
    aggMaxSec = legacyIntervalMins * 60;
  }

  return {
    aggregation_enabled: Boolean(c.aggregation_enabled ?? DEFAULT_AGGREGATION_ENABLED),
    aggregation_min_seconds: aggMinSec,
    aggregation_max_seconds: aggMaxSec,
    idle_reply_enabled: Boolean(c.idle_reply_enabled ?? DEFAULT_IDLE_REPLY_ENABLED),
    idle_reply_min_mins: idleMinMins,
    idle_reply_max_mins: idleMaxMins,
    proactive_attitude: (c.proactive_attitude as ProactiveAttitude) || DEFAULT_PROACTIVE_ATTITUDE,
    instant_reply_enabled: Boolean(c.instant_reply_enabled ?? DEFAULT_INSTANT_REPLY_ENABLED),
  };
}

export class ProactiveManager {
  private readonly states = new Map<string, PeerState>();
  private timer: NodeJS.Timeout | null = null;
  private lastOptions?: ProactiveManagerOptions;

  constructor(private defaultOptions?: ProactiveManagerOptions) {}

  private stateOf(peer: string): PeerState {
    let st = this.states.get(peer);
    if (!st) {
      st = {
        pending: [],
        delivering: false,
        lastIdleWakeupAt: null,
        cycleStartTime: null,
        targetWakeupAt: null,
        floorWakeupAt: null,
        isFloorLocked: false,
        idleTargetWakeupAt: null,
        lastSampledBaseTime: null,
      };
      this.states.set(peer, st);
    }
    return st;
  }

  /**
   * 记录一条尚未投递的入站消息：入池、刷新发送者，并在 Agent 空闲时驱动仿生时序器。
   */
  recordMessage(
    peer: string,
    message: AggregatedMessage,
    fromUser?: string,
    context?: RecordMessageContext
  ): void {
    if (!peer || !message) return;
    const st = this.stateOf(peer);
    st.pending.push(cloneMessage(message));
    st.pending.sort((a, b) => a.time - b.time);
    const uid = typeof fromUser === 'string' ? fromUser.trim() : '';
    if (uid) st.lastFromUser = uid;

    // 用户有新入站消息：会话已活跃，历史潜水搭话闹钟立即失效作废
    st.idleTargetWakeupAt = null;
    st.lastSampledBaseTime = null;

    const config = resolveProactiveConfig(
      context?.config ?? this.defaultOptions?.config ?? this.lastOptions?.config
    );
    const isAgentRunning =
      context?.isAgentRunning ??
      this.defaultOptions?.isAgentRunning?.(peer) ??
      this.lastOptions?.isAgentRunning?.(peer) ??
      false;

    // 若 Agent 正在运行：消息只入池排队，等待 turn/end flush，绝不启动或修改时钟
    if (isAgentRunning) {
      return;
    }

    const now =
      context?.now ??
      (typeof message.time === 'number' && message.time > 0 ? message.time : Date.now());

    const minSec = Math.max(1, config.aggregation_min_seconds);
    const maxSec = Math.max(minSec, config.aggregation_max_seconds);
    const minMs = minSec * 1000;
    const maxMs = maxSec * 1000;
    const attitude = config.proactive_attitude;
    const rng = context?.rng ?? this.defaultOptions?.rng ?? this.lastOptions?.rng ?? Math.random;

    if (st.cycleStartTime === null) {
      // 首条入站消息：事件驱动启动新聚合周期
      const lastBotOutboundAt =
        context?.lastBotOutboundAt ??
        this.defaultOptions?.lastBotOutboundAt?.(peer) ??
        this.lastOptions?.lastBotOutboundAt?.(peer) ??
        null;
      const recentTurns =
        context?.recentTurns ??
        this.defaultOptions?.recentTurns?.(peer) ??
        this.lastOptions?.recentTurns?.(peer) ??
        [];
      const turnDelta = computeTurnDelta(now, lastBotOutboundAt);
      const momentum = computeTurnMomentum(recentTurns);
      const activityScore = computeActivityScore({ turnDelta, momentum });

      if (
        config.instant_reply_enabled &&
        isInstantReplyTriggered({
          enabled: true,
          activityScore,
          attitude,
          rng,
        })
      ) {
        // 命中高热度秒回：targetWakeupAt 设为当前时刻，即刻到点
        st.cycleStartTime = now;
        st.targetWakeupAt = now;
        st.floorWakeupAt = now;
        st.isFloorLocked = true;
      } else {
        // 常规聚合区间采样
        const durationMs = sampleInterval(minMs, maxMs, attitude, activityScore, rng);
        st.cycleStartTime = now;
        st.targetWakeupAt = now + durationMs;
        st.floorWakeupAt = now + minMs;
        st.isFloorLocked = st.targetWakeupAt <= st.floorWakeupAt;
      }
    } else {
      // 周期内追加新消息：温和折减 25% 与下限锁定
      if (st.isFloorLocked) {
        // 已触底下限锁定：绝不推迟、绝不改动 targetWakeupAt
        return;
      }

      const remaining = Math.max(0, (st.targetWakeupAt ?? now) - now);
      const newRemaining = remaining * 0.75;
      const newTarget = now + newRemaining;
      const floor = st.floorWakeupAt ?? (st.cycleStartTime + minMs);

      if (newTarget <= floor) {
        st.targetWakeupAt = floor;
        st.isFloorLocked = true;
      } else {
        st.targetWakeupAt = newTarget;
      }
    }
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

  /** 获取 Peer 时序状态只读快照（供契约测试断言） */
  getPeerTiming(peer: string): PeerTimingSnapshot | null {
    const st = this.states.get(peer);
    if (!st) return null;
    return {
      cycleStartTime: st.cycleStartTime,
      targetWakeupAt: st.targetWakeupAt,
      floorWakeupAt: st.floorWakeupAt,
      isFloorLocked: st.isFloorLocked,
      idleTargetWakeupAt: st.idleTargetWakeupAt,
      lastIdleWakeupAt: st.lastIdleWakeupAt,
      pendingCount: st.pending.length,
      delivering: st.delivering,
    };
  }

  /** 清空某会话全部状态（会话被外部删除等场景） */
  clearPeer(peer: string): void {
    this.states.delete(peer);
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
      await dispatch({
        kind: 'aggregated_messages',
        peer,
        messages: batch,
        reason,
        ...(st.lastFromUser ? { fromUser: st.lastFromUser } : {}),
        timestamp: now,
      });
      // 只移除本次快照，投递期间新到的消息保留
      st.pending = st.pending.filter((message) => !originals.includes(message));
      return true;
    } catch {
      // 投递失败整批保留，下一次重试
      return false;
    } finally {
      st.delivering = false;
    }
  }

  /**
   * 轮次结束（`turn/end`）时投递排队消息。
   * 投递成功后重置周期时钟与潜水闹钟。
   */
  async flushPendingMessages(peer: string, options: ProactiveManagerOptions): Promise<boolean> {
    this.lastOptions = options;
    const config = resolveProactiveConfig(options.config);
    if (!config.aggregation_enabled || !options.dispatch) return false;

    const st = this.states.get(peer);
    if (!st || st.pending.length === 0) {
      if (st) {
        st.cycleStartTime = null;
        st.targetWakeupAt = null;
        st.floorWakeupAt = null;
        st.isFloorLocked = false;
        st.idleTargetWakeupAt = null;
        st.lastSampledBaseTime = null;
      }
      return false;
    }
    if (st.delivering) return false;
    if (options.isAwaitingUserInput?.(peer)) return false;

    if (options.hasActiveSession && !options.hasActiveSession(peer)) {
      const ready = await options.ensureSession?.(peer);
      if (!ready) return false;
    }

    const delivered = await this.deliverPending(peer, st, 'turn_end', options);
    if (delivered) {
      st.cycleStartTime = null;
      st.targetWakeupAt = null;
      st.floorWakeupAt = null;
      st.isFloorLocked = false;
      st.idleTargetWakeupAt = null;
      st.lastSampledBaseTime = null;
    }
    return delivered;
  }

  /**
   * 集中巡检：遍历各 peer，检查聚合事件驱动到点与仿生潜水搭话。
   */
  async checkProactive(options: ProactiveManagerOptions): Promise<void> {
    this.lastOptions = options;
    const { dispatch } = options;
    if (!dispatch) return;

    const config = resolveProactiveConfig(options.config);
    const now = options.now ?? Date.now();
    const aggregationEnabled = config.aggregation_enabled;
    const idleEnabled = config.idle_reply_enabled;

    // 聚合关闭：池失去投递通道，直接清空并重置聚合时钟
    if (!aggregationEnabled) {
      for (const st of this.states.values()) {
        st.pending = [];
        st.lastFromUser = undefined;
        st.cycleStartTime = null;
        st.targetWakeupAt = null;
        st.floorWakeupAt = null;
        st.isFloorLocked = false;
      }
    }

    if (!aggregationEnabled && !idleEnabled) return;

    // ---- 1. 聚合回复：事件驱动倒计时到点触发 ----
    const deliveredThisTick = new Set<string>();
    if (aggregationEnabled) {
      for (const [peer, st] of this.states) {
        if (st.pending.length === 0) {
          st.cycleStartTime = null;
          st.targetWakeupAt = null;
          st.floorWakeupAt = null;
          st.isFloorLocked = false;
          continue;
        }

        // 门控检查：等待用户输入期间跳过，保留池与时钟
        if (options.isAwaitingUserInput?.(peer)) continue;
        // Agent 正在运行：绝不打断，池保留到 turn/end flush
        if (options.isAgentRunning?.(peer)) continue;

        // 若时序尚未初始化（如运行中入池或首条入池时未获配置），在此补齐初始化
        if (st.cycleStartTime === null) {
          const firstMsgTime = st.pending[0]?.time ?? now;
          const cycleStart = Math.min(now, firstMsgTime);
          const minSec = Math.max(1, config.aggregation_min_seconds);
          const maxSec = Math.max(minSec, config.aggregation_max_seconds);
          const minMs = minSec * 1000;
          const maxMs = maxSec * 1000;
          const durationMs = sampleInterval(
            minMs,
            maxMs,
            config.proactive_attitude,
            0.5,
            options.rng
          );
          st.cycleStartTime = cycleStart;
          st.targetWakeupAt = cycleStart + durationMs;
          st.floorWakeupAt = cycleStart + minMs;
          st.isFloorLocked = st.targetWakeupAt <= st.floorWakeupAt;
        }

        // 到点检查
        if (st.targetWakeupAt !== null && now < st.targetWakeupAt) {
          continue;
        }

        // 无活跃会话：尝试建立，失败保留待重试
        if (options.hasActiveSession && !options.hasActiveSession(peer)) {
          const ready = await options.ensureSession?.(peer);
          if (!ready) continue;
        }

        const delivered = await this.deliverPending(peer, st, 'period', options);
        if (delivered) {
          deliveredThisTick.add(peer);
          st.cycleStartTime = null;
          st.targetWakeupAt = null;
          st.floorWakeupAt = null;
          st.isFloorLocked = false;
          st.idleTargetWakeupAt = null;
          st.lastSampledBaseTime = null;
        }
      }
    }

    // ---- 2. 仿生潜水主动搭话：独立于聚合时钟 ----
    if (!idleEnabled) return;

    const minMins = Math.max(1, config.idle_reply_min_mins);
    const maxMins = Math.max(minMins, config.idle_reply_max_mins);
    const idleMinMs = minMins * 60 * 1000;
    const idleMaxMs = maxMins * 60 * 1000;

    const candidates = new Set<string>(this.states.keys());
    for (const peer of options.knownPeers?.() ?? []) {
      if (typeof peer === 'string') candidates.add(peer);
    }

    for (const peer of candidates) {
      const st = this.stateOf(peer);

      // 本轮刚投递过聚合：绝不在同一轮叠加搭话
      if (deliveredThisTick.has(peer)) continue;
      // 池内有未投递消息时优先让聚合处理，绝不叠加搭话
      if (aggregationEnabled && st.pending.length > 0) continue;
      // 等待用户输入期间同样暂停搭话（不消耗冷场周期，恢复后仍可触发）
      if (options.isAwaitingUserInput?.(peer)) continue;
      // Agent 正在运行：绝不打断，等待当前轮次完成（彻底杜绝在思考/生成时插队唤醒）
      if (options.isAgentRunning?.(peer)) continue;

      // 沉默起点以库中最新入站消息时间为准，重启后依然准确。出站消息不写入该时间。
      const lastHumanAt = options.lastHumanMessageAt?.(peer) ?? null;
      if (typeof lastHumanAt !== 'number') continue;

      // 核心硬底线：当前距离用户最新消息不足潜水下限时长（idle_reply_min_mins）时，严格跳过，绝不搭话
      if (now - lastHumanAt < idleMinMs) continue;

      // 沉默基准时刻：若有过冷场唤醒，取两者较晚者；若无冷场唤醒记录，直接取 lastHumanAt
      const baseSilenceTime =
        typeof st.lastIdleWakeupAt === 'number'
          ? Math.max(lastHumanAt, st.lastIdleWakeupAt)
          : lastHumanAt;

      // 距离最近唤醒或最新入站基准同样须满足最小潜水时长
      if (now - baseSilenceTime < idleMinMs) continue;

      // 若尚未设置潜水唤醒目标或基准时刻已发生变化（人类新发消息或刚刚冷场唤醒），重新在 [T_min, T_max] 采样
      if (st.idleTargetWakeupAt === null || st.lastSampledBaseTime !== baseSilenceTime) {
        const idleDurationMs = sampleInterval(
          idleMinMs,
          idleMaxMs,
          config.proactive_attitude,
          0.5,
          options.rng
        );
        st.idleTargetWakeupAt = baseSilenceTime + idleDurationMs;
        st.lastSampledBaseTime = baseSilenceTime;
      }

      // 未达潜水唤醒目标时刻：不搭话
      if (now < st.idleTargetWakeupAt) continue;

      // 会话不存在时尝试建立，建立失败不记唤醒时刻，下一轮巡检重试
      if (options.hasActiveSession && !options.hasActiveSession(peer)) {
        const ready = await options.ensureSession?.(peer);
        if (!ready) continue;
      }

      // 触发唤醒：记录唤醒时刻，清空潜水目标（下次巡检将基于新 baseSilenceTime 采样）
      st.lastIdleWakeupAt = now;
      st.idleTargetWakeupAt = null;
      st.lastSampledBaseTime = null;
      const idleMinutes = Math.max(minMins, Math.round((now - lastHumanAt) / 60_000));

      try {
        await dispatch({
          kind: 'idle_reply',
          peer,
          idleMinutes,
          timestamp: now,
        });
      } catch {
        // 静默容错，唤醒时刻保持已记下
      }
    }
  }

  /** 启动后台巡检定时器（默认 60 秒扫描一次） */
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
  }
}
