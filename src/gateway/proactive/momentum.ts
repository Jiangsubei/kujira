import type { ProactiveAttitude } from '../../types/config.js';

export type { ProactiveAttitude };

/**
 * 已完成的历史轮次摘要（用于宏观历史动量回溯）
 */
export interface CompletedTurnSummary {
  /** 本轮首条入站时间戳 (ms) */
  inboundAt: number;
  /** 上一轮 Bot 结束回复时间戳（无则为 null，如首轮对话或时序断裂） */
  lastBotOutboundAt: number | null;
  /** 本轮用户聚合/发送的消息条数 */
  messageCount: number;
}

/**
 * 辅助工具：将数值 clamp 在 [min, max] 范围内
 */
function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.min(Math.max(val, min), max);
}

/**
 * 计算微观单轮响应时延 Δt_turn = inboundAt - lastBotOutboundAt
 * 
 * @param inboundAt 本轮首条入站时间戳 (ms)
 * @param lastBotOutboundAt 上一轮 Bot 结束回复时间戳 (ms) | null
 * @returns 毫秒时延。若无上轮回复或时序倒流（非法），返回 null
 */
export function computeTurnDelta(
  inboundAt: number,
  lastBotOutboundAt: number | null
): number | null {
  if (
    lastBotOutboundAt === null ||
    lastBotOutboundAt === undefined ||
    !Number.isFinite(inboundAt) ||
    !Number.isFinite(lastBotOutboundAt)
  ) {
    return null;
  }

  const delta = inboundAt - lastBotOutboundAt;
  if (delta < 0) {
    // 时钟倒流或异常时序，判定为非法
    return null;
  }

  return delta;
}

/**
 * 根据微观响应时延 (ms) 评估该轮时效得分 [0, 1]
 * - delta <= 15s (15000ms): 极速接话（在席注视），得分 [0.85, 1.0]
 * - 15s < delta <= 120s (120000ms): 正常连贯对话，得分 [0.50, 0.85]
 * - delta > 120s: 摸鱼/离席/切屏，平滑指数衰减（半衰期约 5 分钟）
 */
export function scoreLatency(deltaMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return 1.0;
  }

  if (deltaMs <= 15000) {
    // 0 ~ 15s: 1.0 线性降至 0.85
    return 1.0 - (deltaMs / 15000) * 0.15;
  }

  if (deltaMs <= 120000) {
    // 15s ~ 120s: 0.85 线性降至 0.50
    const ratio = (deltaMs - 15000) / (120000 - 15000);
    return 0.85 - ratio * 0.35;
  }

  // > 120s (2分钟以上): 平滑指数衰减，300秒 (5分钟) 为衰减尺度
  const excess = deltaMs - 120000;
  const decay = Math.exp(-excess / 300000);
  return clamp(0.50 * decay, 0, 0.50);
}

/**
 * 根据单轮消息条数评估用户表达欲与消息密度得分 [0.5, 1.0]
 * - 1 条: 0.5 (基准中位)
 * - 2 条: 0.65
 * - 3 条: 0.80
 * - 4 条+: 0.95 ~ 1.0 (连发/强互动)
 */
export function scoreMessageDensity(count: number): number {
  if (!Number.isFinite(count) || count <= 1) {
    return 0.5;
  }
  const clampedCount = Math.max(1, count);
  return clamp(0.5 + (clampedCount - 1) * 0.15, 0.5, 1.0);
}

/**
 * 计算宏观历史动量 M_macro ∈ [0, 1]
 * 
 * 回溯最近 X 轮（最多 5 轮）已完成轮次，综合每轮时延与每轮消息密度；
 * 最新轮次赋予更高线性加权，平滑偶发抖动并保留连聊惯性。
 * 
 * @param recentTurns 最近已完成轮次数组
 * @returns 宏观动量值 M ∈ [0, 1]（空记录时返回 0.5 基准中位）
 */
export function computeTurnMomentum(recentTurns: CompletedTurnSummary[]): number {
  if (!recentTurns || !Array.isArray(recentTurns) || recentTurns.length === 0) {
    return 0.5; // 空记录时返回 0.5 基准中位
  }

  // 截取最近 1~5 轮
  const window = recentTurns.slice(-5);
  if (window.length === 0) {
    return 0.5;
  }

  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (let i = 0; i < window.length; i++) {
    const turn = window[i];
    const delta = computeTurnDelta(turn.inboundAt, turn.lastBotOutboundAt);
    const latencyScore = delta !== null ? scoreLatency(delta) : 0.5;
    const densityScore = scoreMessageDensity(turn.messageCount);
    const turnScore = 0.75 * latencyScore + 0.25 * densityScore;

    // 线性渐进权重：第 0 项（较早）权重 1.0，最新轮次最高达 2.0
    const weight = 1.0 + 0.25 * i;
    totalWeightedScore += turnScore * weight;
    totalWeight += weight;
  }

  const momentum = totalWeight > 0 ? totalWeightedScore / totalWeight : 0.5;
  return clamp(momentum, 0, 1);
}

/**
 * 综合微观响应与宏观历史动量，计算当前会话的综合活跃度 Score_act ∈ [0, 1]
 * 
 * @param params.turnDelta 当前轮次的微观响应时延 (ms) 或 null（若无上轮回复）
 * @param params.momentum 宏观历史动量 M ∈ [0, 1]
 * @returns 综合活跃度 Score_act ∈ [0, 1]
 */
export function computeActivityScore(params: {
  turnDelta: number | null;
  momentum: number;
}): number {
  const momentum = clamp(params.momentum, 0, 1);

  if (params.turnDelta === null) {
    // 首轮交互或断层无微观参考时，直接信赖宏观历史动量
    return momentum;
  }

  const microScore = scoreLatency(params.turnDelta);
  // 微观时效 (50%) 与宏观动量 (50%) 加权融合
  const combined = 0.5 * microScore + 0.5 * momentum;
  return clamp(combined, 0, 1);
}

/**
 * 偏好映射基准偏置指数 p
 * - enthusiastic: 2.0 (偏向 min，反应迅捷)
 * - balanced: 1.0 (均匀分布)
 * - aloof: 0.5 (偏向 max，节奏从容)
 */
const ATTITUDE_BASE_POWER: Record<ProactiveAttitude, number> = {
  enthusiastic: 2.0,
  balanced: 1.0,
  aloof: 0.5,
};

/**
 * 仿生区间采样引擎
 * 
 * 基于偏好态度 (attitude) 与当前活跃度 (activityScore)，使用幂律偏置公式在 [min, max] 内采样：
 *   Duration = min + (max - min) * (r ^ p)
 * 
 * @param min 区间最小值（如毫秒或秒）
 * @param max 区间最大值
 * @param attitude 互动偏好分段 ('enthusiastic' | 'balanced' | 'aloof')
 * @param activityScore 综合活跃度 Score_act ∈ [0, 1]
 * @param rng 可选的伪随机发生器（返回 [0, 1)），未提供时使用 Math.random
 * @returns 采样得出的时长（严格落在 [min, max] 之间）
 */
export function sampleInterval(
  min: number,
  max: number,
  attitude: ProactiveAttitude,
  activityScore: number,
  rng: () => number = Math.random
): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);

  if (low === high) {
    return low;
  }

  const basePower = ATTITUDE_BASE_POWER[attitude] ?? 1.0;
  const score = clamp(activityScore, 0, 1);

  // 活跃度微调偏置系数 p：
  // score = 0.5 时 multiplier = 1.0 (保持 basePower)
  // score = 1.0 时 multiplier = 1.3 (更偏向 min，进一步缩减等待)
  // score = 0.0 时 multiplier = 0.7 (更偏向 max，放宽等待留白)
  const powerMultiplier = 0.7 + 0.6 * score;
  const power = basePower * powerMultiplier;

  const rawR = typeof rng === 'function' ? rng() : Math.random();
  const r = clamp(rawR, 0, 1);

  const sampled = low + (high - low) * Math.pow(r, power);
  return clamp(sampled, low, high);
}

/**
 * 评估在当前轮次是否触发高热度概率秒回
 * 
 * 规则：
 * 1. enabled 为 false 时严格返回 false；
 * 2. activityScore < 0.65 时阻断，严格返回 false；
 * 3. 处于高活跃度 (activityScore >= 0.65) 时，根据偏好与热度增益按概率判定。
 * 
 * @param params.enabled 是否开启秒回功能 (instant_reply_enabled)
 * @param params.activityScore 当前会话综合活跃度
 * @param params.attitude 互动偏好分段
 * @param params.rng 可选伪随机数生成器
 * @returns 是否触发秒回
 */
export function isInstantReplyTriggered(params: {
  enabled: boolean;
  activityScore: number;
  attitude: ProactiveAttitude;
  rng?: () => number;
}): boolean {
  if (!params.enabled) {
    return false;
  }

  const score = params.activityScore;
  if (!Number.isFinite(score) || score < 0.65) {
    return false;
  }

  // 偏好基础触发概率
  const BASE_PROBABILITY: Record<ProactiveAttitude, number> = {
    enthusiastic: 0.60,
    balanced: 0.40,
    aloof: 0.20,
  };

  const baseP = BASE_PROBABILITY[params.attitude] ?? 0.40;
  // 活跃度由 0.65 升至 1.0 时，附加最高 0.25 概率加成
  const normalizedGain = clamp((score - 0.65) / 0.35, 0, 1) * 0.25;
  const triggerProb = clamp(baseP + normalizedGain, 0, 0.90);

  const rawR = typeof params.rng === 'function' ? params.rng() : Math.random();
  const r = clamp(rawR, 0, 1);

  return r < triggerProb;
}

/**
 * 从历史消息记录切片中提取上一轮 Bot 回复时刻与已完成轮次摘要（用于装配接线）
 */
export function extractRecentTurnsFromRecords(
  records: Array<{ self: boolean | number; time: number }>
): {
  lastBotOutboundAt: number | null;
  recentTurns: CompletedTurnSummary[];
} {
  if (!records || !Array.isArray(records) || records.length === 0) {
    return { lastBotOutboundAt: null, recentTurns: [] };
  }

  const sorted = [...records].sort((a, b) => a.time - b.time);
  let lastBotTime: number | null = null;
  const turns: CompletedTurnSummary[] = [];

  let currentTurnInboundAt: number | null = null;
  let currentTurnCount = 0;

  for (const msg of sorted) {
    const isBot = msg.self === true || msg.self === 1;
    if (isBot) {
      if (currentTurnInboundAt !== null && currentTurnCount > 0) {
        turns.push({
          inboundAt: currentTurnInboundAt,
          lastBotOutboundAt: lastBotTime,
          messageCount: currentTurnCount,
        });
        currentTurnInboundAt = null;
        currentTurnCount = 0;
      }
      lastBotTime = msg.time;
    } else {
      if (currentTurnInboundAt === null) {
        currentTurnInboundAt = msg.time;
      }
      currentTurnCount++;
    }
  }

  return {
    lastBotOutboundAt: lastBotTime,
    recentTurns: turns,
  };
}
