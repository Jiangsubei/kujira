import { describe, expect, it } from 'vitest';
import {
  computeTurnDelta,
  scoreLatency,
  scoreMessageDensity,
  computeTurnMomentum,
  computeActivityScore,
  sampleInterval,
  isInstantReplyTriggered,
  extractRecentTurnsFromRecords,
  type CompletedTurnSummary,
} from '../../src/gateway/proactive/momentum';

describe('仿生动态时钟与动量计算 (Momentum & Activity)', () => {
  describe('1. 微观响应时延计算 computeTurnDelta', () => {
    it('正常计算两个时间戳之间的正向时延 (ms)', () => {
      const inboundAt = 1700000010000;
      const lastBotOutboundAt = 1700000005000;
      expect(computeTurnDelta(inboundAt, lastBotOutboundAt)).toBe(5000);
    });

    it('零时延时合法返回 0', () => {
      const now = 1700000010000;
      expect(computeTurnDelta(now, now)).toBe(0);
    });

    it('无上一轮回复 (lastBotOutboundAt 为 null 或 undefined) 时返回 null', () => {
      expect(computeTurnDelta(1700000010000, null)).toBeNull();
      expect(computeTurnDelta(1700000010000, undefined as unknown as null)).toBeNull();
    });

    it('时序倒流 (inboundAt < lastBotOutboundAt) 判定为非法并返回 null', () => {
      const inboundAt = 1700000001000;
      const lastBotOutboundAt = 1700000005000;
      expect(computeTurnDelta(inboundAt, lastBotOutboundAt)).toBeNull();
    });

    it('输入 NaN 或非数值时安全返回 null', () => {
      expect(computeTurnDelta(NaN, 1700000005000)).toBeNull();
      expect(computeTurnDelta(1700000005000, NaN)).toBeNull();
      expect(computeTurnDelta(Infinity, 1700000005000)).toBeNull();
    });
  });

  describe('2. 时延与消息密度评分 scoreLatency & scoreMessageDensity', () => {
    it('scoreLatency: 15s 以内处于在席高分区 (0.85 ~ 1.0)', () => {
      expect(scoreLatency(0)).toBe(1.0);
      expect(scoreLatency(3000)).toBeCloseTo(0.97, 2);
      expect(scoreLatency(15000)).toBeCloseTo(0.85, 2);
    });

    it('scoreLatency: 15s ~ 120s 处于正常连贯区间 (0.50 ~ 0.85)', () => {
      expect(scoreLatency(30000)).toBeCloseTo(0.80, 2);
      expect(scoreLatency(60000)).toBeCloseTo(0.70, 2);
      expect(scoreLatency(120000)).toBeCloseTo(0.50, 2);
    });

    it('scoreLatency: 超过 2 分钟呈指数平滑衰减，数小时后趋于 0', () => {
      const score5m = scoreLatency(300000); // 5 分钟
      expect(score5m).toBeLessThan(0.50);
      expect(score5m).toBeGreaterThan(0.20);

      const score30m = scoreLatency(1800000); // 30 分钟
      expect(score30m).toBeLessThan(0.05);

      const score3h = scoreLatency(3 * 3600 * 1000); // 3 小时
      expect(score3h).toBeCloseTo(0, 3);
    });

    it('scoreMessageDensity: 阶梯加成单轮表达欲', () => {
      expect(scoreMessageDensity(1)).toBe(0.5); // 单条消息基准中位
      expect(scoreMessageDensity(2)).toBe(0.65);
      expect(scoreMessageDensity(3)).toBe(0.80);
      expect(scoreMessageDensity(4)).toBe(0.95);
      expect(scoreMessageDensity(10)).toBe(1.0); // 饱和上限
      expect(scoreMessageDensity(0)).toBe(0.5); // 异常容错
    });
  });

  describe('3. 宏观历史动量计算 computeTurnMomentum', () => {
    it('空记录或无效入参时返回 0.5 基准中位', () => {
      expect(computeTurnMomentum([])).toBe(0.5);
      expect(computeTurnMomentum(null as unknown as CompletedTurnSummary[])).toBe(0.5);
      expect(computeTurnMomentum(undefined as unknown as CompletedTurnSummary[])).toBe(0.5);
    });

    it('快速连续接话场景：多轮秒回与连发使宏观动量稳定在高位 (> 0.8)', () => {
      const baseTime = 1700000000000;
      const rapidTurns: CompletedTurnSummary[] = [
        { inboundAt: baseTime + 5000, lastBotOutboundAt: baseTime, messageCount: 2 },
        { inboundAt: baseTime + 15000, lastBotOutboundAt: baseTime + 10000, messageCount: 1 },
        { inboundAt: baseTime + 26000, lastBotOutboundAt: baseTime + 20000, messageCount: 3 },
        { inboundAt: baseTime + 38000, lastBotOutboundAt: baseTime + 32000, messageCount: 2 },
      ];

      const momentum = computeTurnMomentum(rapidTurns);
      expect(momentum).toBeGreaterThan(0.80);
      expect(momentum).toBeLessThanOrEqual(1.0);
    });

    it('隔几小时慢回场景：宏观动量跌入低位 (< 0.25)', () => {
      const baseTime = 1700000000000;
      const hour = 3600 * 1000;
      const slowTurns: CompletedTurnSummary[] = [
        { inboundAt: baseTime + 2 * hour, lastBotOutboundAt: baseTime, messageCount: 1 },
        { inboundAt: baseTime + 5 * hour, lastBotOutboundAt: baseTime + 2 * hour + 5000, messageCount: 1 },
        { inboundAt: baseTime + 10 * hour, lastBotOutboundAt: baseTime + 5 * hour + 5000, messageCount: 1 },
      ];

      const momentum = computeTurnMomentum(slowTurns);
      expect(momentum).toBeLessThan(0.25);
      expect(momentum).toBeGreaterThanOrEqual(0.0);
    });

    it('平滑机制：4 轮冷场后突然出现 1 次秒回，动量平滑回升而不暴增', () => {
      const baseTime = 1700000000000;
      const hour = 3600 * 1000;
      const turns: CompletedTurnSummary[] = [
        { inboundAt: baseTime + 1 * hour, lastBotOutboundAt: baseTime, messageCount: 1 },
        { inboundAt: baseTime + 3 * hour, lastBotOutboundAt: baseTime + 1 * hour + 5000, messageCount: 1 },
        { inboundAt: baseTime + 6 * hour, lastBotOutboundAt: baseTime + 3 * hour + 5000, messageCount: 1 },
        { inboundAt: baseTime + 9 * hour, lastBotOutboundAt: baseTime + 6 * hour + 5000, messageCount: 1 },
        // 最新一轮突然秒回 (4秒) 且连发 2 条
        { inboundAt: baseTime + 9 * hour + 9000, lastBotOutboundAt: baseTime + 9 * hour + 5000, messageCount: 2 },
      ];

      const momentum = computeTurnMomentum(turns);
      // 受历史 4 轮沉淀制约，动量平滑回升，保持在温和回暖区间，未直接窜至极热 (> 0.6)
      expect(momentum).toBeGreaterThan(0.25);
      expect(momentum).toBeLessThan(0.45);
    });

    it('平滑机制：4 轮热聊后出现 1 次稍慢回 (3分钟)，动量平滑维持而不断崖暴跌', () => {
      const baseTime = 1700000000000;
      const turns: CompletedTurnSummary[] = [
        { inboundAt: baseTime + 5000, lastBotOutboundAt: baseTime, messageCount: 2 },
        { inboundAt: baseTime + 15000, lastBotOutboundAt: baseTime + 10000, messageCount: 3 },
        { inboundAt: baseTime + 28000, lastBotOutboundAt: baseTime + 22000, messageCount: 2 },
        { inboundAt: baseTime + 40000, lastBotOutboundAt: baseTime + 35000, messageCount: 2 },
        // 最新一轮等待了 3 分钟 (180,000 ms)
        { inboundAt: baseTime + 220000, lastBotOutboundAt: baseTime + 40000, messageCount: 1 },
      ];

      const momentum = computeTurnMomentum(turns);
      // 依然维持在较高热聊惯性区间
      expect(momentum).toBeGreaterThan(0.65);
    });

    it('窗口回溯：超过 5 轮时仅保留最近 5 轮并给予最新轮更高权重', () => {
      const baseTime = 1700000000000;
      const hour = 3600 * 1000;
      // 构造前面多轮冷淡，而最近 5 轮全是极速连聊
      const manyTurns: CompletedTurnSummary[] = [
        { inboundAt: baseTime + 1 * hour, lastBotOutboundAt: baseTime, messageCount: 1 },
        { inboundAt: baseTime + 2 * hour, lastBotOutboundAt: baseTime + 1 * hour, messageCount: 1 },
        { inboundAt: baseTime + 3 * hour, lastBotOutboundAt: baseTime + 2 * hour, messageCount: 1 },
        // 最近 5 轮极热
        { inboundAt: baseTime + 3 * hour + 5000, lastBotOutboundAt: baseTime + 3 * hour, messageCount: 2 },
        { inboundAt: baseTime + 3 * hour + 15000, lastBotOutboundAt: baseTime + 3 * hour + 10000, messageCount: 2 },
        { inboundAt: baseTime + 3 * hour + 25000, lastBotOutboundAt: baseTime + 3 * hour + 20000, messageCount: 2 },
        { inboundAt: baseTime + 3 * hour + 35000, lastBotOutboundAt: baseTime + 3 * hour + 30000, messageCount: 2 },
        { inboundAt: baseTime + 3 * hour + 45000, lastBotOutboundAt: baseTime + 3 * hour + 40000, messageCount: 2 },
      ];

      const momentum = computeTurnMomentum(manyTurns);
      // 前 3 轮冷淡记录被滑动窗口排除，动量由最近 5 轮主导
      expect(momentum).toBeGreaterThan(0.80);
    });
  });

  describe('4. 综合活跃度评分 computeActivityScore', () => {
    it('无微观响应时延 (turnDelta 为 null) 时直接继承宏观历史动量', () => {
      expect(computeActivityScore({ turnDelta: null, momentum: 0.72 })).toBeCloseTo(0.72, 4);
      expect(computeActivityScore({ turnDelta: null, momentum: 0.35 })).toBeCloseTo(0.35, 4);
    });

    it('微观秒回 (3s) + 宏观高热 (0.90) => 极高综合得分 (> 0.90)', () => {
      const score = computeActivityScore({ turnDelta: 3000, momentum: 0.90 });
      expect(score).toBeGreaterThan(0.90);
    });

    it('微观秒回 (3s) + 宏观冷场 (0.20) => 温和受抑得分 (约 0.58)，避免单次偶发冲顶', () => {
      const score = computeActivityScore({ turnDelta: 3000, momentum: 0.20 });
      expect(score).toBeGreaterThan(0.50);
      expect(score).toBeLessThan(0.65);
    });

    it('微观离席 (2小时) + 宏观高热 (0.85) => 活跃度被实时拉低 (< 0.45)', () => {
      const score = computeActivityScore({ turnDelta: 2 * 3600 * 1000, momentum: 0.85 });
      expect(score).toBeLessThan(0.45);
    });

    it('数值超界时安全 clamp 到 [0, 1]', () => {
      expect(computeActivityScore({ turnDelta: null, momentum: 1.5 })).toBe(1.0);
      expect(computeActivityScore({ turnDelta: null, momentum: -0.5 })).toBe(0.0);
    });
  });

  describe('5. 仿生区间采样引擎 sampleInterval', () => {
    it('边界情况：min === max 时恒定返回该值', () => {
      expect(sampleInterval(30, 30, 'enthusiastic', 0.8)).toBe(30);
      expect(sampleInterval(15, 15, 'balanced', 0.2)).toBe(15);
    });

    it('边界情况：min > max 时自动纠正并保证落在 [max, min] 之间', () => {
      const sampled = sampleInterval(60, 10, 'balanced', 0.5, () => 0.4);
      expect(sampled).toBeGreaterThanOrEqual(10);
      expect(sampled).toBeLessThanOrEqual(60);
    });

    it('固定 rng 下偏好态度比较：enthusiastic 偏向 min，aloof 偏向 max', () => {
      // 当 r = 0.5, score = 0.5 时：
      // enthusiastic: p = 2.0, r^2 = 0.25 -> 偏向 10
      // balanced: p = 1.0, r^1 = 0.50 -> 35
      // aloof: p = 0.5, r^0.5 ≈ 0.707 -> 偏向 60
      const min = 10;
      const max = 60;
      const rngMid = () => 0.5;

      const valEnthusiastic = sampleInterval(min, max, 'enthusiastic', 0.5, rngMid);
      const valBalanced = sampleInterval(min, max, 'balanced', 0.5, rngMid);
      const valAloof = sampleInterval(min, max, 'aloof', 0.5, rngMid);

      expect(valEnthusiastic).toBeCloseTo(22.5, 1);
      expect(valBalanced).toBeCloseTo(35.0, 1);
      expect(valAloof).toBeCloseTo(45.36, 1);

      expect(valEnthusiastic).toBeLessThan(valBalanced);
      expect(valBalanced).toBeLessThan(valAloof);
    });

    it('固定极端随机数 r = 0 和 r = 1 分别准确落于 min 和 max', () => {
      const min = 10;
      const max = 60;
      expect(sampleInterval(min, max, 'enthusiastic', 0.5, () => 0)).toBe(min);
      expect(sampleInterval(min, max, 'enthusiastic', 0.5, () => 1)).toBe(max);
      expect(sampleInterval(min, max, 'aloof', 0.5, () => 0)).toBe(min);
      expect(sampleInterval(min, max, 'aloof', 0.5, () => 1)).toBe(max);
    });

    it('活跃度微调：同为 balanced 态度，高活跃度 (1.0) 比低活跃度 (0.0) 更偏向 min', () => {
      const min = 10;
      const max = 60;
      const rng = () => 0.5;

      const valHighAct = sampleInterval(min, max, 'balanced', 1.0, rng);
      const valLowAct = sampleInterval(min, max, 'balanced', 0.0, rng);

      expect(valHighAct).toBeLessThan(valLowAct);
    });

    it('蒙特卡洛统计检验：5000 次随机采样均值严格满足 enthusiastic < balanced < aloof', () => {
      const min = 10;
      const max = 60;
      const N = 5000;
      let sumEnthusiastic = 0;
      let sumBalanced = 0;
      let sumAloof = 0;

      for (let i = 0; i < N; i++) {
        // 使用同一序列均匀伪随机数
        const r = Math.random();
        const fakeRng = () => r;

        const e = sampleInterval(min, max, 'enthusiastic', 0.5, fakeRng);
        const b = sampleInterval(min, max, 'balanced', 0.5, fakeRng);
        const a = sampleInterval(min, max, 'aloof', 0.5, fakeRng);

        expect(e).toBeGreaterThanOrEqual(min);
        expect(e).toBeLessThanOrEqual(max);
        expect(b).toBeGreaterThanOrEqual(min);
        expect(b).toBeLessThanOrEqual(max);
        expect(a).toBeGreaterThanOrEqual(min);
        expect(a).toBeLessThanOrEqual(max);

        sumEnthusiastic += e;
        sumBalanced += b;
        sumAloof += a;
      }

      const meanEnthusiastic = sumEnthusiastic / N;
      const meanBalanced = sumBalanced / N;
      const meanAloof = sumAloof / N;

      expect(meanEnthusiastic).toBeLessThan(meanBalanced);
      expect(meanBalanced).toBeLessThan(meanAloof);

      // 理论均值约 26.7 (enthusiastic), 35.0 (balanced), 43.3 (aloof)
      expect(meanEnthusiastic).toBeLessThan(30);
      expect(meanBalanced).toBeGreaterThan(32);
      expect(meanBalanced).toBeLessThan(38);
      expect(meanAloof).toBeGreaterThan(40);
    });
  });

  describe('6. 秒回判定机制 isInstantReplyTriggered', () => {
    it('总开关关闭 (enabled: false) 时 100% 严格返回 false', () => {
      expect(
        isInstantReplyTriggered({
          enabled: false,
          activityScore: 1.0,
          attitude: 'enthusiastic',
          rng: () => 0.0,
        })
      ).toBe(false);
    });

    it('低活跃度 (< 0.65) 时严格阻断，即使开启且 rng 为 0 也返回 false', () => {
      const lowScores = [0.0, 0.2, 0.5, 0.64, 0.649];
      for (const score of lowScores) {
        const triggered = isInstantReplyTriggered({
          enabled: true,
          activityScore: score,
          attitude: 'enthusiastic',
          rng: () => 0.0,
        });
        expect(triggered).toBe(false);
      }
    });

    it('异常活跃度输入 (NaN) 时安全阻断', () => {
      expect(
        isInstantReplyTriggered({
          enabled: true,
          activityScore: NaN,
          attitude: 'enthusiastic',
          rng: () => 0.0,
        })
      ).toBe(false);
    });

    it('处于高活跃度 (>= 0.65) 且开启时，按随机概率判定', () => {
      // 在 enthusiastic 下，activityScore = 0.8 时触发概率约为 0.60 + (0.15/0.35)*0.25 ≈ 0.707
      const triggerParams = {
        enabled: true,
        activityScore: 0.8,
        attitude: 'enthusiastic' as const,
      };

      // 低随机数落入概率区间内 -> 触发
      expect(isInstantReplyTriggered({ ...triggerParams, rng: () => 0.1 })).toBe(true);
      // 高随机数超出概率区间 -> 不触发
      expect(isInstantReplyTriggered({ ...triggerParams, rng: () => 0.95 })).toBe(false);
    });

    it('偏好倾向：在相同活跃度与临界 rng 下，enthusiastic 相比 aloof 更易触发秒回', () => {
      // 设定活跃度 0.70，此时 aloof 概率约 0.23，balanced 约 0.43，enthusiastic 约 0.63
      const rngMid = () => 0.50;

      const triggerAloof = isInstantReplyTriggered({
        enabled: true,
        activityScore: 0.70,
        attitude: 'aloof',
        rng: rngMid,
      });

      const triggerBalanced = isInstantReplyTriggered({
        enabled: true,
        activityScore: 0.70,
        attitude: 'balanced',
        rng: rngMid,
      });

      const triggerEnthusiastic = isInstantReplyTriggered({
        enabled: true,
        activityScore: 0.70,
        attitude: 'enthusiastic',
        rng: rngMid,
      });

      expect(triggerAloof).toBe(false);
      expect(triggerBalanced).toBe(false);
      expect(triggerEnthusiastic).toBe(true);
    });

    it('蒙特卡洛统计检验：高活跃度下触发率满足 enthusiastic > balanced > aloof', () => {
      const N = 4000;
      let countEnthusiastic = 0;
      let countBalanced = 0;
      let countAloof = 0;

      for (let i = 0; i < N; i++) {
        const r = Math.random();
        const fakeRng = () => r;

        if (
          isInstantReplyTriggered({
            enabled: true,
            activityScore: 0.85,
            attitude: 'enthusiastic',
            rng: fakeRng,
          })
        ) {
          countEnthusiastic++;
        }

        if (
          isInstantReplyTriggered({
            enabled: true,
            activityScore: 0.85,
            attitude: 'balanced',
            rng: fakeRng,
          })
        ) {
          countBalanced++;
        }

        if (
          isInstantReplyTriggered({
            enabled: true,
            activityScore: 0.85,
            attitude: 'aloof',
            rng: fakeRng,
          })
        ) {
          countAloof++;
        }
      }

      expect(countEnthusiastic).toBeGreaterThan(countBalanced);
      expect(countBalanced).toBeGreaterThan(countAloof);
      expect(countAloof).toBeGreaterThan(0);
    });
  });

  describe('7. 历史消息切片转轮次摘要 extractRecentTurnsFromRecords', () => {
    it('空记录时安全返回 null 与空数组', () => {
      expect(extractRecentTurnsFromRecords([])).toEqual({
        lastBotOutboundAt: null,
        recentTurns: [],
      });
      expect(extractRecentTurnsFromRecords(null as any)).toEqual({
        lastBotOutboundAt: null,
        recentTurns: [],
      });
    });

    it('多轮对话准确切分轮次与识别上轮 Bot 出站时间', () => {
      const records = [
        { self: false, time: 100 },
        { self: true, time: 105 },
        { self: false, time: 110 },
        { self: false, time: 112 },
        { self: true, time: 120 },
      ];

      const res = extractRecentTurnsFromRecords(records);
      expect(res.lastBotOutboundAt).toBe(120);
      expect(res.recentTurns).toHaveLength(2);
      expect(res.recentTurns[0]).toEqual({
        inboundAt: 100,
        lastBotOutboundAt: null,
        messageCount: 1,
      });
      expect(res.recentTurns[1]).toEqual({
        inboundAt: 110,
        lastBotOutboundAt: 105,
        messageCount: 2,
      });
    });

    it('乱序输入时自动按时间升序排列处理', () => {
      const records = [
        { self: 1, time: 105 },
        { self: 0, time: 100 },
      ];
      const res = extractRecentTurnsFromRecords(records);
      expect(res.lastBotOutboundAt).toBe(105);
      expect(res.recentTurns).toHaveLength(1);
      expect(res.recentTurns[0]).toEqual({
        inboundAt: 100,
        lastBotOutboundAt: null,
        messageCount: 1,
      });
    });
  });
});
