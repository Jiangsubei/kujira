import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import type { SessionManager, SystemEventHub } from '../../src/gateway/session.js';
import type { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import { getGlobalToolContext } from '../../src/tools/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

/**
 * 契约测试: 回合锚点隔离、40054005 递增重试与 40034128 主动降级修复 (Turn Anchor Fix Contract)
 *
 * 1. 合成 is_synthetic: true 上下文绝不覆盖/擦除当前活跃入站 msg_id，且 inboundMsgIdGetter 对合成回合返回 undefined；
 * 2. 入站唤醒消息头精简为 `[msg_<n>] [时间] 正文`（无 `[QQ私聊]`、无长 ID、无 openid），定时任务唤醒无 `[QQ私聊]` 与 `[msg_...]`；
 * 3. 出站响应 body.id (ROBOT1.0_...) 绝不进入 inbound_reply_slots，不污染被动回复锚点，工具返回短出站 ID (`msg_self_<n>`)；
 * 4. 遇 40054005 自动递增 msg_seq 重试并持久化新 last_seq；
 * 5. 遇 40034128 标记入站锚点 invalidated=1 并自动降级无 msg_id/msg_seq 主动发送。
 */

const nativeFetch = globalThis.fetch;

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_APP_ID = 'app_kujira_mock';
const MOCK_APP_SECRET = 'secret_kujira_mock';
const MOCK_BOT_ID = 'bot_kujira_01';

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
            session_id: 'sess-anchor-1',
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

function extractFollowupText(msg: any): string {
  return Array.isArray(msg?.content)
    ? msg.content.map((c: any) => c?.text || '').join('')
    : String(msg?.content || '');
}

describe('契约测试: 入站锚点隔离、40054005 重试与 40034128 主动降级 (Turn Anchor Fix)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let capturedFollowups: any[];
  let postedBodies: any[];
  let postResponder: (body: any) => { status: number; body: Record<string, unknown> };
  let outSeq: number;

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  beforeEach(async () => {
    FakeWs.instances = [];
    capturedFollowups = [];
    postedBodies = [];
    outSeq = 0;
    postResponder = (body) => {
      if (body?.msg_type === 6) {
        return {
          status: 200,
          body: {
            id: 'ROBOT1.0_NOTIFY_ANCHOR',
            timestamp: '2026-11-11T12:30:00+08:00',
          },
        };
      }
      outSeq += 1;
      return {
        status: 200,
        body: {
          id: `ROBOT1.0_OUT_ANCHOR_${outSeq}`,
          timestamp: '2026-11-11T12:30:00+08:00',
          ext_info: { ref_idx: `REFIDX_OUT_ANCHOR_${outSeq}` },
        },
      };
    };

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-anchor-'));
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
          postedBodies.push(body);
          const res = postResponder(body);
          return new Response(JSON.stringify(res.body), {
            status: res.status,
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
    const capture = (msg: any) => {
      capturedFollowups.push(msg);
    };
    (agent as any).followup = capture;
    (agent as any).steer = capture;
    return agent;
  }

  it('场景 1: is_synthetic: true 不覆盖活跃入站 msg_id 且 inboundMsgIdGetter 对合成上下文隔离返回 undefined', async () => {
    const agent = await preparePeerAgent();
    const bridge = booted.ctx.get('kujira-outbound-bridge') as OutboundStreamBridge;
    const hub = booted.ctx.get('kujira-system-event-hub') as SystemEventHub;
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    // 1. 真实入站消息激活上下文（固定下发 msg_type=6 input_notify 占用 msg_seq=1）
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_ANCHOR_REAL_1',
      content: '你好助手',
      timestamp: '2026-11-11T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_ANCHOR_REAL_1'] },
    });
    await waitUntil(
      () => capturedFollowups.length === 1 && postedBodies.filter((b) => b.msg_type === 6).length === 1,
      3000,
      'inbound 1 and input_notify'
    );

    const inboundPrompt1 = extractFollowupText(capturedFollowups[0]);
    expect(inboundPrompt1).toMatch(/^\[msg_1\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 你好助手$/);
    expect(inboundPrompt1).not.toContain('[QQ私聊]');
    expect(inboundPrompt1).not.toContain('ROBOT1.0_ANCHOR_REAL_1');
    expect(inboundPrompt1).not.toContain(MOCK_OPENID);

    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_REAL_1');
    expect(getGlobalToolContext().inboundMsgIdGetter?.(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_REAL_1');

    // 2. 注入带虚假 msg_id 的合成上下文 + 触发 SystemEventHub scheduled_task
    bridge.trackInboundContext(MOCK_PEER, {
      msg_id: 'SYNTHETIC_FAKE_99',
      from_user: '',
      trigger: 'scheduled',
      is_synthetic: true,
    });
    await hub.dispatchScheduledTask({
      peer: MOCK_PEER,
      taskId: 'task_anchor_1',
      taskType: 'once',
      prompt: '检查锚点隔离',
      timestamp: Date.parse('2026-11-11T12:01:00+08:00'),
    });
    await waitUntil(() => capturedFollowups.length === 2, 3000, 'scheduled wakeup');

    const scheduledPrompt = extractFollowupText(capturedFollowups[1]);
    expect(scheduledPrompt).toContain('系统事件：[定时任务]');
    expect(scheduledPrompt).toContain('检查锚点隔离');
    expect(scheduledPrompt).not.toContain('[QQ私聊]');
    expect(scheduledPrompt).not.toContain('[msg_');
    expect(scheduledPrompt).not.toContain('[消息ID:');
    expect(scheduledPrompt).not.toContain('SYNTHETIC_FAKE_99');

    // 活跃被动锚点未被合成上下文擦除或替换为 SYNTHETIC_FAKE_99
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_REAL_1');
    expect(bridge.getActiveTurnContext(MOCK_PEER)?.msg_id).toBe('ROBOT1.0_ANCHOR_REAL_1');
    expect((bridge.getActiveTurnContext(MOCK_PEER) as any)?.is_synthetic).toBe(true);
    // 工具侧 inboundMsgIdGetter 对合成回合返回 undefined 防误归属
    expect(getGlobalToolContext().inboundMsgIdGetter?.(MOCK_PEER)).toBeUndefined();

    // 合成上下文下调用 send_qq_message 仍使用真实入站锚点 ROBOT1.0_ANCHOR_REAL_1，工具返回短 ID
    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    const res = await sendTool.execute({ message: '定时汇报' }, { agent });
    expect(res.success).toBe(true);
    expect(res.message_id).toBe('msg_self_1');
    expect((res as any).ref_idx).toBeUndefined();

    const textPosts = postedBodies.filter((b) => b.msg_type !== 6);
    expect(textPosts).toHaveLength(1);
    expect(textPosts[0].msg_id).toBe('ROBOT1.0_ANCHOR_REAL_1');
    expect(textPosts[0].msg_seq).toBe(2);

    // 3. 下一条真实入站消息恢复非合成上下文
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_ANCHOR_REAL_2',
      content: '收到啦',
      timestamp: '2026-11-11T12:02:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
    });
    await waitUntil(
      () => capturedFollowups.length === 3 && postedBodies.filter((b) => b.msg_type === 6).length === 2,
      3000,
      'inbound 2 and input_notify 2'
    );
    const inboundPrompt2 = extractFollowupText(capturedFollowups[2]);
    expect(inboundPrompt2).toMatch(/^\[msg_2\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 收到啦$/);
    expect(inboundPrompt2).not.toContain('[QQ私聊]');
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_REAL_2');
    expect(getGlobalToolContext().inboundMsgIdGetter?.(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_REAL_2');

    const db = new Database(dbPath(), { readonly: true });
    try {
      const slotIds = (db.prepare('SELECT msg_id FROM inbound_reply_slots').all() as any[]).map((r) => r.msg_id);
      expect(slotIds).toEqual(['ROBOT1.0_ANCHOR_REAL_1', 'ROBOT1.0_ANCHOR_REAL_2']);
      expect(slotIds).not.toContain('SYNTHETIC_FAKE_99');
    } finally {
      db.close();
    }
  });

  it('场景 2: 出站响应 ROBOT1.0_... 绝不进入 inbound_reply_slots 且不污染被动锚点，工具返回短出站 ID', async () => {
    const agent = await preparePeerAgent();
    const bridge = booted.ctx.get('kujira-outbound-bridge') as OutboundStreamBridge;
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_ANCHOR_IN_2',
      content: '连续回复测试',
      timestamp: '2026-11-11T12:05:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
    });
    await waitUntil(
      () => capturedFollowups.length === 1 && postedBodies.filter((b) => b.msg_type === 6).length === 1,
      3000,
      'inbound and input_notify'
    );

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);

    const r1 = await sendTool.execute({ message: '第一句回复' }, { agent });
    expect(r1.success).toBe(true);
    expect(r1.message_id).toBe('msg_self_1');
    expect((r1 as any).ref_idx).toBeUndefined();

    // 等待自记录落库完成
    await waitUntil(() => {
      const db = new Database(dbPath(), { readonly: true });
      try {
        const row = db
          .prepare('SELECT msg_id, short_id FROM messages WHERE msg_id = ?')
          .get('ROBOT1.0_OUT_ANCHOR_1') as any;
        return Boolean(row && row.short_id === 'msg_self_1');
      } finally {
        db.close();
      }
    }, 3000, 'outbound self saved');

    // 出站 ROBOT1.0_OUT_ANCHOR_1 绝不进入 inbound_reply_slots，锚点仍是 ROBOT1.0_ANCHOR_IN_2
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_IN_2');
    const r2 = await sendTool.execute({ message: '第二句回复' }, { agent });
    expect(r2.success).toBe(true);
    expect(r2.message_id).toBe('msg_self_2');

    const textPosts = postedBodies.filter((b) => b.msg_type !== 6);
    expect(textPosts[1].msg_id).toBe('ROBOT1.0_ANCHOR_IN_2');
    expect(textPosts[1].msg_seq).toBe(3);

    const db = new Database(dbPath(), { readonly: true });
    try {
      const slots = (db.prepare('SELECT msg_id FROM inbound_reply_slots').all() as any[]).map((r) => r.msg_id);
      expect(slots).toEqual(['ROBOT1.0_ANCHOR_IN_2']);
      expect(slots).not.toContain('ROBOT1.0_OUT_ANCHOR_1');
      expect(slots).not.toContain('ROBOT1.0_OUT_ANCHOR_2');
    } finally {
      db.close();
    }
  });

  it('场景 3: 遇 40054005 跨天去重错误自动递增 msg_seq 重试并持久化新 last_seq', async () => {
    const agent = await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_ANCHOR_DEDUP_1',
      content: '去重重试测试',
      timestamp: '2026-11-11T12:10:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
    });
    await waitUntil(
      () => capturedFollowups.length === 1 && postedBodies.filter((b) => b.msg_type === 6).length === 1,
      3000,
      'inbound and input_notify'
    );

    let attempt = 0;
    postResponder = (body) => {
      if (body?.msg_type === 6) {
        return { status: 200, body: { id: 'ROBOT1.0_NOTIFY_DEDUP' } };
      }
      attempt += 1;
      if (attempt <= 2) {
        return {
          status: 400,
          body: { code: 40054005, message: `msg_seq ${body.msg_seq} duplicated` },
        };
      }
      outSeq += 1;
      return {
        status: 200,
        body: {
          id: `ROBOT1.0_OUT_DEDUP_OK_${outSeq}`,
          timestamp: '2026-11-11T12:10:05+08:00',
          ext_info: { ref_idx: `REFIDX_OUT_DEDUP_OK_${outSeq}` },
        },
      };
    };

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);

    const res = await sendTool.execute({ message: '重试成功消息' }, { agent });
    expect(res.success).toBe(true);
    expect(res.message_id).toBe('msg_self_1');

    const textPosts = postedBodies.filter((b) => b.msg_type !== 6);
    expect(textPosts).toHaveLength(3);
    expect(textPosts.map((b) => b.msg_id)).toEqual([
      'ROBOT1.0_ANCHOR_DEDUP_1',
      'ROBOT1.0_ANCHOR_DEDUP_1',
      'ROBOT1.0_ANCHOR_DEDUP_1',
    ]);
    expect(textPosts.map((b) => b.msg_seq)).toEqual([2, 3, 4]);

    const db = new Database(dbPath(), { readonly: true });
    try {
      const slot = db.prepare('SELECT last_seq, invalidated FROM inbound_reply_slots WHERE msg_id = ?').get('ROBOT1.0_ANCHOR_DEDUP_1') as any;
      expect(slot.last_seq).toBe(4);
      expect(slot.invalidated).toBe(0);
    } finally {
      db.close();
    }

    // 下次发送继续从 seq=5 单调递增
    const resNext = await sendTool.execute({ message: '后续消息' }, { agent });
    expect(resNext.success).toBe(true);
    expect(resNext.message_id).toBe('msg_self_2');
    const allTextPosts = postedBodies.filter((b) => b.msg_type !== 6);
    expect(allTextPosts[3].msg_seq).toBe(5);
  });

  it('场景 4: 遇 40034128 失效锚点标记 invalidated=1 并自动降级无 msg_id 主动发送', async () => {
    const agent = await preparePeerAgent();
    const bridge = booted.ctx.get('kujira-outbound-bridge') as OutboundStreamBridge;
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_ANCHOR_EXP_1',
      content: '过期锚点降级测试',
      timestamp: '2026-11-11T12:15:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
    });
    await waitUntil(
      () => capturedFollowups.length === 1 && postedBodies.filter((b) => b.msg_type === 6).length === 1,
      3000,
      'inbound and input_notify'
    );

    postResponder = (body) => {
      if (body?.msg_type === 6) {
        return {
          status: 200,
          body: { id: 'ROBOT1.0_NOTIFY_EXP' },
        };
      }
      if (body.msg_id === 'ROBOT1.0_ANCHOR_EXP_1') {
        return {
          status: 400,
          body: { code: 40034128, message: 'passive reply window expired or limit reached' },
        };
      }
      outSeq += 1;
      return {
        status: 200,
        body: {
          id: `ROBOT1.0_OUT_PROACTIVE_${outSeq}`,
          timestamp: '2026-11-11T12:15:05+08:00',
          ext_info: { ref_idx: `REFIDX_OUT_PROACTIVE_${outSeq}` },
        },
      };
    };

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);

    const res1 = await sendTool.execute({ message: '超窗降级主动发送' }, { agent });
    expect(res1.success).toBe(true);
    expect(res1.message_id).toBe('msg_self_1');

    // 首请求带旧 msg_id/msg_seq 触发 40034128，紧接自动降级无 msg_id/msg_seq 主动发送
    const textPosts1 = postedBodies.filter((b) => b.msg_type !== 6);
    expect(textPosts1).toHaveLength(2);
    expect(textPosts1[0].msg_id).toBe('ROBOT1.0_ANCHOR_EXP_1');
    expect(textPosts1[0].msg_seq).toBe(2);
    expect('msg_id' in textPosts1[1]).toBe(false);
    expect('msg_seq' in textPosts1[1]).toBe(false);

    // 锚点已被标记失效
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBeUndefined();
    const db = new Database(dbPath(), { readonly: true });
    try {
      const slot = db.prepare('SELECT invalidated FROM inbound_reply_slots WHERE msg_id = ?').get('ROBOT1.0_ANCHOR_EXP_1') as any;
      expect(slot.invalidated).toBe(1);
    } finally {
      db.close();
    }

    // 后续再次发送直接使用主动模式，不再尝试已失效锚点
    const res2 = await sendTool.execute({ message: '延续主动发送' }, { agent });
    expect(res2.success).toBe(true);
    expect(res2.message_id).toBe('msg_self_2');
    const textPosts2 = postedBodies.filter((b) => b.msg_type !== 6);
    expect(textPosts2).toHaveLength(3);
    expect('msg_id' in textPosts2[2]).toBe(false);
    expect('msg_seq' in textPosts2[2]).toBe(false);

    // 当新入站消息到来时恢复被动回复能力
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_ANCHOR_FRESH_1',
      content: '我又发消息啦',
      timestamp: '2026-11-11T12:16:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
    });
    await waitUntil(
      () => capturedFollowups.length === 2 && postedBodies.filter((b) => b.msg_type === 6).length === 2,
      3000,
      'fresh inbound and input_notify'
    );
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_ANCHOR_FRESH_1');

    const res3 = await sendTool.execute({ message: '恢复被动回复' }, { agent });
    expect(res3.success).toBe(true);
    expect(res3.message_id).toBe('msg_self_3');
    const textPosts3 = postedBodies.filter((b) => b.msg_type !== 6);
    expect(textPosts3).toHaveLength(4);
    expect(textPosts3[3].msg_id).toBe('ROBOT1.0_ANCHOR_FRESH_1');
    expect(textPosts3[3].msg_seq).toBe(2);
  });
});
