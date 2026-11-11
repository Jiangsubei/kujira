import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import type { SessionManager, SystemEventHub } from '../../src/gateway/session.js';
import type { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import { openidToPeer } from '../../src/utils/peer.js';

/**
 * 契约测试: 主动触发 / 定时任务唤醒与历史入站锚点隔离修复 (Stale Inbound Quote Fix Contract)
 *
 * 1. 真实 C2C_MESSAGE_CREATE 登记 inbound_reply_slots 锚点，唤醒消息头精简为 `[msg_<n>] [时间] 正文`；
 * 2. scheduled_task / is_synthetic: true 系统唤醒严禁在 Prompt 伪造 `[msg_...]` / `[消息ID:]`（且不含 `[QQ私聊]`），也不抹除历史有效入站 msg_id 锚点；
 * 3. assistant/message 坚决保持用户侧静默（不调用 send_qq_message 时绝不下发任何文本）；
 * 4. 定时任务中显式调用 send_qq_message 仍沿用有效入站 msg_id 且 msg_seq 严格单调递增，工具仅返回短出站 ID (`msg_self_<n>`)；
 * 5. 下一条真实 C2C_MESSAGE_CREATE 到来后刷新锚点与精简唤醒头 `[msg_<n>]`。
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
            session_id: 'sess-stale-1',
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

describe('契约测试: scheduled_task / is_synthetic 唤醒与入站锚点隔离 (Stale Inbound Quote Fix)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let capturedFollowups: Array<{ text: string; raw: any }>;
  let postedMessages: any[];
  let outSeq: number;

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  beforeEach(async () => {
    FakeWs.instances = [];
    capturedFollowups = [];
    postedMessages = [];
    outSeq = 0;

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-stale-'));
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
          postedMessages.push(body);
          if (body?.msg_type === 6) {
            return new Response(
              JSON.stringify({
                id: 'ROBOT1.0_STALE_NOTIFY',
                timestamp: '2026-11-11T12:20:00+08:00',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          outSeq += 1;
          return new Response(
            JSON.stringify({
              id: `ROBOT1.0_STALE_OUT_${outSeq}`,
              timestamp: '2026-11-11T12:20:00+08:00',
              ext_info: { ref_idx: `REFIDX_STALE_OUT_${outSeq}` },
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
      capturedFollowups.push({ text, raw: msg });
    };
    (agent as any).followup = capture;
    (agent as any).steer = capture;
    return agent;
  }

  it('契约 1: 真实入站登记 inbound_reply_slots 后，scheduled_task 唤醒不伪造 [msg_]/[消息ID:]、不擦除历史入站锚点、保持静默且 msg_seq 单调递增', async () => {
    const agent = await preparePeerAgent();
    const bridge = booted.ctx.get('kujira-outbound-bridge') as OutboundStreamBridge;
    const hub = booted.ctx.get('kujira-system-event-hub') as SystemEventHub;
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    const session = (agent as any).session;

    // 1. 真实用户消息入站 (登记 inbound_reply_slots，固定 msg_type=6 input_notify 占用 msg_seq=1)
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_STALE_IN_1',
      content: '一会儿记得提醒我喝水',
      timestamp: '2026-11-11T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_STALE_IN_1'] },
    });

    await waitUntil(
      () => capturedFollowups.length === 1 && postedMessages.some((m) => m.msg_type === 6),
      5000,
      'inbound 1 and input_notify'
    );
    expect(capturedFollowups[0]!.text).toMatch(
      /^\[msg_1\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 一会儿记得提醒我喝水$/
    );
    expect(capturedFollowups[0]!.text).not.toContain('[QQ私聊]');
    expect(capturedFollowups[0]!.text).not.toContain('ROBOT1.0_STALE_IN_1');
    expect(capturedFollowups[0]!.text).not.toContain('[消息ID:');
    expect(capturedFollowups[0]!.text).not.toContain(MOCK_OPENID);
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_STALE_IN_1');

    // 验证用户侧静默：assistant/message 事件绝不自动发出任何文本消息
    const beforeAssistantCount = postedMessages.filter((m) => m.msg_type !== 6).length;
    await bridge.handleSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
    await bridge.handleSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '内部日志不应直发' }] } },
    });
    await bridge.handleSessionEvent(session, { type: 'turn/end', data: { turn: 1 } });
    expect(postedMessages.filter((m) => m.msg_type !== 6)).toHaveLength(beforeAssistantCount);

    // 2. 触发 scheduled_task (is_synthetic: true)
    await hub.dispatchScheduledTask({
      peer: MOCK_PEER,
      taskId: 'task_water_1',
      taskType: 'once',
      prompt: '提醒用户喝水',
      timestamp: Date.parse('2026-11-11T12:05:00+08:00'),
    });

    await waitUntil(() => capturedFollowups.length === 2, 3000, 'scheduled task wakeup');
    const scheduledPrompt = capturedFollowups[1]!.text;
    // 绝不在 Prompt 伪造 [msg_...] 或 [消息ID:]，且移除 [QQ私聊]
    expect(scheduledPrompt).not.toContain('[msg_');
    expect(scheduledPrompt).not.toContain('[消息ID:');
    expect(scheduledPrompt).not.toContain('[QQ私聊]');
    expect(scheduledPrompt).not.toContain('ROBOT1.0_');
    expect(scheduledPrompt).toContain('系统事件：[定时任务]');
    expect(scheduledPrompt).toContain('提醒用户喝水');

    // is_synthetic 标记生效，但历史有效入站锚点仍完整保留
    expect((bridge.getActiveTurnContext(MOCK_PEER) as any)?.is_synthetic).toBe(true);
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_STALE_IN_1');

    // scheduled turn 中 assistant/message 同样保持用户侧静默
    await bridge.handleSessionEvent(session, { type: 'turn/start', data: { turn: 2 } });
    await bridge.handleSessionEvent(session, {
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '未调用工具的静默文本' }] } },
    });
    await bridge.handleSessionEvent(session, { type: 'turn/end', data: { turn: 2 } });
    expect(postedMessages.filter((m) => m.msg_type !== 6)).toHaveLength(0);

    // 3. 在定时任务回合内显式调用 send_qq_message 两次，验证沿用 ROBOT1.0_STALE_IN_1 且 msg_seq 单调递增 (2 -> 3)
    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);

    const res1 = await sendTool.execute({ text: '到点啦，记得喝水~' }, { agent });
    const res2 = await sendTool.execute({ text: '再提醒一次，补充水分' }, { agent });
    expect(res1.success).toBe(true);
    expect(res1.message_id).toBe('msg_self_1');
    expect((res1 as any).ref_idx).toBeUndefined();
    expect(res2.success).toBe(true);
    expect(res2.message_id).toBe('msg_self_2');
    expect((res2 as any).ref_idx).toBeUndefined();

    const textPosts = postedMessages.filter((m) => m.msg_type !== 6);
    expect(textPosts).toHaveLength(2);
    expect(textPosts[0].msg_id).toBe('ROBOT1.0_STALE_IN_1');
    expect(textPosts[0].msg_seq).toBe(2);
    expect(textPosts[0].message_reference).toBeUndefined();
    expect(textPosts[1].msg_id).toBe('ROBOT1.0_STALE_IN_1');
    expect(textPosts[1].msg_seq).toBe(3);

    const db = new Database(dbPath(), { readonly: true });
    try {
      const slot = db.prepare('SELECT * FROM inbound_reply_slots WHERE msg_id = ?').get('ROBOT1.0_STALE_IN_1') as any;
      expect(slot).toBeDefined();
      expect(slot.invalidated).toBe(0);
      expect(slot.last_seq).toBe(3);
    } finally {
      db.close();
    }

    // 4. 新一条真实用户消息入站后切换锚点，不串扰旧锚点或合成上下文
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_STALE_IN_2',
      content: '好的我喝完啦',
      timestamp: '2026-11-11T12:06:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_STALE_IN_2'] },
    });

    await waitUntil(
      () =>
        capturedFollowups.length === 3 &&
        postedMessages.filter((m) => m.msg_type === 6).length === 2,
      5000,
      'inbound 2 and input_notify 2'
    );
    expect(capturedFollowups[2]!.text).toMatch(
      /^\[msg_2\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 好的我喝完啦$/
    );
    expect(capturedFollowups[2]!.text).not.toContain('[QQ私聊]');
    expect(capturedFollowups[2]!.text).not.toContain('ROBOT1.0_STALE_IN_2');
    expect(capturedFollowups[2]!.text).not.toContain(MOCK_OPENID);
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_STALE_IN_2');
    expect((bridge.getActiveTurnContext(MOCK_PEER) as any)?.is_synthetic).toBeFalsy();

    const res3 = await sendTool.execute({ text: '棒棒哒！' }, { agent });
    expect(res3.success).toBe(true);
    expect(res3.message_id).toBe('msg_self_3');
    const latestTextPost = postedMessages.filter((m) => m.msg_type !== 6).pop();
    expect(latestTextPost.msg_id).toBe('ROBOT1.0_STALE_IN_2');
    expect(latestTextPost.msg_seq).toBe(2);
  });

  it('契约 2: 连续多次 scheduled_task 唤醒均不伪造 [msg_]/[消息ID:]，且保留有效入站槽位供后续单调递增使用', async () => {
    const agent = await preparePeerAgent();
    const bridge = booted.ctx.get('kujira-outbound-bridge') as OutboundStreamBridge;
    const hub = booted.ctx.get('kujira-system-event-hub') as SystemEventHub;
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_STALE_MULTI_IN',
      content: '开启周期提醒',
      timestamp: '2026-11-11T12:10:00+08:00',
      author: { user_openid: MOCK_OPENID, username: 'UserA' },
      message_type: 0,
    });
    await waitUntil(
      () => capturedFollowups.length === 1 && postedMessages.some((m) => m.msg_type === 6),
      5000,
      'initial inbound'
    );
    expect(capturedFollowups[0]!.text).toMatch(
      /^\[msg_1\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 开启周期提醒$/
    );
    expect(capturedFollowups[0]!.text).not.toContain('[QQ私聊]');

    await hub.dispatchScheduledTask({
      peer: MOCK_PEER,
      taskId: 'task_loop_1',
      taskType: 'recurring',
      taskRule: '每天 12:15',
      prompt: '第一次周期提醒',
      timestamp: Date.parse('2026-11-11T12:15:00+08:00'),
    });
    await hub.dispatchScheduledTask({
      peer: MOCK_PEER,
      taskId: 'task_loop_1',
      taskType: 'recurring',
      taskRule: '每天 12:16',
      prompt: '第二次周期提醒',
      timestamp: Date.parse('2026-11-11T12:16:00+08:00'),
    });

    await waitUntil(() => capturedFollowups.length === 3, 3000, 'two scheduled wakeups');
    expect(capturedFollowups[1]!.text).not.toContain('[msg_');
    expect(capturedFollowups[1]!.text).not.toContain('[消息ID:');
    expect(capturedFollowups[1]!.text).not.toContain('[QQ私聊]');
    expect(capturedFollowups[1]!.text).toContain('系统事件：[定时任务]');
    expect(capturedFollowups[2]!.text).not.toContain('[msg_');
    expect(capturedFollowups[2]!.text).not.toContain('[消息ID:');
    expect(capturedFollowups[2]!.text).not.toContain('[QQ私聊]');
    expect(capturedFollowups[2]!.text).toContain('系统事件：[定时任务]');
    expect(bridge.resolvePassiveMsgId(MOCK_PEER)).toBe('ROBOT1.0_STALE_MULTI_IN');

    // 全程未调用 send_qq_message 时，没有任何文本出站
    expect(postedMessages.filter((m) => m.msg_type !== 6)).toHaveLength(0);

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    const sendRes = await sendTool.execute({ text: '周期打卡' }, { agent });
    expect(sendRes.success).toBe(true);
    expect(sendRes.message_id).toBe('msg_self_1');

    const sent = postedMessages.filter((m) => m.msg_type !== 6);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg_id).toBe('ROBOT1.0_STALE_MULTI_IN');
    expect(sent[0].msg_seq).toBe(2);
  });
});
