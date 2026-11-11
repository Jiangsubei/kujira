/**
 * tests/contract/wait-for-messages.test.ts
 *
 * 契约测试: EN-005 wait_for_user_messages 等待用户消息工具 (Kujira 单聊适配版)
 *
 * 覆盖场景:
 * 1. MessageWaitRegistry 收集命中消息并在窗口结束返回完整字段
 * 2. 超时无消息 → 状态层报错 'No messages received within the specified timeout'
 * 3. 同 peer 重复等待 → wait-active 状态层拒绝
 * 4. AbortSignal 取消 → cancelled 结算，Promise 不悬挂
 * 5. 工具参数校验（timeout 缺失/非法 → 状态层；非单聊 peer → 状态层拦截）
 * 6. 单聊短 ID (`msg_<n>`) 收集与 renderWaitResultText 精简引用渲染（无 `from` / `user_id` / `ref_idx` / `[QQ私聊]`）
 * 7. 真实装配闭环 (bootDshKujira({ mountPlugin: true }) + FakeWs + mockFetch):
 *    - tools 注册表包含 wait_for_user_messages 并经 execute 解析 kujira-user-<hash16>
 *    - 等待期间同 peer 入站 C2C_MESSAGE_CREATE → 门控收集短 ID、更新活跃锚点、并抑制同轮额外唤醒
 *    - 异用户入站消息绝不混入当前单聊等待队列
 *    - 等待期间入站引用回复 (message_type=103) → 还原短 ID quoted 并正确渲染
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageWaitRegistry } from '../../src/gateway/server.js';
import { waitForUserMessages, renderWaitResultText } from '../../src/tools/index.js';
import { resetGlobalToolContext } from '../../src/tools/common/context.js';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { QQ_API_BASE, QQ_BOT_TOKEN_URL } from '../../src/constants/index.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import { formatDateTime } from '../../src/storage/database.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const OTHER_OPENID = 'B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);
const MOCK_APP_ID = '100001';
const MOCK_SECRET = 'mock-qq-bot-secret';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expectLosslessJson(value: unknown, trail = 'root'): void {
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => expectLosslessJson(item, `${trail}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      expect(v, `${trail}.${k} must not be undefined`).not.toBeUndefined();
      expectLosslessJson(v, `${trail}.${k}`);
    }
  }
}

describe('契约测试: EN-005 wait_for_user_messages（registry + 工具函数单元契约）', () => {
  afterEach(() => {
    resetGlobalToolContext();
  });

  it('契约 1: MessageWaitRegistry 收集命中消息并在窗口结束返回精简短 ID 字段', async () => {
    const reg = new MessageWaitRegistry();
    const waitPromise = reg.wait(MOCK_PEER, { timeoutMs: 60 });
    expect(reg.isWaiting(MOCK_PEER)).toBe(true);

    // 异 peer 投递不命中、不收集
    expect(
      reg.tryDeliver(openidToPeer(OTHER_OPENID), {
        msg_id: 'msg_99',
        content: 'x',
        time: 1,
      })
    ).toBe(false);

    const ts = Date.parse('2026-06-01T12:00:00.000Z');
    const delivered = reg.tryDeliver(MOCK_PEER, {
      msg_id: 'msg_1',
      content: '补充: 改成周三上线',
      time: ts,
    });
    expect(delivered).toBe(true);

    const result = await waitPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        msg_id: 'msg_1',
        content: '补充: 改成周三上线',
        time: ts,
      });
      expect('from' in result.messages[0]!).toBe(false);
      expect('user_id' in result.messages[0]!).toBe(false);
      expect('ref_idx' in result.messages[0]!).toBe(false);
    }
    expect(reg.isWaiting(MOCK_PEER)).toBe(false);
    expect(
      reg.tryDeliver(MOCK_PEER, { msg_id: 'msg_2', content: 'y', time: 2 })
    ).toBe(false);
  });

  it('契约 2: 超时无消息 → 状态层报错原文', async () => {
    const reg = new MessageWaitRegistry();
    const result = await reg.wait(MOCK_PEER, { timeoutMs: 40 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('timeout');
      expect(result.message).toBe('No messages received within the specified timeout');
    }
    expect(reg.isWaiting(MOCK_PEER)).toBe(false);
  });

  it('契约 3: 同 peer 已有活动等待 → 第二次 wait 返回 wait-active 状态层拒绝', async () => {
    const reg = new MessageWaitRegistry();
    const first = reg.wait(MOCK_PEER, { timeoutMs: 80 });
    const second = reg.wait(MOCK_PEER, { timeoutMs: 80 });

    const result = await second;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('wait-active');
      expect(result.message).toContain('已有');
    }

    const firstResult = await first;
    expect(firstResult.ok).toBe(false);
  });

  it('契约 4: AbortSignal 取消 → cancelled 结算，Promise 不悬挂', async () => {
    const reg = new MessageWaitRegistry();
    const ac = new AbortController();
    const waitPromise = reg.wait(MOCK_PEER, { timeoutMs: 5000, signal: ac.signal });

    ac.abort();

    const result = await waitPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('cancelled');
      expect(result.message).toContain('中断');
    }
    expect(reg.isWaiting(MOCK_PEER)).toBe(false);
  });

  it('契约 5: 工具参数与单聊上下文校验（timeout 缺失/非法、非单聊会话、waitRegistry 未装配）', async () => {
    const r1 = await waitForUserMessages({} as any, { peer: MOCK_PEER, waitRegistry: null });
    expectLosslessJson(r1);
    expect(r1).toHaveProperty('success', false);
    expect((r1 as any).error).toContain('timeout');

    const r2 = await waitForUserMessages({ timeout: -1 } as any, { peer: MOCK_PEER, waitRegistry: null });
    expectLosslessJson(r2);
    expect(r2).toHaveProperty('success', false);
    expect((r2 as any).error).toContain('timeout');

    // 非 QQ 单聊会话（common / web-session）→ 状态层拒绝
    const r3 = await waitForUserMessages({ timeout: 5 } as any, { peer: 'web-session-1', waitRegistry: null });
    expectLosslessJson(r3);
    expect(r3).toHaveProperty('success', false);
    expect((r3 as any).error).toBe('当前会话不是 QQ 单聊会话，无法等待用户消息');

    // waitRegistry 未装配 → 明确报错
    const r4 = await waitForUserMessages({ timeout: 5 } as any, { peer: MOCK_PEER, waitRegistry: null });
    expectLosslessJson(r4);
    expect(r4).toHaveProperty('success', false);
    expect((r4 as any).error).toContain('waitRegistry');
  });

  it('契约 6: 工具经真实 registry 收集单聊消息并遵循 Lossless JSON', async () => {
    const reg = new MessageWaitRegistry();
    const waitPromise = waitForUserMessages({ timeout: 0.12 } as any, {
      peer: MOCK_PEER,
      waitRegistry: reg,
    });

    const ts = Date.now();
    const delivered = reg.tryDeliver(MOCK_PEER, {
      msg_id: 'msg_1',
      content: '继续说',
      time: ts,
    });
    expect(delivered).toBe(true);

    const result = await waitPromise;
    expectLosslessJson(result);
    expect(result).toHaveProperty('total', 1);
    expect((result as any).messages[0]).toEqual({
      msg_id: 'msg_1',
      content: '继续说',
      time: ts,
    });
  });

  it('契约 7: renderWaitResultText 正确渲染精简短 ID 与 quoted 引用回复的消息（无长 ID 与发送者标识）', () => {
    const msgTs = Date.parse('2026-06-01T12:00:00.000Z');
    const quotedTs = Date.parse('2026-06-01T11:55:00.000Z');
    const text = renderWaitResultText({
      total: 2,
      messages: [
        {
          msg_id: 'msg_8',
          content: '收到请回复',
          time: msgTs,
          reply_to: 'msg_3',
          quoted: {
            short_id: 'msg_3',
            time: quotedTs,
            text: '你是谁',
          },
        },
        {
          msg_id: 'msg_9',
          content: '补充一句',
          time: msgTs,
          quoted: {
            text: '未知历史原文',
          },
        },
      ],
    });

    const expectedMsgTime = formatDateTime(msgTs);
    const expectedQuotedTime = formatDateTime(quotedTs);
    expect(text).toContain('已收集 2 条新消息:');
    expect(text).toContain(
      `1. [msg_8] [${expectedMsgTime}] [引用回复: "[msg_3] [${expectedQuotedTime}] 你是谁"] 收到请回复`
    );
    expect(text).toContain(
      `2. [msg_9] [${expectedMsgTime}] [引用回复: "未知历史原文"] 补充一句`
    );
    expect(text).not.toContain(MOCK_OPENID);
    expect(text).not.toContain('[QQ私聊]');
    expect(text).not.toContain('[消息ID:');
    expect(text).not.toContain('[ref_idx:');
    expect(text).not.toContain('ROBOT1.0_');
    expect(text).not.toContain('REFIDX_');
  });
});

class FakeWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWs[] = [];

  readyState = 0;
  private listeners = new Map<string, Set<(ev: any) => void>>();
  private seq = 0;

  constructor(public readonly url: string) {
    FakeWs.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch('open', {});
      this.dispatch('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      });
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
            d: {
              session_id: 'mock-ws-session-wait',
              user: { id: MOCK_APP_ID, username: 'KujiraBot', bot: true },
            },
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

  emitC2CMessage(event: QQC2CMessageCreateEvent): void {
    this.seq += 1;
    this.dispatch('message', {
      data: JSON.stringify({
        op: 0,
        s: this.seq,
        t: 'C2C_MESSAGE_CREATE',
        d: event,
      }),
    });
  }

  private dispatch(type: string, ev: any): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      fn(ev);
    }
  }
}

async function waitForGatewayReady(gateway: any, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gateway?.getStatus?.().ready) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('KujiraGatewayClient READY 超时');
}

describe('契约测试: EN-005 wait_for_user_messages 真实装配闭环 (bootDshKujira + FakeWs + mockFetch)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let notifyRequests: Array<Record<string, any>> = [];

  beforeEach(async () => {
    FakeWs.instances = [];
    notifyRequests = [];
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-wait-'));
    await fsp.writeFile(
      path.join(tmpHome, '.credentials.yaml'),
      `version: 1\nrefs:\n  QQ_BOT_APP_ID: "${MOCK_APP_ID}"\n  QQ_BOT_SECRET: "${MOCK_SECRET}"\n`,
      'utf8'
    );

    const realFetch = globalThis.fetch;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      if (parsed.hostname !== 'bots.qq.com' && parsed.hostname !== 'api.sgroup.qq.com') {
        return realFetch(input, init);
      }
      if (url === QQ_BOT_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'mock-wait-tok', expires_in: 7200 }), {
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
        const body = JSON.parse(String(init?.body || '{}'));
        notifyRequests.push(body);
        return new Response(JSON.stringify({ id: 'ROBOT1.0_NOTIFY_1', timestamp: new Date().toISOString() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('WebSocket', FakeWs as any);

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
    });
    const gateway = booted.ctx.get('kujira-gateway') as any;
    await waitForGatewayReady(gateway);
  });

  afterEach(async () => {
    resetGlobalToolContext();
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

  function buildC2CEvent(
    id: string,
    content: string,
    opts: { openid?: string; username?: string; refIdx?: string; refMsgIdx?: string; messageType?: number } = {}
  ): QQC2CMessageCreateEvent {
    const ext: string[] = [`msg_idx=${opts.refIdx ?? `REFIDX_${id}`}`];
    if (opts.refMsgIdx) {
      ext.push(`ref_msg_idx=${opts.refMsgIdx}`);
    }
    return {
      id,
      content,
      timestamp: new Date().toISOString(),
      author: { user_openid: opts.openid ?? MOCK_OPENID, username: opts.username ?? '测试用户' },
      message_type: opts.messageType ?? 0,
      message_scene: { ext },
    };
  }

  it('装配: tools 注册表包含 wait_for_user_messages，经 execute 按 kujira-user-<hash16> 超时返回状态层原文', async () => {
    const provider = booted!.ctx.get('kujiraBridgeTools') as any;
    expect(provider).toBeDefined();
    provider.registerTools(booted!.ctx);

    const tools = booted!.ctx.get('tools') as any;
    const toolDef = tools.get('wait_for_user_messages');
    expect(toolDef).toBeDefined();
    expect(toolDef.name).toBe('wait_for_user_messages');
    expect(toolDef.description).toContain('等待');

    const result = await toolDef.execute(
      { timeout: 0.08 },
      { agent: { session: { id: MOCK_SESSION_ID } }, signal: new AbortController().signal }
    );
    expectLosslessJson(result);
    expect(result).toHaveProperty('success', false);
    expect((result as any).error).toBe('No messages received within the specified timeout');
  });

  it('装配: 等待期间同 peer 入站 C2C 消息被门控收集、更新入站锚点、抑制同轮额外唤醒，且隔离其他用户消息', async () => {
    const sessionManager = booted!.ctx.get('kujira-session') as any;
    const dispatchSpy = vi.spyOn(sessionManager, 'dispatchWakeup').mockResolvedValue(undefined as any);
    const provider = booted!.ctx.get('kujiraBridgeTools') as any;
    provider.registerTools(booted!.ctx);
    const toolDef = (booted!.ctx.get('tools') as any).get('wait_for_user_messages');
    const fakeWs = FakeWs.instances[FakeWs.instances.length - 1]!;

    const waitPromise = toolDef.execute(
      { timeout: 0.25 },
      { agent: { session: { id: MOCK_SESSION_ID } }, signal: new AbortController().signal }
    );

    // 等待注册到 registry
    await sleep(20);

    // 1. 他人单聊消息（不同 openid/peer）：不混入当前用户的等待收集结果
    fakeWs.emitC2CMessage(
      buildC2CEvent('ROBOT1.0_OTHER_USER', '别人发的', { openid: OTHER_OPENID, username: '路人' })
    );
    // 2. 当前单聊用户发来补充消息：被门控收集并抑制同轮额外唤醒
    fakeWs.emitC2CMessage(
      buildC2CEvent('ROBOT1.0_WAIT_HIT', '补充: 改成周三上线', { refIdx: 'REFIDX_WAIT_HIT' })
    );

    const result = await waitPromise;
    expectLosslessJson(result);
    expect(result).toHaveProperty('total', 1);
    expect(result.messages[0]).toMatchObject({
      msg_id: 'msg_1',
      content: '补充: 改成周三上线',
    });
    expect(typeof result.messages[0].time).toBe('number');
    expect('from' in result.messages[0]).toBe(false);
    expect('user_id' in result.messages[0]).toBe(false);
    expect('ref_idx' in result.messages[0]).toBe(false);

    // 仅 OTHER_OPENID 触发了正常唤醒；MOCK_PEER 的补充消息被门控消费，抑制了同轮额外唤醒
    const mockPeerWakeups = dispatchSpy.mock.calls.filter((c) => c[0]?.peer === MOCK_PEER);
    expect(mockPeerWakeups).toHaveLength(0);
    // 被收集消息同时更新了出站活跃回合入站 msg_id 锚点（底层仍保留真实 ROBOT1.0_... 供被动回复）
    const outboundBridge = booted!.ctx.get('kujira-outbound-bridge') as any;
    expect(outboundBridge.getActiveTurnContext(MOCK_PEER)?.msg_id).toBe('ROBOT1.0_WAIT_HIT');
  });

  it('装配: 等待期间入站引用回复 (message_type=103) → 还原短 ID quoted 并抑制额外唤醒', async () => {
    const sessionManager = booted!.ctx.get('kujira-session') as any;
    const dispatchSpy = vi.spyOn(sessionManager, 'dispatchWakeup').mockResolvedValue(undefined as any);
    const provider = booted!.ctx.get('kujiraBridgeTools') as any;
    provider.registerTools(booted!.ctx);
    const toolDef = (booted!.ctx.get('tools') as any).get('wait_for_user_messages');
    const fakeWs = FakeWs.instances[FakeWs.instances.length - 1]!;

    // 1. 先注入前序历史消息供 REFIDX 查库还原
    fakeWs.emitC2CMessage(
      buildC2CEvent('ROBOT1.0_ORIG_5', '你是硬梨吗', {
        username: '历史用户',
        refIdx: 'REFIDX_ORIG_5',
      })
    );
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(1));

    // 2. 发起等待收集
    const waitPromise = toolDef.execute(
      { timeout: 0.25 },
      { agent: { session: { id: MOCK_SESSION_ID } }, signal: new AbortController().signal }
    );
    await sleep(20);

    // 3. 入站引用 REFIDX_ORIG_5 的回复消息
    fakeWs.emitC2CMessage(
      buildC2CEvent('ROBOT1.0_REPLY_8', '这是回复内容', {
        refIdx: 'REFIDX_REPLY_8',
        refMsgIdx: 'REFIDX_ORIG_5',
        messageType: 103,
      })
    );

    const result = await waitPromise;
    expectLosslessJson(result);
    expect(result).toHaveProperty('total', 1);
    expect(result.messages[0]).toMatchObject({
      msg_id: 'msg_2',
      content: '这是回复内容',
      reply_to: 'msg_1',
      quoted: {
        short_id: 'msg_1',
        text: '你是硬梨吗',
      },
    });
    expect(typeof result.messages[0].quoted?.time).toBe('number');
    expect('from' in result.messages[0]).toBe(false);
    expect('user_id' in result.messages[0]).toBe(false);
    expect('ref_idx' in result.messages[0]).toBe(false);
    expect('msg_id' in result.messages[0].quoted!).toBe(false);
    expect('ref_idx' in result.messages[0].quoted!).toBe(false);
    expect('user_id' in result.messages[0].quoted!).toBe(false);
    expect('from_name' in result.messages[0].quoted!).toBe(false);
    // 等待期间未产生额外唤醒
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    const rendered = renderWaitResultText(result);
    expect(rendered).toContain('1. [msg_2] [');
    expect(rendered).toMatch(/\[引用回复: "\[msg_1\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 你是硬梨吗"\]/);
    expect(rendered).toContain('这是回复内容');
    expect(rendered).not.toContain('ROBOT1.0_');
    expect(rendered).not.toContain('REFIDX_');
    expect(rendered).not.toContain(MOCK_OPENID);
  });
});
