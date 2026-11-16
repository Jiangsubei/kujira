/**
 * tests/contract/aside-suppression-and-fallback.test.ts
 * 契约测试: 用户侧静默原则、唯一发送通道与被动失效主动降级 (User-Side Silence & Fallback Contract)
 *
 * 覆盖规范清单:
 * 契约 1: 当 assistant/message 包含 reasoning / text / tool-call 块时，出站保持绝对静默；
 * 契约 2: 纯文本输出：即便 assistant/message 仅包含 TextBlock，未调用 send_qq_message 时依然绝对静默；
 * 契约 3: turn/end 结束时绝对不补发任何兜底文本；
 * 契约 4: 多步交互场景中，跨多 Step 的思考、正文与工具调用，全程 100% 保持静默；
 * 契约 5: 真实装配下 (bootDshKujira({ mountPlugin: true }) + FakeWs + mockFetch) 验证：
 *         - 向 session 派发 assistant/message 与 turn/end 时，QQ HTTP 出站为 0；
 *         - 仅 send_qq_message 通道可出站，且遇 40034128 被动锚点失效时自动降级为无 msg_id 主动消息。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { QQ_API_BASE, QQ_BOT_TOKEN_URL } from '../../src/constants/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);
const MOCK_APP_ID = '100001';
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
              session_id: 'mock-ws-session-silence',
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

describe('契约 1 ~ 4: OutboundStreamBridge 用户侧静默原则单元契约', () => {
  function makeMockBridge(sent: Array<{ openid: string; payload: any }>, config: Record<string, any> = {}) {
    const gateway = {
      sendC2CMessage: async (openid: string, payload: any) => {
        sent.push({ openid, payload });
        return { ok: true, status: 200, body: { id: 'ROBOT1.0_MOCK_OUT' } };
      },
      sendInputNotify: async () => ({ ok: true, status: 200, body: { id: 'NOTIFY_1' } }),
      deleteC2CMessage: async () => ({ ok: true, status: 200, body: {} }),
      uploadC2CMedia: async () => ({ ok: true, status: 200, body: { file_info: 'fi' } }),
    };
    const sessionManager = {
      sessionIdToPeer: (id: string) => {
        if (id.startsWith('kujira-user-')) return `user_${id.slice('kujira-user-'.length)}`;
        return id;
      },
    };
    const ctx = new Context();
    const bridge = new OutboundStreamBridge(ctx, {
      gateway: gateway as any,
      sessionManager: sessionManager as any,
      getConfig: () => ({ ...config }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    return { bridge, ctx };
  }

  it('契约 1: 用户侧静默原则：当 assistant/message 包含 TextBlock 和 tool-call 块时，绝对静默不下发', async () => {
    const sent: Array<{ openid: string; payload: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: MOCK_SESSION_ID };

    bridge.trackInboundContext(MOCK_PEER, {
      msg_id: 'ROBOT1.0_IN_1',
      openid: MOCK_OPENID,
      from_user: MOCK_OPENID,
    });

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    const blocksWithToolCall: ContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Thinking about weather in Beijing...',
      },
      {
        type: 'text',
        text: '好的，正在为您查询北京市的天气情况，请稍候...',
      },
      {
        type: 'tool-call',
        id: 'call_1' as any,
        name: 'get_weather',
        arguments: '{"city":"Beijing"}',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: blocksWithToolCall },
      },
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('契约 2: 纯文本输出：即便 assistant/message 仅包含 TextBlock，未调 send_qq_message 时依然绝对静默', async () => {
    const sent: Array<{ openid: string; payload: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: MOCK_SESSION_ID };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    const pureTextBlocks: ContentBlock[] = [
      {
        type: 'text',
        text: '这是模型生成的普通回复文本，但没有通过 send_qq_message 发送。',
      },
    ];

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: pureTextBlocks },
      },
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('契约 3: turn/end 结束时绝对不补发任何兜底文本', async () => {
    const sent: Array<{ openid: string; payload: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: MOCK_SESSION_ID };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('契约 4: 多步交互场景中，跨多 Step 的思考、正文与工具调用，全程保持静默', async () => {
    const sent: Array<{ openid: string; payload: any }> = [];
    const { bridge } = makeMockBridge(sent);
    const session = { id: MOCK_SESSION_ID };

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/start',
      data: { turn: 1 },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'Step 1' },
            { type: 'text', text: '开始执行步骤 1' },
            { type: 'tool-call', id: 'c1' as any, name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'tool-call', id: 'c2' as any, name: 'bash', arguments: '{}' }],
        },
      },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 3,
        message: {
          content: [{ type: 'text', text: '全部步骤执行完成。' }],
        },
      },
    } as any);

    await bridge.handleSessionEvent(session as any, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any);

    expect(sent).toHaveLength(0);
  });
});

describe('契约 5: 真实装配下验证用户侧静默原则与被动锚点失效降级主动消息', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;
  let outboundRequests: Array<{ url: string; body: Record<string, any> }> = [];
  let failPassiveAnchorOnce = false;

  beforeEach(async () => {
    outboundRequests = [];
    failPassiveAnchorOnce = false;
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-silence-'));
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
        return new Response(JSON.stringify({ access_token: 'mock-silence-tok', expires_in: 7200 }), {
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
        outboundRequests.push({ url, body });
        if (failPassiveAnchorOnce && body.msg_id) {
          failPassiveAnchorOnce = false;
          return new Response(
            JSON.stringify({ code: 40034128, message: 'passive message reply limit reached' }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          );
        }
        outSeq += 1;
        return new Response(
          JSON.stringify({
            id: `ROBOT1.0_OUT_S_${outSeq}`,
            timestamp: new Date().toISOString(),
            ext_info: { ref_idx: `REFIDX_OUT_S_${outSeq}` },
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

  it('真实装配下：向 session 派发 assistant/message 与 turn/end 时出站网关绝对静默，且仅显式发送可触发并支持被动失效主动降级', async () => {
    const agents: any = booted!.ctx.get('agents');
    const agentCwd = path.join(tmpHome, 'agent-cwd');
    await fsp.mkdir(agentCwd, { recursive: true });
    const handle = await agents.create({
      sessionId: MOCK_SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: agentCwd },
    });
    const agent = handle.agent || handle;
    const session = agent.session;

    const outboundBridge = booted!.ctx.get('kujira-outbound-bridge') as OutboundStreamBridge;
    outboundBridge.registerPeerOpenid(MOCK_PEER, MOCK_OPENID);
    outboundBridge.trackInboundContext(MOCK_PEER, {
      msg_id: 'ROBOT1.0_EXPIRED_SLOT',
      openid: MOCK_OPENID,
      from_user: MOCK_OPENID,
    });

    // 1. 派发 assistant/message 与 turn/end -> QQ 出站请求必须严格为 0
    expect(() => {
      (booted!.ctx as any).emit('session/event', session, {
        seq: 0,
        type: 'turn/start',
        data: { turn: 1 },
      });
      (booted!.ctx as any).emit('session/event', session, {
        seq: 1,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: 'reasoning', text: '内部思考' },
              { type: 'text', text: '未通过 send_qq_message 发送的文本' },
            ],
          },
        },
      });
      (booted!.ctx as any).emit('session/event', session, {
        seq: 2,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 50));
    expect(outboundRequests).toHaveLength(0);

    // 2. 经由真实装配工具 send_qq_message 显式发信：若入站锚点遇 40034128 失效，自动降级为无 msg_id 主动消息送达
    failPassiveAnchorOnce = true;
    const provider = booted!.ctx.get('kujiraBridgeTools') as any;
    provider.registerTools(booted!.ctx);
    const toolsService = booted!.ctx.get('tools') as any;
    const sendTool = toolsService.get('send_qq_message');
    expect(sendTool).toBeDefined();

    const res = await sendTool.execute(
      { message: '显式发送正式消息' },
      { agent: { session: { id: MOCK_SESSION_ID } } }
    );
    expect(res.success).toBe(true);
    expect(outboundRequests).toHaveLength(2);
    expect(outboundRequests[0]!.body.msg_id).toBe('ROBOT1.0_EXPIRED_SLOT');
    expect(outboundRequests[1]!.body.msg_id).toBeUndefined();
    expect(outboundRequests[1]!.body.msg_seq).toBeUndefined();
    expect(outboundRequests[1]!.body.markdown?.content).toBe('显式发送正式消息');
  });
});
