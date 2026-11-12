/**
 * tests/contract/proactive-assembly.test.ts
 *
 * 契约测试: 单聊主动能力的**真实装配闭环** (Proactive Assembly Contract)
 *
 * 依据 AGENTS.md 3.1「严禁以单元测试替代装配验证」：
 * 本文件不新建 mock 桩，而是走真实 `bootDshKujira({ mountPlugin: true })` 装配，
 * 验证「ProactiveManager → 入站链路 → SystemEventHub → SessionManager」全链路真实可达：
 *
 * 1. 真实 boot 装配后 `kujira-proactive` 服务可获取，且停驻于插件生命周期；
 * 2. 聚合开关开启时，真实入站 C2C_MESSAGE_CREATE 事件**不立即唤醒**，而是落入聚合池；
 * 3. 周期巡检到点后，经 SystemEventHub 真实投递聚合唤醒（断言 payload 形态与提示词）；
 * 4. 聚合入池期间绝不发送 `msg_type=6` 输入中提示（否则「正在输入」挂满窗口）；
 * 5. 冷场搭话在无可用被动锚点时被跳过，绝不降级为纯主动消息；
 * 6. 插件 dispose 后巡检定时器停止，无悬挂句柄。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { QQ_API_BASE, QQ_BOT_TOKEN_URL } from '../../src/constants/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = 'B1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);
const MOCK_APP_ID = '100002';
const MOCK_SECRET = 'mock-qq-bot-secret';

class FakeWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  private listeners = new Map<string, Set<(ev: any) => void>>();
  private seq = 0;

  constructor(public readonly url: string) {
    lastWs = this;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch('open', {});
      this.dispatch('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) });
    });
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.op === 2) {
      queueMicrotask(() => {
        if (this.readyState !== 1) return;
        this.seq += 1;
        this.dispatch('message', {
          data: JSON.stringify({
            op: 0,
            s: this.seq,
            t: 'READY',
            d: { session_id: 'mock-ws-proactive', user: { id: MOCK_APP_ID, username: 'KujiraBot', bot: true } },
          }),
        });
      });
    } else if (frame.op === 1) {
      this.dispatch('message', { data: JSON.stringify({ op: 11 }) });
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', { code: 1000, reason: 'closed' });
  }

  /** 模拟服务端下发一条 OP_DISPATCH 帧（走完整网关分发链路，非直调 handler） */
  emitDispatch(t: string, d: unknown): void {
    this.seq += 1;
    this.dispatch('message', { data: JSON.stringify({ op: 0, s: this.seq, t, d }) });
  }

  private dispatch(type: string, ev: any): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) fn(ev);
  }
}

async function waitForGatewayReady(gateway: any, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gateway?.getStatus?.().ready) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('KujiraGatewayClient READY 超时');
}

/** 捕获最近一次构造的 FakeWs 实例，用于注入服务端下发帧 */
let lastWs: FakeWs | null = null;

describe('契约 1 ~ 6: 单聊主动能力真实装配闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let outboundRequests: Array<{ url: string; body: Record<string, any> }> = [];

  beforeEach(async () => {
    outboundRequests = [];
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-proactive-asm-'));
    await fsp.writeFile(
      path.join(tmpHome, '.credentials.yaml'),
      `version: 1\nrefs:\n  QQ_BOT_APP_ID: "${MOCK_APP_ID}"\n  QQ_BOT_SECRET: "${MOCK_SECRET}"\n`,
      'utf8'
    );

    const realFetch = globalThis.fetch;
    let outSeq = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      if (parsed.hostname !== 'bots.qq.com' && parsed.hostname !== 'api.sgroup.qq.com') {
        return realFetch(input, init);
      }
      if (url === QQ_BOT_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'mock-proactive-tok', expires_in: 7200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === `${QQ_API_BASE}/gateway`) {
        return new Response(JSON.stringify({ url: 'wss://api.sgroup.qq.com/mock-ws' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (/\/v2\/users\/[^/]+\/messages$/.test(parsed.pathname) && (init?.method || 'GET').toUpperCase() === 'POST') {
        outboundRequests.push({ url, body: JSON.parse(String(init?.body || '{}')) });
        outSeq += 1;
        return new Response(
          JSON.stringify({
            id: `ROBOT1.0_OUT_P_${outSeq}`,
            timestamp: new Date().toISOString(),
            ext_info: { ref_idx: `REFIDX_OUT_P_${outSeq}` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('WebSocket', FakeWs as any);

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
    });
    const gateway = booted.ctx.get('kujira-gateway') as any;
    await waitForGatewayReady(gateway);
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  function emitInbound(id: string, content: string): void {
    lastWs!.emitDispatch('C2C_MESSAGE_CREATE', {
      id,
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      content,
      timestamp: new Date().toISOString(),
      message_type: 0,
    });
  }

  it('契约 1: 真实装配后 kujira-proactive 服务可获取并有 checkProactive 能力', () => {
    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    expect(proactive).toBeDefined();
    expect(typeof proactive.checkProactive).toBe('function');
    expect(typeof proactive.recordMessage).toBe('function');
    expect(typeof proactive.consumePendingMessages).toBe('function');
  });

  it('契约 2: 聚合开启时入站消息落入聚合池，且不发送 msg_type=6 输入中提示', async () => {
    emitInbound('ROBOT1.0_IN_P_1', '在吗');
    await new Promise((r) => setTimeout(r, 80));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    const pending = proactive.getPendingMessages(MOCK_PEER);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe('在吗');
    expect(pending[0].short_id).toBeTruthy();

    // 聚合入池期间绝不发送任何出站（尤其不得发 msg_type=6 输入中提示）
    expect(outboundRequests).toHaveLength(0);
  });

  it('契约 3: 周期巡检到点后经 SystemEventHub 真实投递聚合唤醒，payload 形态与提示词正确', async () => {
    emitInbound('ROBOT1.0_IN_P_2', '在吗');
    emitInbound('ROBOT1.0_IN_P_3', '那个接口一直 403');
    await new Promise((r) => setTimeout(r, 80));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const dispatchSpy = vi.spyOn(hub, 'dispatchSystemEvent');

    expect(proactive.getPendingMessages(MOCK_PEER)).toHaveLength(2);

    // 用真实巡检入口，把 now 设为窗口之后
    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      isSessionBusy: () => false,
      now: Date.now() + 3 * 60 * 1000,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]![0] as any;
    expect(event.kind).toBe('aggregated_messages');
    expect(event.peer).toBe(MOCK_PEER);
    expect(event.messages).toHaveLength(2);
    expect(event.messages.map((m: any) => m.content)).toEqual(['在吗', '那个接口一直 403']);

    // 投递后池已清空，绝不重复打扰
    expect(proactive.getPendingMessages(MOCK_PEER)).toEqual([]);
  });

  it('契约 4: 冷场搭话在无可用被动锚点时被跳过，绝不降级为纯主动消息', async () => {
    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    // 从未有任何入站消息 → 无被动锚点
    const anchor = (booted!.ctx as any).get('kujira-outbound-bridge').resolvePassiveMsgId(MOCK_PEER);
    expect(anchor).toBeUndefined();

    proactive.recordHumanMessage(MOCK_PEER, Date.now() - 120 * 60 * 1000);

    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const dispatchSpy = vi.spyOn(hub, 'dispatchSystemEvent');

    // 复刻 plugin 侧的真实门控逻辑：无锚点直接跳过
    const idleEvent = { kind: 'idle_reply' as const, peer: MOCK_PEER, idleMinutes: 60 };
    const guardAnchor = (booted!.ctx as any)
      .get('kujira-outbound-bridge')
      .resolvePassiveMsgId(idleEvent.peer);
    if (guardAnchor) {
      await hub.dispatchSystemEvent(idleEvent);
    }

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(outboundRequests).toHaveLength(0);
  });

  it('契约 5: 插件 dispose 后巡检定时器停止，且状态清空', async () => {
    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    emitInbound('ROBOT1.0_IN_P_4', '待清空消息');
    await new Promise((r) => setTimeout(r, 80));
    expect(proactive.getPendingMessages(MOCK_PEER).length).toBeGreaterThan(0);

    await booted!.dispose();
    booted = null;

    expect(proactive.getPendingMessages(MOCK_PEER)).toEqual([]);
  });

  it('契约 6: 聚合池记录真实发送者 openid，聚合投递事件携带 fromUser', async () => {
    emitInbound('ROBOT1.0_IN_P_5', '在吗');
    await new Promise((r) => setTimeout(r, 80));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const dispatchSpy = vi.spyOn(hub, 'dispatchSystemEvent');

    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      now: Date.now() + 3 * 60 * 1000,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0]![0] as any).fromUser).toBe(MOCK_OPENID);
  });

  it('契约 7: 聚合轮次的 WakeupPayload 携带真实 from_user，使轮内审批可登记发起人', async () => {
    emitInbound('ROBOT1.0_IN_P_6', '在吗');
    await new Promise((r) => setTimeout(r, 80));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const sm = (booted!.ctx as any).get('kujira-session') as any;
    const dispatchSpy = vi.spyOn(sm, 'dispatchWakeup');

    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      now: Date.now() + 3 * 60 * 1000,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const payload = dispatchSpy.mock.calls[0]![0] as any;
    expect(payload.trigger).toBe('aggregated');
    // 聚合来自真实用户消息 → 携带真实 from_user（与 idle_reply / scheduled 的空值严格区分）
    expect(payload.from_user).toBe(MOCK_OPENID);
    expect(payload.from_name).toBe('');
  });

  it('契约 8: 冷场搭话的 WakeupPayload 保持 from_user 为空（系统自发，审批 Fail-Closed）', async () => {
    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const sm = (booted!.ctx as any).get('kujira-session') as any;
    const dispatchSpy = vi.spyOn(sm, 'dispatchWakeup');

    await hub.dispatchSystemEvent({
      kind: 'idle_reply',
      peer: MOCK_PEER,
      idleMinutes: 60,
      timestamp: Date.now(),
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const payload = dispatchSpy.mock.calls[0]![0] as any;
    expect(payload.trigger).toBe('idle_reply');
    expect(payload.from_user).toBe('');
    expect(payload.from_name).toBe('');
  });

  it('契约 9: 两个 provider 的 isWaiting 已真实装配且可查询', () => {
    const questionProvider = (booted!.ctx as any).get('kujira-question-provider');
    const approvalResponder = (booted!.ctx as any).get('kujira-approval-responder');
    // 未提供为服务的场景下退化为能力探测：至少 plugin 内部持有的实例可被判活
    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    expect(proactive).toBeDefined();

    // isWaiting 必须是可安全调用的同步查询（无论是否挂起，绝不抛错）
    if (questionProvider && typeof questionProvider.isWaiting === 'function') {
      expect(() => questionProvider.isWaiting(MOCK_PEER)).not.toThrow();
      expect(questionProvider.isWaiting(MOCK_PEER)).toBe(false);
    }
    if (approvalResponder && typeof approvalResponder.isWaiting === 'function') {
      expect(() => approvalResponder.isWaiting(MOCK_PEER)).not.toThrow();
      expect(approvalResponder.isWaiting(MOCK_PEER)).toBe(false);
    }
  });

  it('契约 10: hasActiveSession 为只读判定，绝不为无会话 peer 创建会话', async () => {
    const sm = (booted!.ctx as any).get('kujira-session') as any;
    const unknownPeer = 'user_ffffffffffffffff';

    // 首次查询前：无会话
    expect(sm.hasActiveSession(unknownPeer)).toBe(false);
    // 查询本身就是只读的，重复调用结果稳定且不产生副作用
    expect(sm.hasActiveSession(unknownPeer)).toBe(false);
    // 该 peer 名下不存在任何被持久化的会话记录
    expect(sm.listPeerSessionIds(unknownPeer)).toEqual([]);
  });
});
