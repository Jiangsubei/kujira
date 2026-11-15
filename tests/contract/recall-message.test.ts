/**
 * 契约测试: recall_message 消息撤回工具契约与真实装配闭环 (Recall Message Tool Contract)
 *
 * 覆盖规范清单:
 * 契约 1: bootDshKujira({ mountPlugin: true }) 真实装配下，Kujira 单聊会话包含 recall_message 工具；WebUI 沙箱排除；
 * 契约 2: 真实装配闭环下，recall_message 仅认出站短 ID msg_self_<n>，底层换取真实 ROBOT1.0_... 调 DELETE /v2/users/{openid}/messages/{id} 撤回后置 recalled=1（自身原文保留）；
 * 契约 3: 入站短 ID (msg_<n>) 与非短 ID 本地拦截（不浪费 API 请求），平台错码 40061002 与 40064004（超 2 分钟）如实透传，绝不篡改 recalled；
 * 契约 4: 参数校验与串行队列调度保障（通过 PerPeerSerialSender 串行执行）；
 * 契约 5: DSH Lossless JSON 契约（执行返回值所有键值绝无 undefined）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import { Context } from '@deepseek-ai/cordis';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import type { SessionManager } from '../../src/gateway/session.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import { openidToPeer } from '../../src/utils/peer.js';
import {
  recallMessage,
  registerAgentTools,
  resetGlobalToolContext,
} from '../../src/tools/index.js';
import { PerPeerSerialSender } from '../../src/outbound/queue.js';

const nativeFetch = globalThis.fetch;

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_APP_ID = 'app_kujira_mock';
const MOCK_APP_SECRET = 'secret_kujira_mock';
const MOCK_BOT_ID = 'bot_kujira_01';

function hasUndefinedValue(obj: unknown): boolean {
  if (obj === undefined) return true;
  if (obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => hasUndefinedValue(item));
  }
  for (const val of Object.values(obj)) {
    if (val === undefined) return true;
    if (typeof val === 'object' && hasUndefinedValue(val)) return true;
  }
  return false;
}

class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<(ev: any) => void>>();
  private seq = 1;

  constructor(public readonly url: string) {
    FakeWs.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
      this.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      });
    });
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.op === 2 || frame.op === 6) {
      this.emit('message', {
        data: JSON.stringify({
          op: 0,
          s: this.seq++,
          t: 'READY',
          d: {
            version: 1,
            session_id: 'sess-recall-1',
            user: { id: MOCK_BOT_ID, username: 'Kujira助手', bot: true },
          },
        }),
      });
    } else if (frame.op === 1) {
      this.emit('message', { data: JSON.stringify({ op: 11 }) });
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  emitDispatch(t: string, d: unknown): void {
    this.emit('message', {
      data: JSON.stringify({ op: 0, s: this.seq++, t, d }),
    });
  }

  private emit(type: string, ev: any): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时: ${label}`);
}

describe('契约 1-3: recall_message 真实装配、会话隔离与单聊撤回闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let apiCalls: Array<{ method: string; url: string; authorization?: string; body?: any }>;
  let deleteHandler: (msgId: string) => { status: number; body: Record<string, unknown> };
  let capturedFollowups: any[];

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  beforeEach(async () => {
    FakeWs.instances = [];
    apiCalls = [];
    capturedFollowups = [];
    deleteHandler = () => ({ status: 200, body: {} });

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-recall-'));
    await fsp.writeFile(
      path.join(tmpHome, '.credentials.yaml'),
      [
        'version: 1',
        'refs:',
        `  QQ_BOT_APP_ID: "${MOCK_APP_ID}"`,
        `  QQ_BOT_SECRET: "${MOCK_APP_SECRET}"`,
        '',
      ].join('\n'),
      'utf8'
    );

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const authorization = headers.get('authorization') ?? undefined;

      if (url === 'https://bots.qq.com/app/getAppAccessToken') {
        return new Response(JSON.stringify({ access_token: 'mock_access_token', expires_in: 7200 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://api.sgroup.qq.com/gateway') {
        return new Response(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://api.sgroup.qq.com/')) {
        const parsed = new URL(url);
        let parsedBody: any;
        if (typeof init?.body === 'string' && init.body) {
          parsedBody = JSON.parse(init.body);
        }
        apiCalls.push({ method, url, authorization, body: parsedBody });

        if (method === 'POST' && parsed.pathname === `/v2/users/${MOCK_OPENID}/messages`) {
          if (parsedBody?.msg_type === 6) {
            return new Response(
              JSON.stringify({
                id: 'ROBOT1.0_NOTIFY_RECALL_1',
                timestamp: '2026-11-11T12:00:01+08:00',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              id: 'ROBOT1.0_OUT_RECALL_1',
              timestamp: '2026-11-11T12:00:05+08:00',
              ext_info: { ref_idx: 'REFIDX_OUT_RECALL_1' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const delPrefix = `/v2/users/${MOCK_OPENID}/messages/`;
        if (method === 'DELETE' && parsed.pathname.startsWith(delPrefix)) {
          const msgId = decodeURIComponent(parsed.pathname.slice(delPrefix.length));
          const resp = deleteHandler(msgId);
          return new Response(JSON.stringify(resp.body), {
            status: resp.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return nativeFetch(input, init);
    };

    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    vi.stubGlobal('fetch', mockFetch);

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
    });

    const gateway = booted.ctx.get('kujira-gateway') as KujiraGatewayClient;
    const presetsSvc: any = (booted.ctx as any).agentPresets || booted.ctx.get?.('agentPresets');
    await waitUntil(async () => {
      if (!gateway.getStatus().ready || FakeWs.instances.length === 0) return false;
      if (presetsSvc?.list) {
        const list = await presetsSvc.list();
        return Array.isArray(list) && list.some((p: any) => p.id === 'kujira-session');
      }
      return true;
    }, 5000, 'gateway ready and kujira-session registered');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function preparePeerAgent() {
    const sm = booted.ctx.get('kujira-session') as SessionManager;
    const agent = await sm.getOrCreateAgent(MOCK_PEER);
    (agent as any).followup = (msg: any) => {
      capturedFollowups.push(msg);
    };
    (agent as any).steer = (msg: any) => {
      capturedFollowups.push(msg);
    };
    return agent;
  }

  it('1.1 真实装配下：Kujira 单聊会话 assemble 包含 recall_message 工具，WebUI 沙箱排除', async () => {
    const agent = await preparePeerAgent();
    const asmUser = await (booted.ctx as any).systemPrompt.assemble({ scope: agent, agent });
    const userToolNames = (asmUser.tools as any[]).map((t: any) => t.name);
    expect(userToolNames).toContain('recall_message');
    expect(userToolNames).toContain('send_qq_message');

    const webWs = path.join(tmpHome, 'web-ws');
    await fsp.mkdir(webWs, { recursive: true });
    const webHandle = await (booted.ctx as any).agents.create({
      sessionId: 'web-session-1',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: webWs },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await (booted.ctx as any).systemPrompt.assemble({ scope: webAgent, agent: webAgent });
    const webToolNames = (asmWeb.tools as any[]).map((t: any) => t.name);
    expect(webToolNames).not.toContain('recall_message');
  });

  it('1.2 真实装配闭环：发送出站消息返回短 ID 后调用装配的 recall_message 撤回 msg_self_1，底层调 DELETE ROBOT1.0_... 并置 recalled=1（保留自身原文）', async () => {
    const agent = await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_RECALL_1',
      content: '发一条然后撤回',
      timestamp: '2026-11-11T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IN_RECALL_1'] },
    });

    await waitUntil(
      () =>
        capturedFollowups.length === 1 &&
        apiCalls.some((c) => c.method === 'POST' && c.body?.msg_type === 6),
      5000,
      'inbound wakeup and input notify'
    );

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    const recallTool = toolsSvc.get('recall_message', agent);
    expect(sendTool).toBeDefined();
    expect(recallTool).toBeDefined();

    const originalText = '这条出站消息稍后撤回';
    const sendRes = await sendTool.execute({ message: originalText }, { agent });
    expect(sendRes.success).toBe(true);
    expect(sendRes.message_id).toBe('msg_self_1');
    expect((sendRes as any).ref_idx).toBeUndefined();

    // 验证出站消息已通过 onMessageSent -> recordOutboundSelfMessage 落库并分配 msg_self_1
    await waitUntil(() => {
      const db = new Database(dbPath(), { readonly: true });
      try {
        return Boolean(db.prepare('SELECT msg_id FROM messages WHERE msg_id = ?').get('ROBOT1.0_OUT_RECALL_1'));
      } finally {
        db.close();
      }
    }, 3000, 'self record saved');

    const recallRes = await recallTool.execute({ message_id: 'msg_self_1' }, { agent });
    expect(recallRes.success).toBe(true);
    expect(recallRes.message).toContain('msg_self_1');
    expect(recallRes.message).not.toContain('ROBOT1.0_');
    expect(hasUndefinedValue(recallRes)).toBe(false);

    const deleteCall = apiCalls.find((c) => c.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.url).toBe(
      `https://api.sgroup.qq.com/v2/users/${MOCK_OPENID}/messages/ROBOT1.0_OUT_RECALL_1`
    );
    expect(deleteCall?.authorization).toBe('QQBot mock_access_token');

    const db = new Database(dbPath(), { readonly: true });
    try {
      const row = db
        .prepare('SELECT msg_id, short_id, self, recalled, content FROM messages WHERE msg_id = ?')
        .get('ROBOT1.0_OUT_RECALL_1') as any;
      expect(row).toBeDefined();
      expect(row.short_id).toBe('msg_self_1');
      expect(row.self).toBe(1);
      expect(row.recalled).toBe(1);
      // 自身消息撤回后必须保留原文
      expect(row.content).toBe(originalText);
    } finally {
      db.close();
    }
  });

  it('1.3 入站短 ID / 非短 ID 本地直接拦截（不打 DELETE），遇 40061002 / 40064004 平台报错透传绝不篡改 recalled', async () => {
    const agent = await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_RECALL_2',
      content: '试试撤回我的消息',
      timestamp: '2026-11-11T12:01:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IN_RECALL_2'] },
    });

    await waitUntil(
      () =>
        capturedFollowups.length === 1 &&
        apiCalls.some((c) => c.method === 'POST' && c.body?.msg_type === 6),
      5000,
      'inbound wakeup and input notify'
    );

    await waitUntil(() => {
      const db = new Database(dbPath(), { readonly: true });
      try {
        return Boolean(db.prepare('SELECT msg_id FROM messages WHERE msg_id = ?').get('ROBOT1.0_IN_RECALL_2'));
      } finally {
        db.close();
      }
    }, 3000, 'inbound message saved');

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    const recallTool = toolsSvc.get('recall_message', agent);
    expect(sendTool).toBeDefined();
    expect(recallTool).toBeDefined();

    // 先发送一条真实出站消息以便后续通过 msg_self_1 验证平台报错透传
    const sendRes = await sendTool.execute({ message: '待验证撤回错误透传的消息' }, { agent });
    expect(sendRes.success).toBe(true);
    expect(sendRes.message_id).toBe('msg_self_1');

    // 1. 本地拦截：入站短 ID msg_1 不发起任何 DELETE API 请求
    const resInboundShort = await recallTool.execute({ message_id: 'msg_1' }, { agent });
    expect(resInboundShort.success).toBe(false);
    expect(resInboundShort.error).toContain('INBOUND_NOT_RECALLABLE');
    expect(resInboundShort.error).toContain('只能撤回机器人自身发出的出站消息（msg_self_*）');
    expect(hasUndefinedValue(resInboundShort)).toBe(false);
    expect(apiCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    // 2. 本地拦截：非短 ID（原始 ROBOT1.0_* / 数字串）不发起任何 DELETE API 请求
    const resRawId = await recallTool.execute({ message_id: 'ROBOT1.0_IN_RECALL_2' }, { agent });
    expect(resRawId.success).toBe(false);
    expect(resRawId.error).toContain('INVALID_SHORT_ID');
    expect(resRawId.error).toContain('请传入有效的短出站消息 ID（如 msg_self_8）');
    expect(hasUndefinedValue(resRawId)).toBe(false);

    const resDigits = await recallTool.execute({ message_id: '123456' }, { agent });
    expect(resDigits.success).toBe(false);
    expect(resDigits.error).toContain('INVALID_SHORT_ID');
    expect(resDigits.error).toContain('请传入有效的短出站消息 ID（如 msg_self_8）');
    expect(hasUndefinedValue(resDigits)).toBe(false);
    expect(apiCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    // 3. 40061002: 平台返回入站/无效 ID 报错时如实透传且绝不篡改 recalled
    deleteHandler = () => ({
      status: 400,
      body: { code: 40061002, message: 'invalid message id' },
    });
    const resApiInbound = await recallTool.execute({ message_id: 'msg_self_1' }, { agent });
    expect(resApiInbound.success).toBe(false);
    expect(resApiInbound.error).toContain('40061002');
    expect(resApiInbound.error).toContain('入站消息');
    expect(hasUndefinedValue(resApiInbound)).toBe(false);
    expect(apiCalls.filter((c) => c.method === 'DELETE')).toHaveLength(1);

    // 4. 40064004: 超 2 分钟硬时限报错透传且绝不篡改 recalled
    deleteHandler = () => ({
      status: 400,
      body: { code: 40064004, message: 'exceeded 2 minutes recall limit' },
    });
    const resExpired = await recallTool.execute({ message_id: 'msg_self_1' }, { agent });
    expect(resExpired.success).toBe(false);
    expect(resExpired.error).toContain('40064004');
    expect(resExpired.error).toContain('2 分钟');
    expect(hasUndefinedValue(resExpired)).toBe(false);
    expect(apiCalls.filter((c) => c.method === 'DELETE')).toHaveLength(2);

    const db = new Database(dbPath(), { readonly: true });
    try {
      const inboundRow = db
        .prepare('SELECT recalled FROM messages WHERE msg_id = ?')
        .get('ROBOT1.0_IN_RECALL_2') as any;
      expect(inboundRow.recalled).toBe(0);
      const outboundRow = db
        .prepare('SELECT recalled FROM messages WHERE msg_id = ?')
        .get('ROBOT1.0_OUT_RECALL_1') as any;
      expect(outboundRow.recalled).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('契约 4-5: recallMessage 参数校验、串行调度与 Lossless JSON 契约', () => {
  beforeEach(() => {
    resetGlobalToolContext();
  });

  it('4.1 异常校验：缺少 ID、传入数字 ID、入站短 ID、非短 ID、非单聊会话或网关未连接均安全拦截', async () => {
    const deleteC2CMock = vi.fn();
    const mockGateway: any = { deleteC2CMessage: deleteC2CMock };

    const resEmpty = await recallMessage({} as any, {
      gateway: mockGateway,
      peer: MOCK_PEER,
      openid: MOCK_OPENID,
    });
    expect(resEmpty.success).toBe(false);
    expect(resEmpty.error).toContain('INVALID_SHORT_ID');
    expect(resEmpty.error).toContain('请传入有效的短出站消息 ID（如 msg_self_8）');
    expect(hasUndefinedValue(resEmpty)).toBe(false);

    const resNumeric = await recallMessage({ message_id: 123456 } as any, {
      gateway: mockGateway,
      peer: MOCK_PEER,
      openid: MOCK_OPENID,
    });
    expect(resNumeric.success).toBe(false);
    expect(resNumeric.error).toContain('INVALID_SHORT_ID');
    expect(resNumeric.error).toContain('请传入有效的短出站消息 ID（如 msg_self_8）');
    expect(hasUndefinedValue(resNumeric)).toBe(false);

    const resRawStr = await recallMessage(
      { message_id: 'ROBOT1.0_OUT_1' },
      { gateway: mockGateway, peer: MOCK_PEER, openid: MOCK_OPENID }
    );
    expect(resRawStr.success).toBe(false);
    expect(resRawStr.error).toContain('INVALID_SHORT_ID');
    expect(resRawStr.error).toContain('请传入有效的短出站消息 ID（如 msg_self_8）');
    expect(hasUndefinedValue(resRawStr)).toBe(false);

    const resInboundShort = await recallMessage(
      { message_id: 'msg_1' },
      { gateway: mockGateway, peer: MOCK_PEER, openid: MOCK_OPENID }
    );
    expect(resInboundShort.success).toBe(false);
    expect(resInboundShort.error).toContain('INBOUND_NOT_RECALLABLE');
    expect(resInboundShort.error).toContain('只能撤回机器人自身发出的出站消息（msg_self_*）');
    expect(hasUndefinedValue(resInboundShort)).toBe(false);

    const resNonC2C = await recallMessage(
      { message_id: 'msg_self_1' },
      { gateway: mockGateway, peer: 'web-session-1', openid: MOCK_OPENID }
    );
    expect(resNonC2C.success).toBe(false);
    expect(resNonC2C.error).toContain('单聊');
    expect(hasUndefinedValue(resNonC2C)).toBe(false);

    const resNoGateway = await recallMessage(
      { message_id: 'msg_self_1' },
      { gateway: undefined, peer: MOCK_PEER, openid: MOCK_OPENID }
    );
    expect(resNoGateway.success).toBe(false);
    expect(resNoGateway.error).toContain('Gateway 未连接');
    expect(hasUndefinedValue(resNoGateway)).toBe(false);
    expect(deleteC2CMock).not.toHaveBeenCalled();
  });

  it('4.2 串行队列调度：经由 PerPeerSerialSender 保持发送与撤回顺序', async () => {
    const callOrder: string[] = [];
    const deleteC2CMock = vi.fn(async (_openid: string, msgId: string) => {
      callOrder.push(`delete:${msgId}`);
      return { ok: true, status: 200, body: {} };
    });
    const mockGateway: any = { deleteC2CMessage: deleteC2CMock };
    const mockDb: any = {
      getMessageByShortId: (peer: string, shortId: string) =>
        peer === MOCK_PEER && shortId === 'msg_self_1'
          ? { msg_id: 'ROBOT1.0_OUT_SERIAL_1', short_id: 'msg_self_1', peer: MOCK_PEER, self: 1 }
          : null,
      markRecalled: vi.fn(),
    };
    const sender = new PerPeerSerialSender();

    void sender.enqueue(MOCK_PEER, async () => {
      await new Promise((r) => setTimeout(r, 20));
      callOrder.push('send:1');
    });

    const res = await recallMessage(
      { message_id: 'msg_self_1' },
      {
        gateway: mockGateway,
        db: mockDb,
        sender,
        peer: MOCK_PEER,
        openid: MOCK_OPENID,
      }
    );

    expect(res.success).toBe(true);
    expect(res.message).toContain('msg_self_1');
    expect(callOrder).toEqual(['send:1', 'delete:ROBOT1.0_OUT_SERIAL_1']);
    expect(hasUndefinedValue(res)).toBe(false);
  });

  it('5.1 defineTool execute 返回值满足 Lossless JSON 红线要求', async () => {
    const appCtx = new Context();
    const registeredTools: any[] = [];
    appCtx.provide('tools');
    appCtx.set('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {};
      },
    });

    const deleteC2CMock = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
    const mockGateway: any = { deleteC2CMessage: deleteC2CMock };
    const shortMap: Record<string, string> = {
      msg_self_1: 'ROBOT1.0_OUT_OK_1',
      msg_self_2: 'ROBOT1.0_OUT_EXP_1',
    };
    const mockDb: any = {
      getOpenidByPeer: () => MOCK_OPENID,
      getMessageByShortId: (peer: string, shortId: string) =>
        peer === MOCK_PEER && shortMap[shortId]
          ? { msg_id: shortMap[shortId], short_id: shortId, peer: MOCK_PEER, self: 1 }
          : null,
      markRecalled: vi.fn(),
    };

    registerAgentTools(appCtx, {
      gateway: mockGateway,
      db: mockDb,
      mediaManager: {} as any,
    });

    const recallTool = registeredTools.find((t) => t.name === 'recall_message');
    expect(recallTool).toBeDefined();

    const mockExec: any = {
      agent: {
        session: { id: `kujira-user-${MOCK_PEER.slice(5)}` },
      },
    };

    const execSuccess = await recallTool.execute({ message_id: 'msg_self_1' }, mockExec);
    expect(execSuccess.success).toBe(true);
    expect(execSuccess.message).toContain('msg_self_1');
    expect(deleteC2CMock).toHaveBeenCalledWith(MOCK_OPENID, 'ROBOT1.0_OUT_OK_1', undefined);
    expect(mockDb.markRecalled).toHaveBeenCalledWith('ROBOT1.0_OUT_OK_1');
    expect(hasUndefinedValue(execSuccess)).toBe(false);

    deleteC2CMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: 40064004,
      message: 'recall window expired',
      body: {},
    } as any);
    const execFail = await recallTool.execute({ message_id: 'msg_self_2' }, mockExec);
    expect(execFail.success).toBe(false);
    expect(execFail.error).toContain('40064004');
    expect(hasUndefinedValue(execFail)).toBe(false);
  });
});
