/**
 * tests/contract/question-interception.test.ts
 * 契约测试: 单聊提问拦截装配闭环 (Question Interception Assembly Contract)
 *
 * 真实装配路径验证：bootDshKujira({ mountPlugin: true }) + 独立 tmpHome .credentials.yaml +
 * FakeWs + mockFetch 拦截 bots.qq.com / api.sgroup.qq.com：
 * - 非提问态普通单聊入站消息走正常唤醒队列；
 * - 提问激活后，KujiraQuestionProvider 在单聊入站流水线优先拦截并消费回答，绝不泄漏到唤醒队列
 *   （不触发 dispatchWakeup、不下发 msg_type=6 输入状态）；
 * - 串行多题经真实 WS 入站与 REST 出站逐题推进，全部答完一次性 resolve；
 * - Kujira 会话由 registerKujiraQuestionChannel (prepend: true) 优先接管，非 Kujira 会话透传给下游 Web provider。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { QQ_API_BASE, QQ_BOT_TOKEN_URL } from '../../src/constants/index.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);
const MOCK_APP_ID = '100001';
const MOCK_SECRET = 'mock-qq-bot-secret';

interface OutboundMessageCapture {
  openid: string;
  payload: Record<string, any>;
}

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
              session_id: 'mock-ws-session-q',
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

async function waitForPreset(ctx: any, presetId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const presetsSvc = ctx.get?.('agentPresets') || ctx.agentPresets;
  while (Date.now() < deadline) {
    const list = await presetsSvc?.list?.();
    if (Array.isArray(list) && list.some((p: any) => p.id === presetId)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`预设 ${presetId} 注册超时`);
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

describe('契约测试: 单聊提问拦截装配闭环 (Question Interception Assembly)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let sentMessages: OutboundMessageCapture[] = [];
  let inputNotifyCount = 0;
  let waiters: Array<(msg: OutboundMessageCapture) => void> = [];

  beforeEach(async () => {
    FakeWs.instances = [];
    sentMessages = [];
    inputNotifyCount = 0;
    waiters = [];

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-qintercept-'));
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
        return new Response(JSON.stringify({ access_token: 'mock-q-token', expires_in: 7200 }), {
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
      const msgMatch = /\/v2\/users\/([^/]+)\/messages$/.exec(parsed.pathname);
      if (msgMatch && (init?.method || 'GET').toUpperCase() === 'POST') {
        const openid = decodeURIComponent(msgMatch[1]!);
        const payload = JSON.parse(String(init?.body || '{}'));
        outSeq += 1;
        if (payload.msg_type === 6) {
          inputNotifyCount += 1;
        } else {
          const captured = { openid, payload };
          const nextWaiter = waiters.shift();
          if (nextWaiter) {
            nextWaiter(captured);
          } else {
            sentMessages.push(captured);
          }
        }
        return new Response(
          JSON.stringify({
            id: `ROBOT1.0_OUT_Q_${outSeq}`,
            timestamp: new Date().toISOString(),
            ext_info: { ref_idx: `REFIDX_OUT_Q_${outSeq}` },
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
    });

    const gateway = booted.ctx.get('kujira-gateway') as any;
    await waitForGatewayReady(gateway);
    await waitForPreset(booted.ctx, 'kujira-session');
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

  function nextOutboundMessage(timeoutMs = 2000): Promise<OutboundMessageCapture> {
    if (sentMessages.length > 0) {
      return Promise.resolve(sentMessages.shift()!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== onRecv);
        reject(new Error('等待 QQ 出站消息超时'));
      }, timeoutMs);
      const onRecv = (msg: OutboundMessageCapture) => {
        clearTimeout(timer);
        resolve(msg);
      };
      waiters.push(onRecv);
    });
  }

  function buildC2CEvent(id: string, content: string): QQC2CMessageCreateEvent {
    return {
      id,
      content,
      timestamp: new Date().toISOString(),
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      message_scene: { ext: [`msg_idx=REFIDX_${id}`] },
    };
  }

  it('装配 1: 单聊提问优先拦截 — 串行多题卡片下发、回答拦截消费且不泄漏到唤醒队列', async () => {
    const sessionManager = booted!.ctx.get('kujira-session') as any;
    const dispatchSpy = vi.spyOn(sessionManager, 'dispatchWakeup').mockResolvedValue(undefined as any);
    const fakeWs = FakeWs.instances[FakeWs.instances.length - 1]!;
    expect(fakeWs).toBeDefined();

    // 1. 无提问挂起时，普通单聊入站消息正常进入唤醒队列（同时完成 peer<->openid 与入站槽位登记）
    fakeWs.emitC2CMessage(buildC2CEvent('ROBOT1.0_IN_PRE', '准备好了吗'));
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(1));
    expect(dispatchSpy.mock.calls[0]![0]).toMatchObject({
      peer: MOCK_PEER,
      from_user: MOCK_OPENID,
      content: '准备好了吗',
    });

    const agentHandle = await booted!.ctx.agents.create({
      sessionId: MOCK_SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'agent-ws') },
    });
    const qqAgent = agentHandle.agent || agentHandle;

    // 2. 发起 2 题串行提问 -> 仅发送第 1 题卡片
    const askPromise = booted!.ctx.userQuestions.ask({
      agent: qqAgent,
      questions: [
        { id: 'q1', question: '部署环境?', options: [{ label: '生产' }, { label: '测试' }] },
        { id: 'q2', question: '回滚策略?', options: [{ label: '手动' }, { label: '自动' }] },
      ],
      signal: new AbortController().signal,
    });

    const card1 = await nextOutboundMessage();
    expect(card1.openid).toBe(MOCK_OPENID);
    const card1Text = String(card1.payload.markdown?.content ?? card1.payload.content);
    expect(card1Text).toContain('部署环境?');
    expect(card1Text).not.toContain('回滚策略?');

    const notifyBeforeQ1 = inputNotifyCount;

    // 3. 入站回答第 1 题 -> 被提问拦截消费，不下发输入状态，不泄漏到 dispatchWakeup
    fakeWs.emitC2CMessage(buildC2CEvent('ROBOT1.0_IN_A1', '2'));
    const receipt1 = await nextOutboundMessage();
    const card2 = await nextOutboundMessage();
    const msgsAfterA1 = [
      String(receipt1.payload.markdown?.content ?? receipt1.payload.content),
      String(card2.payload.markdown?.content ?? card2.payload.content),
    ];
    expect(msgsAfterA1.some((t) => t === '已收到第 1/2 题回答')).toBe(true);
    expect(msgsAfterA1.some((t) => t.includes('回滚策略?') && !t.includes('部署环境?'))).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(inputNotifyCount).toBe(notifyBeforeQ1);

    // 4. 入站回答第 2 题（自定义回答）-> 发送终局回执并一次性 resolve 全部答案，仍不泄漏到 dispatchWakeup
    fakeWs.emitC2CMessage(buildC2CEvent('ROBOT1.0_IN_A2', '灰度切流回滚'));
    const finalReceipt = await nextOutboundMessage();
    expect(String(finalReceipt.payload.markdown?.content ?? finalReceipt.payload.content)).toBe('已成功回答');

    const answer = await askPromise;
    expect(answer.answers).toEqual([
      { id: 'q1', selected: ['测试'] },
      { id: 'q2', selected: [], custom: '灰度切流回滚' },
    ]);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(inputNotifyCount).toBe(notifyBeforeQ1);

    // 5. 提问结束后，后续入站消息恢复正常唤醒流转
    fakeWs.emitC2CMessage(buildC2CEvent('ROBOT1.0_IN_POST', '继续日常聊天'));
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(2));
  });

  it('装配 2: user-questions/request waterfall 仅拦截 Kujira 单聊会话，非 Kujira 会话透传给下游 Web provider', async () => {
    const outboundBridge = booted!.ctx.get('kujira-outbound-bridge') as any;
    outboundBridge.registerPeerOpenid(MOCK_PEER, MOCK_OPENID);

    let webProviderHits = 0;
    const unregWeb = (booted!.ctx as any).on('user-questions/request', async (req: any) => {
      webProviderHits += 1;
      return {
        answers: req.questions.map((q: any) => ({ id: q.id, selected: [], custom: 'web-ui-answer' })),
      };
    });

    try {
      const webHandle = await booted!.ctx.agents.create({
        sessionId: 'web-session-q',
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        meta: { cwd: path.join(tmpHome, 'web-ws') },
      });
      const webAgent = webHandle.agent || webHandle;

      const webRes = await booted!.ctx.userQuestions.ask({
        agent: webAgent,
        questions: [{ id: 'wq1', question: 'Web 确认?', options: [{ label: '确认' }] }],
        signal: new AbortController().signal,
      });
      expect(webProviderHits).toBe(1);
      expect(webRes.answers).toEqual([{ id: 'wq1', selected: [], custom: 'web-ui-answer' }]);
      expect(sentMessages).toHaveLength(0);

      // Kujira 会话必须由 KujiraQuestionProvider 优先拦截（不命中 webProvider）
      const qqHandle = await booted!.ctx.agents.create({
        sessionId: MOCK_SESSION_ID,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        meta: { cwd: path.join(tmpHome, 'qq-ws') },
      });
      const qqAgent = qqHandle.agent || qqHandle;

      const qqAsk = booted!.ctx.userQuestions.ask({
        agent: qqAgent,
        questions: [{ id: 'kq1', question: 'QQ 确认?', options: [{ label: '确定' }, { label: '取消' }] }],
        signal: new AbortController().signal,
      });

      const qqCard = await nextOutboundMessage();
      expect(String(qqCard.payload.markdown?.content ?? qqCard.payload.content)).toContain('QQ 确认?');
      expect(webProviderHits).toBe(1);

      const fakeWs = FakeWs.instances[FakeWs.instances.length - 1]!;
      fakeWs.emitC2CMessage(buildC2CEvent('ROBOT1.0_IN_KQ1', '1'));
      await nextOutboundMessage(); // 已成功回答

      const qqRes = await qqAsk;
      expect(qqRes.answers).toEqual([{ id: 'kq1', selected: ['确定'] }]);
      expect(webProviderHits).toBe(1);
    } finally {
      unregWeb();
    }
  });
});
