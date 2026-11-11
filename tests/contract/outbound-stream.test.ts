/**
 * tests/contract/outbound-stream.test.ts
 *
 * 契约测试: KujiraGatewayClient + OutboundStreamBridge 单聊出站调度中枢与安全流式
 *
 * 覆盖核心契约:
 * 1. 用户侧静默原则: start() / handleSessionEvent() 空转不向外偷发文本;
 * 2. 正向 WSS Gateway 连接管理: singleflight token、401 重取、HELLO 心跳 + 死链看门狗、
 *    IDENTIFY (intents=1<<25)、RESUME、RECONNECT、INVALID_SESSION、getStatus() 与脱敏日志;
 * 3. `msg_seq` 共享槽位分配器与重试/降级: 40054005 自动递进重试，40034128/40034024 标记失效并降级主动消息;
 * 4. `sendTextReply` (Markdown/纯文本 + 16 KiB UTF-8 分片 + 仅首片引用 `REFIDX_...`),
 *    `sendInputNotifyIfEnabled` (`msg_type=6` 占用 1 槽), `recallMessage` (DELETE + 标库 + 120s 透传),
 *    `is_synthetic: true` 不清除历史入站锚点;
 * 5. 安全流式护栏: 无入站 `msg_id` 拒绝调用 `stream_messages` (避开 `50015001`),
 *    仅 `append` + 8 KiB UTF-8 分片 + 失败回退普通消息绝不丢字。
 */

import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import {
  KujiraGatewayClient,
  type QqWebSocketLike,
  type QqWsEvent,
} from '../../src/gateway/server.js';
import {
  filterAndExtractOutboundBlocks,
  OutboundStreamBridge,
  type OutboundSlotDb,
} from '../../src/outbound/stream.js';
import { openidToPeer } from '../../src/utils/peer.js';

const TEST_OPENID = '00112233445566778899AABBCCDDEEFF';
const TEST_PEER = openidToPeer(TEST_OPENID);

class FakeWebSocket implements QqWebSocketLike {
  readyState = 0; // CONNECTING
  sentFrames: any[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: QqWsEvent) => void>>();

  addEventListener(type: string, listener: (ev: QqWsEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close', { code: 1000, reason: 'closed' });
  }

  emit(type: string, ev: QqWsEvent = {}): void {
    if (type === 'open') this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }
}

describe('契约测试: 出站文本过滤与用户侧静默原则', () => {
  it('契约 1: filterAndExtractOutboundBlocks 仅提取 text 块，过滤 reasoning 与 tool-call', () => {
    const blocks: ContentBlock[] = [
      { type: 'reasoning', text: '内部思考...' },
      { type: 'tool-call', id: 'call_1' as any, name: 'read_memory', arguments: '{}' },
      { type: 'text', text: '你好！这是正式回答。' },
    ];
    const extracted = filterAndExtractOutboundBlocks(blocks);
    expect(extracted).toEqual([{ type: 'text', text: '你好！这是正式回答。' }]);
  });

  it('契约 2: OutboundStreamBridge.start() 与 handleSessionEvent() 绝对静默', async () => {
    let listened = false;
    const mockCtx: any = {
      on: (event: string) => {
        if (event === 'session/event') listened = true;
        return () => {};
      },
    };
    const sendMock = vi.fn();
    const bridge = new OutboundStreamBridge(mockCtx, {
      gateway: { sendC2CMessage: sendMock } as any,
    });
    const stop = bridge.start();
    expect(typeof stop).toBe('function');
    expect(listened).toBe(false);
    await bridge.handleSessionEvent({}, { type: 'turn/end' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('契约测试: KujiraGatewayClient 正向 WSS 网关、鉴权与脱敏日志', () => {
  it('契约 3: singleflight token、401 退避刷新重试、脱敏日志绝不泄露 secret/token/query', async () => {
    let tokenFetchCount = 0;
    let sendAttempt = 0;
    const logs: string[] = [];

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('getAppAccessToken')) {
        tokenFetchCount += 1;
        return new Response(
          JSON.stringify({ access_token: `SECRET_TOK_${tokenFetchCount}`, expires_in: 7200 }),
          { status: 200 }
        );
      }
      if (url.endsWith('/messages')) {
        sendAttempt += 1;
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (sendAttempt === 1) {
          return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
        }
        expect(auth).toBe('QQBot SECRET_TOK_2');
        return new Response(JSON.stringify({ id: 'ROBOT1.0_OK' }), { status: 200 });
      }
      return new Response('err', { status: 500 });
    };

    const client = new KujiraGatewayClient({
      credentials: { appId: 'my_app_id', appSecret: 'SUPER_SECRET_VALUE' },
      fetchFn: fetchMock,
      authRetryDelayMs: 5,
      logger: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
        debug: (m: string) => logs.push(m),
      },
    });

    // 并发调用 getAccessToken 共享同一请求 (singleflight)
    const [t1, t2] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    expect(t1).toBe('SECRET_TOK_1');
    expect(t2).toBe('SECRET_TOK_1');
    expect(tokenFetchCount).toBe(1);

    // 401 自动作废缓存并刷新重试
    const res = await client.sendC2CMessage(TEST_OPENID, { msg_type: 0, content: 'hi' });
    expect(res.ok).toBe(true);
    expect(tokenFetchCount).toBe(2);

    // 脱敏校验：日志中不得出现 secret 或 token 明文，带 query URL 也必须脱敏
    const att = await client.fetchAttachment('https://multimedia.nt.qq.com.cn/dl?rkey=TOP_SECRET_RKEY');
    expect(att.ok).toBe(false);
    expect(att.message ?? '').not.toContain('TOP_SECRET_RKEY');
    for (const line of logs) {
      expect(line).not.toContain('SUPER_SECRET_VALUE');
      expect(line).not.toContain('SECRET_TOK_1');
      expect(line).not.toContain('SECRET_TOK_2');
    }
  });

  it('契约 4: WSS HELLO/IDENTIFY(1<<25)/READY/getStatus/RESUME/FRIEND_ADD/死链看门狗闭环', async () => {
    const sockets: FakeWebSocket[] = [];
    const dispatches: Array<{ name: string; data: unknown }> = [];
    const c2cEvents: any[] = [];
    const logs: string[] = [];

    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'ws_tok', expires_in: 7200 }), { status: 200 });
      }
      if (url.endsWith('/gateway')) {
        return new Response(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket?auth=secret' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const client = new KujiraGatewayClient({
      credentials: { appId: 'app', appSecret: 'sec' },
      fetchFn: fetchMock,
      createWebSocket: () => {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      heartbeatIntervalRatio: 1,
      helloTimeoutMs: 50,
      maxMissedHeartbeatAcks: 1,
      backoffDelaysMs: [10, 20],
      logger: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
        debug: (m: string) => logs.push(m),
      },
      onDispatch: (name, data) => {
        dispatches.push({ name, data });
      },
      onC2CMessage: (ev) => {
        c2cEvents.push(ev);
      },
    });

    await client.start();
    expect(sockets).toHaveLength(1);
    const ws1 = sockets[0];
    ws1.emit('open');
    expect(client.getStatus()).toEqual({ connected: true, ready: false, reconnectAttempts: 0 });

    // 收到 HELLO -> 发送 IDENTIFY (intents = 1 << 25)
    ws1.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws1.sentFrames[0]).toMatchObject({
      op: 2,
      d: { token: 'QQBot ws_tok', intents: 1 << 25 },
    });

    // 收到 READY -> getStatus() 就绪
    ws1.emit('message', {
      data: JSON.stringify({
        op: 0,
        s: 1,
        t: 'READY',
        d: { session_id: 'sess_1', user: { id: '1000000000', username: 'KujiraBot', bot: true } },
      }),
    });
    expect(client.getStatus()).toEqual({
      connected: true,
      ready: true,
      botId: '1000000000',
      botName: 'KujiraBot',
      reconnectAttempts: 0,
    });

    // 收到 C2C_MESSAGE_CREATE 与 FRIEND_ADD（不崩不泄 raw openid）
    ws1.emit('message', {
      data: JSON.stringify({
        op: 0,
        s: 2,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'ROBOT1.0_IN_1',
          content: 'hello',
          timestamp: '2026-11-11T18:30:00+08:00',
          author: { user_openid: TEST_OPENID },
        },
      }),
    });
    ws1.emit('message', {
      data: JSON.stringify({
        op: 0,
        s: 3,
        t: 'FRIEND_ADD',
        d: { openid: TEST_OPENID },
      }),
    });
    expect(c2cEvents).toHaveLength(1);
    expect(dispatches.map((d) => d.name)).toContain('FRIEND_ADD');
    expect(logs.join('\n')).not.toContain(TEST_OPENID);

    // 收到 RECONNECT (op=7) -> 断开并重连发送 RESUME (op=6)
    ws1.emit('message', { data: JSON.stringify({ op: 7 }) });
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const ws2 = sockets[1];
    ws2.emit('open');
    ws2.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws2.sentFrames[0]).toMatchObject({
      op: 6,
      d: { session_id: 'sess_1', seq: 3 },
    });

    // INVALID_SESSION (op=9) -> 重置会话重新 IDENTIFY
    ws2.emit('message', { data: JSON.stringify({ op: 9, d: false }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws2.sentFrames[1]).toMatchObject({ op: 2 });

    client.stop();
    expect(client.getStatus().connected).toBe(false);
    expect(client.getStatus().ready).toBe(false);
  });
});

describe('契约测试: OutboundStreamBridge 槽位分配、重试降级、撤回与流式安全护栏', () => {
  function createHarness(
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    config: { markdown_enabled?: boolean; input_notify_enabled?: boolean } = {}
  ) {
    const seqMap = new Map<string, number>();
    const invalidated = new Set<string>();
    const recalled = new Set<string>();
    const dbMessages = new Map<string, any>();
    const slots = new Map<string, { msg_id: string; peer: string; openid: string; last_seq: number; received_at: number; invalidated: number; updated_at: number }>();

    const db: OutboundSlotDb = {
      getOpenidByPeer: (peer) => (peer === TEST_PEER ? TEST_OPENID : null),
      getLatestValidInboundSlot: (peer) => {
        const list = Array.from(slots.values()).filter((s) => s.peer === peer && !s.invalidated);
        list.sort((a, b) => b.received_at - a.received_at);
        return list[0] ?? null;
      },
      allocateNextMsgSeq: (msgId) => {
        const next = (seqMap.get(msgId) ?? 0) + 1;
        seqMap.set(msgId, next);
        return next;
      },
      advanceMsgSeq: (msgId, minSeq) => {
        const next = Math.max((seqMap.get(msgId) ?? 0) + 1, minSeq ?? 1);
        seqMap.set(msgId, next);
        return next;
      },
      markInboundSlotInvalidated: (msgId) => {
        invalidated.add(msgId);
        const s = slots.get(msgId);
        if (s) s.invalidated = 1;
      },
      getMessage: (msgId) => dbMessages.get(msgId) ?? null,
      getMessageByRefIdx: (refIdx) => Array.from(dbMessages.values()).find((m) => m.ref_idx === refIdx) ?? null,
      markRecalled: (msgId) => {
        recalled.add(msgId);
      },
    };

    const gateway = new KujiraGatewayClient({
      credentials: { appId: 'app', appSecret: 'sec' },
      fetchFn: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('getAppAccessToken')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 });
        }
        return fetchImpl(url, init);
      },
    });

    const bridge = new OutboundStreamBridge({} as any, {
      gateway,
      db,
      getConfig: () => config,
      streamThrottleMs: 10,
    });

    return { bridge, gateway, db, slots, dbMessages, invalidated, recalled };
  }

  it('契约 5: msg_type=6 + sendTextReply 共享 msg_seq，16 KiB 分片仅首片附 REFIDX，40054005 自动递增重试', async () => {
    const sentBodies: any[] = [];
    let callCount = 0;

    const { bridge, dbMessages } = createHarness(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        callCount += 1;
        // 第 2 次发送 (第一片文本 msg_seq=2) 模拟跨天去重 40054005，验证自动跳到 msg_seq=3 重试成功
        if (callCount === 2) {
          return new Response(JSON.stringify({ code: 40054005, message: '消息被去重' }), { status: 400 });
        }
        sentBodies.push(body);
        return new Response(
          JSON.stringify({ id: `ROBOT1.0_OUT_${sentBodies.length}`, ext_info: { ref_idx: `REFIDX_OUT_${sentBodies.length}` } }),
          { status: 200 }
        );
      },
      { markdown_enabled: true, input_notify_enabled: true }
    );

    dbMessages.set('ROBOT1.0_IN_1', { msg_id: 'ROBOT1.0_IN_1', ref_idx: 'REFIDX_IN_1' });
    bridge.trackInboundContext(TEST_PEER, {
      msg_id: 'ROBOT1.0_IN_1',
      ref_idx: 'REFIDX_IN_1',
      from_user: 'a1b2c3d4e5f60708',
    });

    // 1. 输入状态占 msg_seq=1
    const notifyRes = await bridge.sendInputNotifyIfEnabled(TEST_PEER);
    expect(notifyRes?.ok).toBe(true);
    expect(sentBodies[0]).toMatchObject({ msg_type: 6, msg_id: 'ROBOT1.0_IN_1', msg_seq: 1 });

    // 2. 长文本 > 16 KiB UTF-8 字节（#标题 在外层规范化，代码块内不改）
    const filler = '字'.repeat(6000); // 18,000 字节 > 16,384 字节
    const longMd = `#标题\n\`\`\`py\n#注释\n\`\`\`\n${filler}`;
    const textRes = await bridge.sendTextReply(TEST_PEER, longMd, { replyTo: 'ROBOT1.0_IN_1' });
    expect(textRes.ok).toBe(true);

    // 应当分成 2 片发送，且第 1 片使用重试后的 msg_seq=3 并携带 message_reference，第 2 片用 msg_seq=4 无引用
    expect(sentBodies.length).toBe(3);
    expect(sentBodies[1]).toMatchObject({
      msg_type: 2,
      msg_id: 'ROBOT1.0_IN_1',
      msg_seq: 3,
      message_reference: { message_id: 'REFIDX_IN_1' },
    });
    expect(sentBodies[1].content).toBeUndefined();
    expect(sentBodies[1].markdown.content).toContain('# 标题');
    expect(sentBodies[1].markdown.content).toContain('#注释');
    expect(sentBodies[2]).toMatchObject({
      msg_type: 2,
      msg_id: 'ROBOT1.0_IN_1',
      msg_seq: 4,
    });
    expect(sentBodies[2].message_reference).toBeUndefined();
    // 验证两片合起来一字未丢
    expect(sentBodies[1].markdown.content + sentBodies[2].markdown.content).toContain(filler);
  });

  it('契约 6: markdown_enabled=false 时降级 msg_type=0 + stripMarkdown，遇到 40034128/40034024 标记失效并降级主动消息', async () => {
    const sentBodies: any[] = [];
    let first = true;

    const { bridge, invalidated, slots } = createHarness(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (first) {
          first = false;
          return new Response(JSON.stringify({ code: 40034128, message: '被动回复超时' }), { status: 400 });
        }
        sentBodies.push(body);
        return new Response(JSON.stringify({ id: 'ROBOT1.0_PROACTIVE_1' }), { status: 200 });
      },
      { markdown_enabled: false }
    );

    // 仅在 DB 存在历史被动锚点 + 随后经历一次 synthetic 定时任务唤醒（绝不抹除 DB 锚点）
    slots.set('ROBOT1.0_DB_OLD', {
      msg_id: 'ROBOT1.0_DB_OLD',
      peer: TEST_PEER,
      openid: TEST_OPENID,
      last_seq: 2,
      received_at: Date.now() - 1000,
      invalidated: 0,
      updated_at: Date.now() - 1000,
    });
    bridge.trackInboundContext(TEST_PEER, { from_user: '', trigger: 'scheduled', is_synthetic: true });
    expect(bridge.resolvePassiveMsgId(TEST_PEER)).toBe('ROBOT1.0_DB_OLD');

    const res = await bridge.sendTextReply(TEST_PEER, '**加粗提示**');
    expect(res.ok).toBe(true);
    expect(invalidated.has('ROBOT1.0_DB_OLD')).toBe(true);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toEqual({ msg_type: 0, content: '加粗提示' });
    expect(sentBodies[0].msg_id).toBeUndefined();
    expect(sentBodies[0].msg_seq).toBeUndefined();
  });

  it('契约 7: recallMessage 调 DELETE 成功标库，120s 超限 40064004 原样透传且不标库', async () => {
    const methodsAndUrls: Array<{ method: string; url: string }> = [];
    let shouldExpire = false;

    const { bridge, recalled } = createHarness(async (url, init) => {
      methodsAndUrls.push({ method: init?.method ?? 'GET', url });
      if (shouldExpire) {
        return new Response(JSON.stringify({ code: 40064004, message: '已经超出消息撤回时限' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    });

    const okRes = await bridge.recallMessage(TEST_PEER, 'ROBOT1.0_OUT_RECALL_1', { hidetip: true });
    expect(okRes.ok).toBe(true);
    expect(recalled.has('ROBOT1.0_OUT_RECALL_1')).toBe(true);
    expect(methodsAndUrls[0].method).toBe('DELETE');
    expect(methodsAndUrls[0].url).toContain(`/v2/users/${TEST_OPENID}/messages/ROBOT1.0_OUT_RECALL_1?hidetip=true`);

    shouldExpire = true;
    const errRes = await bridge.recallMessage(TEST_PEER, 'ROBOT1.0_OUT_RECALL_2');
    expect(errRes.ok).toBe(false);
    expect(errRes.code).toBe(40064004);
    expect(recalled.has('ROBOT1.0_OUT_RECALL_2')).toBe(false);
  });

  it('契约 8: 流式安全护栏：无入站 msg_id 拒绝调用 stream_messages (避开 50015001)；有锚点时仅 append + 8 KiB 分片；失败回退普通消息不丢字', async () => {
    const streamCalls: any[] = [];
    const fallbackCalls: any[] = [];
    let failSecondStreamChunk = false;

    const { bridge, gateway } = createHarness(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/stream_messages')) {
        if (failSecondStreamChunk && streamCalls.length >= 1) {
          return new Response(JSON.stringify({ code: 50001, message: 'stream failed' }), { status: 500 });
        }
        streamCalls.push(body);
        return new Response(JSON.stringify({ id: 'STREAM_MSG_1', remain_msg_len: 0 }), { status: 200 });
      }
      if (url.endsWith('/messages')) {
        fallbackCalls.push(body);
        return new Response(JSON.stringify({ id: 'ROBOT1.0_FALLBACK_1' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    // 1. 直接调底层流式接口无 msg_id -> 本地拦截返回 50015001，不发网络请求
    const guardRes = await gateway.sendC2CStreamMessage(TEST_OPENID, {
      input_mode: 'append',
      input_state: 1,
      index: 0,
      content_type: 'markdown',
      content_raw: 'hi',
      msg_id: '',
      msg_seq: 1,
    });
    expect(guardRes.ok).toBe(false);
    expect(guardRes.code).toBe(50015001);
    expect(streamCalls).toHaveLength(0);

    // 2. 无入站锚点时 openStreamSession 拒绝开流并返回 null
    expect(bridge.openStreamSession(TEST_PEER)).toBeNull();

    // 3. 有入站锚点时开流，超过 8 KiB 自动拆片且全程仅 append + 递增 index + 回传 stream_msg_id
    bridge.trackInboundContext(TEST_PEER, { msg_id: 'ROBOT1.0_IN_STREAM_1', from_user: 'a1b2c3d4e5f60708' });
    const session = bridge.openStreamSession(TEST_PEER);
    expect(session).not.toBeNull();

    const partA = '甲'.repeat(3000); // 9000 B > 8192 B
    const partB = '乙'.repeat(100);
    await session!.push(partA);
    await session!.finish(partA + partB);

    expect(streamCalls.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < streamCalls.length; i++) {
      expect(streamCalls[i].input_mode).toBe('append');
      expect(streamCalls[i].index).toBe(i);
      expect(Buffer.byteLength(streamCalls[i].content_raw, 'utf8')).toBeLessThanOrEqual(8 * 1024);
      if (i > 0) expect(streamCalls[i].stream_msg_id).toBe('STREAM_MSG_1');
    }
    expect(streamCalls[streamCalls.length - 1].input_state).toBe(10);
    expect(streamCalls.map((c) => c.content_raw).join('')).toBe(partA + partB);

    // 4. 若流式途中失败，finish() 自动把未送达余量回退为普通消息，绝不丢字
    streamCalls.length = 0;
    failSecondStreamChunk = true;
    const session2 = bridge.openStreamSession(TEST_PEER)!;
    const chunk1 = '首片内容';
    const chunk2 = '后续重要内容';
    await session2.push(chunk1);
    await session2.push(chunk2);
    await session2.finish();

    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(fallbackCalls.map((b) => b.markdown.content).join('')).toContain(chunk2);
  });
});
