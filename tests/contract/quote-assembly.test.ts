import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import type { SessionManager } from '../../src/gateway/session.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import { openidToPeer } from '../../src/utils/peer.js';
import { formatDateTime } from '../../src/storage/time-parser.js';

/**
 * 契约测试: 单聊引用闭环真实装配 (Quote Assembly Contract)
 *
 * (a) 出站 reply_to 仅接收短 ID（msg_<n> / msg_self_<n>），经 getMessageByShortId 换取 REFIDX_... 后在首片发送 message_reference，拒绝非短 ID；
 * (b) 入站 message_type=103 ref_msg_idx="REFIDX_..." 命中 SQLite getMessageByRefIdx 还原精简短 ID 引用头（含入站图与出站自身消息）；
 * (c) TMP_... 临时索引或未命中 DB 时回退解析 msg_elements[]（保留可用直链 URL），不泄露索引/发送者标识；
 * (d) 双未命中时优雅降级占位，不中断唤醒。
 */

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

const nativeFetch = globalThis.fetch;

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_APP_ID = 'app_kujira_mock';
const MOCK_APP_SECRET = 'secret_kujira_mock';
const MOCK_BOT_ID = 'bot_kujira_01';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 4),
]);

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
            session_id: 'sess-quote-1',
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

describe('契约测试: 单聊引用闭环真实装配 (Quote Assembly Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let servers: http.Server[] = [];
  let capturedFollowups: Array<{ content: string }>;
  let sentBodies: any[];
  let outSeq: number;

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  async function startImageServer(): Promise<string> {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });
    servers.push(srv);
    await new Promise<void>((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = srv.address() as any;
    return `http://127.0.0.1:${addr.port}`;
  }

  async function waitForDbRow(msgId: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const db = new Database(dbPath(), { readonly: true });
      try {
        const row = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId);
        if (row) return row;
      } finally {
        db.close();
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`等待消息记录超时 (msg_id: ${msgId})`);
  }

  beforeEach(async () => {
    FakeWs.instances = [];
    servers = [];
    capturedFollowups = [];
    sentBodies = [];
    outSeq = 0;

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-quote-'));
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
        if (method === 'POST' && parsed.pathname === `/v2/users/${MOCK_OPENID}/messages`) {
          const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : {};
          if (body.msg_type === 6) {
            return new Response(JSON.stringify({ id: 'ROBOT1.0_INPUT_NOTIFY_1' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          sentBodies.push(body);
          outSeq += 1;
          return new Response(
            JSON.stringify({
              id: `ROBOT1.0_Q_OUT_${outSeq}`,
              timestamp: '2026-11-11T12:05:00+08:00',
              ext_info: { ref_idx: `REFIDX_Q_OUT_${outSeq}` },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
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
    for (const s of servers) {
      await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    }
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
    const capture = (msg: any) => {
      const text = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => c?.text || '').join('')
        : String(msg?.content || '');
      capturedFollowups.push({ content: text });
    };
    (agent as any).followup = capture;
    (agent as any).steer = capture;
    return agent;
  }

  it('(a) 出站 reply_to 仅接收短 ID（msg_<n> / msg_self_<n>）换取 REFIDX_... 并在首片发送 message_reference，拒绝非短 ID', async () => {
    const agent = await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_IN_1',
      content: '帮我看一下这条',
      timestamp: '2026-11-11T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_Q_IN_1'] },
    });
    await waitUntil(() => capturedFollowups.length === 1, 3000, 'inbound 1');

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_NO_REF',
      content: '这条没有 ref_idx',
      timestamp: '2026-11-11T12:00:10+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
    });
    await waitUntil(() => capturedFollowups.length === 2, 3000, 'inbound 2');

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);

    // 0. 传入 REFIDX_... 或 ROBOT1.0_... 等非短 ID 必须被直接校验拦截，不打网关
    for (const invalidId of ['REFIDX_Q_IN_1', 'ROBOT1.0_Q_IN_1']) {
      const rejected = await sendTool.execute({ text: '非法引用拦截', reply_to: invalidId }, { agent });
      expectLosslessJson(rejected);
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain('无效的 reply_to 短消息 ID');
    }
    expect(sentBodies).toHaveLength(0);

    // 1. 传入入站短 ID ('msg_1')，经 getMessageByShortId 查得 REFIDX_Q_IN_1 后发送 message_reference，仅返回短出站 ID
    const r1 = await sendTool.execute({ text: '引用入站短 ID', reply_to: 'msg_1' }, { agent });
    expectLosslessJson(r1);
    expect(r1.success).toBe(true);
    expect(r1.message_id).toBe('msg_self_1');
    expect((r1 as any).ref_idx).toBeUndefined();
    expect(sentBodies[0].message_reference).toEqual({ message_id: 'REFIDX_Q_IN_1' });

    // 2. 传入出站短 ID ('msg_self_1')，同样可查库换取 REFIDX_Q_OUT_1 下发引用
    const r2 = await sendTool.execute({ text: '引用出站短 ID', reply_to: 'msg_self_1' }, { agent });
    expectLosslessJson(r2);
    expect(r2.success).toBe(true);
    expect(r2.message_id).toBe('msg_self_2');
    expect((r2 as any).ref_idx).toBeUndefined();
    expect(sentBodies[1].message_reference).toEqual({ message_id: 'REFIDX_Q_OUT_1' });

    // 3. 超长（<=6000 字符且 >16 KiB UTF-8 字节）分片回复仅首片附 message_reference，后续分片不重复携带
    const longText = `${'🐳'.repeat(4500)}\n${'🐳'.repeat(1000)}`;
    const r3 = await sendTool.execute({ text: longText, reply_to: 'msg_1' }, { agent });
    expectLosslessJson(r3);
    expect(r3.success).toBe(true);
    expect(r3.message_id).toMatch(/^msg_self_[1-9]\d*$/);
    expect(sentBodies.length).toBeGreaterThanOrEqual(4);
    expect(sentBodies[2].message_reference).toEqual({ message_id: 'REFIDX_Q_IN_1' });
    expect(sentBodies[3].message_reference).toBeUndefined();

    // 4. 目标消息 ('msg_2') 无 ref_idx 时不伪造 message_reference
    const beforeIdx = sentBodies.length;
    const r4 = await sendTool.execute({ text: '无索引兜底', reply_to: 'msg_2' }, { agent });
    expectLosslessJson(r4);
    expect(r4.success).toBe(true);
    expect(sentBodies[beforeIdx].message_reference).toBeUndefined();
  });

  it('(b) 入站 message_type=103 ref_msg_idx="REFIDX_..." 命中 SQLite getMessageByRefIdx 还原精简短 ID 引用（含图片与自身出站）', async () => {
    const agent = await preparePeerAgent();
    const baseUrl = await startImageServer();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    // 1. 前置入站图片消息（带 msg_idx=REFIDX_Q_IMG_1）
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_IMG_1',
      content: '',
      timestamp: '2026-11-11T12:01:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户A' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_Q_IMG_1'] },
      attachments: [
        {
          content_type: 'image/png',
          filename: 'chart.png',
          size: PNG_BYTES.length,
          url: `${baseUrl}/chart.png?rkey=mock_secret`,
        },
      ],
    });
    const imgRow = await waitForDbRow('ROBOT1.0_Q_IMG_1');
    expect(imgRow.short_id).toBe('msg_1');
    expect(imgRow.local_path).toBeTruthy();
    expect(imgRow.ref_idx).toBe('REFIDX_Q_IMG_1');

    // 2. 用户引用该图片发起 message_type=103
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_REPLY_IMG',
      content: '说的就是这张图',
      timestamp: '2026-11-11T12:01:10+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户A' },
      message_type: 103,
      message_scene: { ext: ['msg_idx=REFIDX_Q_REPLY_IMG', 'ref_msg_idx=REFIDX_Q_IMG_1'] },
      msg_elements: [{ content: '兜底占位文本', message_type: 0, msg_idx: 'REFIDX_Q_IMG_1' }],
    });

    const replyRow = await waitForDbRow('ROBOT1.0_Q_REPLY_IMG');
    await waitUntil(() => capturedFollowups.length >= 2, 3000, 'quote image followup');

    expect(replyRow.short_id).toBe('msg_2');
    expect(replyRow.type).toBe('reply');
    expect(replyRow.reply_to).toBe('REFIDX_Q_IMG_1');
    expect(replyRow.ref_idx).toBe('REFIDX_Q_REPLY_IMG');
    const prompt1 = capturedFollowups[1]!.content;
    expect(prompt1).toBe(
      `[msg_2] [${formatDateTime(replyRow.time)}] [引用回复: "[msg_1] [${formatDateTime(imgRow.time)}] [图片:${imgRow.local_path}]"] 说的就是这张图`
    );
    expect(prompt1).not.toContain('兜底占位文本');
    expect(prompt1).not.toContain('[QQ私聊]');
    expect(prompt1).not.toContain(MOCK_OPENID);
    expect(prompt1).not.toContain('测试用户A');
    expect(prompt1).not.toContain('ROBOT1.0_');
    expect(prompt1).not.toContain('REFIDX_');

    // 3. 机器人发出出站消息（返回 ext_info.ref_idx=REFIDX_Q_OUT_1），随后用户引用该出站消息
    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    const sent = await sendTool.execute({ text: '这是机器人之前发的话' }, { agent });
    expectLosslessJson(sent);
    expect(sent.success).toBe(true);
    expect(sent.message_id).toBe('msg_self_1');
    expect((sent as any).ref_idx).toBeUndefined();
    const outRow = await waitForDbRow('ROBOT1.0_Q_OUT_1');
    expect(outRow.short_id).toBe('msg_self_1');
    expect(outRow.ref_idx).toBe('REFIDX_Q_OUT_1');

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_REPLY_SELF',
      content: '你刚才说的这句很对',
      timestamp: '2026-11-11T12:01:20+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户A' },
      message_type: 103,
      message_scene: { ext: ['msg_idx=REFIDX_Q_REPLY_SELF', 'ref_msg_idx=REFIDX_Q_OUT_1'] },
    });

    const replySelfRow = await waitForDbRow('ROBOT1.0_Q_REPLY_SELF');
    await waitUntil(() => capturedFollowups.length >= 3, 3000, 'quote self followup');
    expect(replySelfRow.short_id).toBe('msg_3');
    const prompt2 = capturedFollowups[2]!.content;
    expect(prompt2).toBe(
      `[msg_3] [${formatDateTime(replySelfRow.time)}] [引用回复: "[msg_self_1] [${formatDateTime(outRow.time)}] 这是机器人之前发的话"] 你刚才说的这句很对`
    );
    expect(prompt2).not.toContain('[QQ私聊]');
    expect(prompt2).not.toContain(MOCK_OPENID);
    expect(prompt2).not.toContain(MOCK_BOT_ID);
    expect(prompt2).not.toContain('Kujira助手');
    expect(prompt2).not.toContain('测试用户A');
    expect(prompt2).not.toContain('ROBOT1.0_');
    expect(prompt2).not.toContain('REFIDX_');
  });

  it('(c) TMP_... 临时索引或未命中本地 SQLite 时回退解析 msg_elements[] 并保留可用直链 URL', async () => {
    await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    // 1. TMP_... 临时索引不查 DB，直接解析 msg_elements[] 并原样保留可用 URL
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_TMP_1',
      content: '针对这段复合引用回复一下',
      timestamp: '2026-11-11T12:02:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '提问者' },
      message_type: 103,
      message_scene: { ext: ['msg_idx=REFIDX_Q_TMP_1', 'ref_msg_idx=TMP_COMPOSITE_1'] },
      msg_elements: [
        { content: '复合引用第一段', message_type: 0, msg_idx: 'TMP_COMPOSITE_1' },
        { content: 'URL:https://example.com/pic.png?rkey=mock_secret', message_type: 0 },
      ],
    });

    const tmpRow = await waitForDbRow('ROBOT1.0_Q_TMP_1');
    await waitUntil(() => capturedFollowups.length >= 1, 3000, 'tmp quote followup');
    const promptTmp = capturedFollowups[0]!.content;
    expect(promptTmp).toBe(
      `[msg_1] [${formatDateTime(tmpRow.time)}] [引用回复: "复合引用第一段\nURL:https://example.com/pic.png?rkey=mock_secret"] 针对这段复合引用回复一下`
    );
    expect(promptTmp).toContain('URL:https://example.com/pic.png?rkey=mock_secret');
    expect(promptTmp).not.toContain('[图片(链接已脱敏)]');
    expect(promptTmp).not.toContain('TMP_COMPOSITE_1');
    expect(promptTmp).not.toContain('ROBOT1.0_');
    expect(promptTmp).not.toContain('REFIDX_');
    expect(promptTmp).not.toContain(MOCK_OPENID);
    expect(promptTmp).not.toContain('提问者');
    expect(promptTmp).not.toContain('[QQ私聊]');

    // 2. REFIDX_... 未命中本地库，回退 msg_elements[]
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_MISS_FB',
      content: '这句话什么意思',
      timestamp: '2026-11-11T12:02:10+08:00',
      author: { user_openid: MOCK_OPENID, username: '提问者' },
      message_type: 103,
      message_scene: { ext: ['msg_idx=REFIDX_Q_MISS_FB', 'ref_msg_idx=REFIDX_NOT_IN_DB'] },
      msg_elements: [{ content: '启动前的历史重要消息', message_type: 0, msg_idx: 'REFIDX_NOT_IN_DB' }],
    });

    const missRow = await waitForDbRow('ROBOT1.0_Q_MISS_FB');
    await waitUntil(() => capturedFollowups.length >= 2, 3000, 'miss fallback followup');
    const promptMiss = capturedFollowups[1]!.content;
    expect(promptMiss).toBe(
      `[msg_2] [${formatDateTime(missRow.time)}] [引用回复: "启动前的历史重要消息"] 这句话什么意思`
    );
    expect(promptMiss).not.toContain('REFIDX_NOT_IN_DB');
    expect(promptMiss).not.toContain('ROBOT1.0_');
    expect(promptMiss).not.toContain(MOCK_OPENID);
    expect(promptMiss).not.toContain('提问者');
    expect(promptMiss).not.toContain('[QQ私聊]');
  });

  it('(d) 本地库与 msg_elements[] 均未命中时优雅降级占位，唤醒不中断', async () => {
    await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_Q_EXPIRED',
      content: '之前的结论是什么',
      timestamp: '2026-11-11T12:03:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '提问者' },
      message_type: 103,
      message_scene: { ext: ['msg_idx=REFIDX_Q_EXPIRED', 'ref_msg_idx=REFIDX_EXPIRED_NONE'] },
    });

    const expiredRow = await waitForDbRow('ROBOT1.0_Q_EXPIRED');
    await waitUntil(() => capturedFollowups.length >= 1, 3000, 'degraded quote followup');
    const prompt = capturedFollowups[0]!.content;
    expect(prompt).toBe(
      `[msg_1] [${formatDateTime(expiredRow.time)}] [引用回复: "〔历史引用消息：内容已过期或无法获取〕"] 之前的结论是什么`
    );
    expect(prompt).not.toContain('REFIDX_EXPIRED_NONE');
    expect(prompt).not.toContain('ROBOT1.0_');
    expect(prompt).not.toContain(MOCK_OPENID);
    expect(prompt).not.toContain('提问者');
    expect(prompt).not.toContain('[QQ私聊]');
  });
});
