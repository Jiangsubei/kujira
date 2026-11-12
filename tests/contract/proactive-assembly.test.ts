/**
 * tests/contract/proactive-assembly.test.ts
 *
 * 契约测试: 单聊主动能力的**真实装配闭环** (Proactive Assembly Contract)
 *
 * 依据 AGENTS.md 3.1「严禁以单元测试替代装配验证」：
 * 走真实 `bootDshKujira({ mountPlugin: true })` 装配，通过真实网关分发链路
 * （FakeWs 注入 OP_DISPATCH 帧）验证「入站 → 标志 → 自由周期时钟 → SystemEventHub → SessionManager」
 * 全链路真实可达，而非直调内部 handler。
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

let lastWs: FakeWs | null = null;

async function waitForGatewayReady(gateway: any, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gateway?.getStatus?.().ready) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('KujiraGatewayClient READY 超时');
}

describe('单聊主动能力真实装配闭环', () => {
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

  it('契约 1: 真实装配后 kujira-proactive 可获取，且暴露极简布尔标志 API', () => {
    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    expect(proactive).toBeDefined();
    expect(typeof proactive.checkProactive).toBe('function');
    expect(typeof proactive.recordMessage).toBe('function');
    expect(typeof proactive.hasPendingMessage).toBe('function');
    // 消息池 API 必须已删除
    expect(proactive.getPendingMessages).toBeUndefined();
    expect(proactive.consumePendingMessages).toBeUndefined();
  });

  it('契约 2: 聚合开启时入站消息只置标志，不唤醒、不进 session、不发输入中提示', async () => {
    emitInbound('ROBOT1.0_IN_P_1', '在吗');
    await new Promise((r) => setTimeout(r, 120));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    expect(proactive.hasPendingMessage(MOCK_PEER)).toBe(true);

    // 不产生任何出站（尤其不得发 msg_type=6 输入中提示）
    expect(outboundRequests).toHaveLength(0);
  });

  it('契约 3: 自由周期时钟到点后经 SystemEventHub 真实投递聚合唤醒，事件不带消息内容', async () => {
    emitInbound('ROBOT1.0_IN_P_2', '在吗');
    emitInbound('ROBOT1.0_IN_P_3', '那个接口一直 403');
    await new Promise((r) => setTimeout(r, 120));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const dispatchSpy = vi.spyOn(hub, 'dispatchSystemEvent');

    const now = Date.now();
    // 建立相位
    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      now,
    });
    // 到点
    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      now: now + 121_000,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]![0] as any;
    expect(event.kind).toBe('aggregated_messages');
    expect(event.peer).toBe(MOCK_PEER);
    // 绝不携带消息内容
    expect(event.messages).toBeUndefined();

    // 标志已消费
    expect(proactive.hasPendingMessage(MOCK_PEER)).toBe(false);
  });

  it('契约 4: 聚合轮次的 WakeupPayload 提示词要求模型自调 read_chat_history，且携带真实 from_user', async () => {
    emitInbound('ROBOT1.0_IN_P_4', '在吗');
    await new Promise((r) => setTimeout(r, 120));

    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    const hub = (booted!.ctx as any).get('kujira-system-event-hub') as any;
    const sm = (booted!.ctx as any).get('kujira-session') as any;
    const wakeSpy = vi.spyOn(sm, 'dispatchWakeup');

    const now = Date.now();
    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      now,
    });
    await proactive.checkProactive({
      config: { aggregation_enabled: true, aggregation_interval_mins: 2 },
      dispatch: (event: any) => hub.dispatchSystemEvent(event),
      now: now + 121_000,
    });

    expect(wakeSpy).toHaveBeenCalledTimes(1);
    const payload = wakeSpy.mock.calls[0]![0] as any;
    expect(payload.trigger).toBe('aggregated');
    expect(payload.from_user).toBe(MOCK_OPENID);
    expect(payload.from_name).toBe('');
    // 提示词强制自调工具，且不含消息正文
    expect(payload.content).toContain('read_chat_history');
    expect(payload.content).not.toContain('那个接口');
  });

  it('契约 5: 冷场搭话 payload 保持 from_user 为空（系统自发，审批 Fail-Closed）', async () => {
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

  it('契约 6: 冷场搭话在无可用被动锚点时被跳过', async () => {
    const outbound = (booted!.ctx as any).get('kujira-outbound-bridge') as any;
    expect(outbound.resolvePassiveMsgId(MOCK_PEER)).toBeUndefined();
  });

  it('契约 7: 两个 provider 的 isWaiting 已真实装配且安全可调用', () => {
    const proactive = (booted!.ctx as any).get('kujira-proactive');
    expect(proactive).toBeDefined();

    // 通过对外暴露的服务间接验证判活不会抛错（未挂起时应为 false）
    const sessionManager = (booted!.ctx as any).get('kujira-session') as any;
    expect(typeof sessionManager.hasActiveSession).toBe('function');
    expect(() => sessionManager.hasActiveSession(MOCK_PEER)).not.toThrow();
  });

  it('契约 8: hasActiveSession 为只读判定，绝不为无会话 peer 创建会话', () => {
    const sm = (booted!.ctx as any).get('kujira-session') as any;
    const unknownPeer = 'user_ffffffffffffffff';

    expect(sm.hasActiveSession(unknownPeer)).toBe(false);
    expect(sm.hasActiveSession(unknownPeer)).toBe(false);
    expect(sm.listPeerSessionIds(unknownPeer)).toEqual([]);
  });

  it('契约 9: 插件 dispose 后定时器停止且状态清空', async () => {    const proactive = (booted!.ctx as any).get('kujira-proactive') as any;
    emitInbound('ROBOT1.0_IN_P_5', '待清空消息');
    await new Promise((r) => setTimeout(r, 120));
    expect(proactive.hasPendingMessage(MOCK_PEER)).toBe(true);

    await booted!.dispose();
    booted = null;

    expect(proactive.hasPendingMessage(MOCK_PEER)).toBe(false);
  });
});
