/**
 * tests/contract/outbound-stream.test.ts
 *
 * 契约测试: KujiraGatewayClient + OutboundStreamBridge 单聊出站调度中枢（去流式版）
 *
 * 覆盖核心契约:
 * 1. 用户侧静默原则: start() / handleSessionEvent() 空转不向外偷发文本;
 * 2. 正向 WSS Gateway 连接管理: singleflight token、401 重取、HELLO 心跳 + 死链看门狗、
 *    IDENTIFY (intents=1<<25)、RESUME、RECONNECT、INVALID_SESSION、getStatus() 与脱敏日志;
 * 3. `msg_seq` 共享槽位分配器与重试/降级: 40054005 自动递进重试，40034128/40034024 标记失效并降级主动消息;
 * 4. `sendTextReply` (固定原生 Markdown `msg_type=2` + `normalizeQqMarkdown` + 16 KiB UTF-8 分片 +
 *    `replyTo` 仅认短 ID 换取 `REFIDX_...` 仅首片携带),
 *    `sendInputNotifyIfEnabled` / `sendInputNotify` (固定下发 `msg_type=6` 占用 1 槽且异常容错),
 *    `recallMessage` (仅认出站短 ID `msg_self_*`，本地拦截 `msg_*` 与非短 ID，查库调 DELETE + 标库 + 120s 透传),
 *    `resolveShortId` (由原始 `msg_id` 反查 `msg_self_<n>`),
 *    `is_synthetic: true` 不清除历史入站锚点，流式状态机已彻底裁撤。
 */

import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import {
  KujiraGatewayClient,
  type QqWebSocketLike,
  type QqWsEvent,
} from '../../src/gateway/server.js';
import * as streamModule from '../../src/outbound/stream.js';
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

  it('契约 2: OutboundStreamBridge.start() 与 handleSessionEvent() 绝对静默，且流式状态机已裁撤', async () => {
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

    // 确认流式推流状态机已彻底裁撤
    expect((streamModule as any).KujiraStreamSession).toBeUndefined();
    expect((streamModule as any).QQ_STREAM_INPUT_STATE_GENERATING).toBeUndefined();
    expect((streamModule as any).QQ_STREAM_INPUT_STATE_FINISHED).toBeUndefined();
    expect((bridge as any).openStreamSession).toBeUndefined();
    expect((bridge as any).isStreaming).toBeUndefined();
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

    const [t1, t2] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    expect(t1).toBe('SECRET_TOK_1');
    expect(t2).toBe('SECRET_TOK_1');
    expect(tokenFetchCount).toBe(1);

    const res = await client.sendC2CMessage(TEST_OPENID, { msg_type: 2, markdown: { content: 'hi' } });
    expect(res.ok).toBe(true);
    expect(tokenFetchCount).toBe(2);

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

    ws1.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws1.sentFrames[0]).toMatchObject({
      op: 2,
      d: { token: 'QQBot ws_tok', intents: 1 << 25 },
    });

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

    ws2.emit('message', { data: JSON.stringify({ op: 9, d: false }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(ws2.sentFrames[1]).toMatchObject({ op: 2 });

    client.stop();
    expect(client.getStatus().connected).toBe(false);
    expect(client.getStatus().ready).toBe(false);
  });
});

describe('契约测试: OutboundStreamBridge 槽位分配、固定 Markdown/输入提示与仅短 ID 引用撤回', () => {
  function createHarness(
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  ) {
    const seqMap = new Map<string, number>();
    const invalidated = new Set<string>();
    const recalled = new Set<string>();
    const dbMessages = new Map<string, any>();
    const slots = new Map<
      string,
      {
        msg_id: string;
        peer: string;
        openid: string;
        last_seq: number;
        received_at: number;
        invalidated: number;
        updated_at: number;
      }
    >();

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
      getMessageByShortId: (peer, shortId) =>
        Array.from(dbMessages.values()).find((m) => m.peer === peer && m.short_id === shortId) ?? null,
      getMessageByRefIdx: (refIdx) =>
        Array.from(dbMessages.values()).find((m) => m.ref_idx === refIdx) ?? null,
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
    });

    return { bridge, gateway, db, slots, dbMessages, invalidated, recalled };
  }

  it('契约 5: 固定 msg_type=6 + 固定 Markdown msg_type=2 + 16 KiB 分片仅首片附短 ID 换得的 REFIDX + 40054005 自动递增重试 + resolveShortId', async () => {
    const sentBodies: any[] = [];
    let callCount = 0;

    const { bridge, dbMessages } = createHarness(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      callCount += 1;
      // 第 2 次发送 (第一片文本 msg_seq=2) 模拟跨天去重 40054005，验证自动跳到 msg_seq=3 重试成功
      if (callCount === 2) {
        return new Response(JSON.stringify({ code: 40054005, message: '消息被去重' }), { status: 400 });
      }
      sentBodies.push(body);
      const outId = `ROBOT1.0_OUT_${sentBodies.length}`;
      dbMessages.set(outId, {
        msg_id: outId,
        peer: TEST_PEER,
        short_id: `msg_self_${sentBodies.length}`,
        self: 1,
      });
      return new Response(
        JSON.stringify({ id: outId, ext_info: { ref_idx: `REFIDX_OUT_${sentBodies.length}` } }),
        { status: 200 }
      );
    });

    dbMessages.set('ROBOT1.0_IN_1', {
      msg_id: 'ROBOT1.0_IN_1',
      peer: TEST_PEER,
      short_id: 'msg_1',
      ref_idx: 'REFIDX_IN_1',
      self: 0,
    });
    bridge.trackInboundContext(TEST_PEER, {
      msg_id: 'ROBOT1.0_IN_1',
      ref_idx: 'REFIDX_IN_1',
      from_user: 'a1b2c3d4e5f60708',
    });

    // 1. 固定输入中提示占用 msg_seq=1（无需任何 input_notify_enabled 配置）
    const notifyRes = await bridge.sendInputNotifyIfEnabled(TEST_PEER);
    expect(notifyRes?.ok).toBe(true);
    expect(sentBodies[0]).toMatchObject({ msg_type: 6, msg_id: 'ROBOT1.0_IN_1', msg_seq: 1 });

    // 2. 长文本 > 16 KiB UTF-8 字节（传入短 ID msg_1 作为 replyTo，#标题 在外层规范化，代码块内不改）
    const filler = '字'.repeat(6000);
    const longMd = `#标题\n\`\`\`py\n#注释\n\`\`\`\n${filler}`;
    const textRes = await bridge.sendTextReply(TEST_PEER, longMd, { replyTo: 'msg_1' });
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
    expect(sentBodies[1].markdown.content + sentBodies[2].markdown.content).toContain(filler);

    // 3. resolveShortId 便捷反查出站短 ID
    expect(bridge.resolveShortId(TEST_PEER, 'ROBOT1.0_OUT_2')).toBe('msg_self_2');
    expect(bridge.resolveShortId(TEST_PEER, 'ROBOT1.0_NONEXISTENT')).toBeUndefined();
  });

  it('契约 6: 固定原生 Markdown (msg_type=2) 发送，遇 40034128/40034024 标记失效并降级主动消息，synthetic 不擦除入站锚点', async () => {
    const sentBodies: any[] = [];
    let first = true;

    const { bridge, invalidated, slots } = createHarness(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (first) {
        first = false;
        return new Response(JSON.stringify({ code: 40034128, message: '被动回复超时' }), { status: 400 });
      }
      sentBodies.push(body);
      return new Response(JSON.stringify({ id: 'ROBOT1.0_PROACTIVE_1' }), { status: 200 });
    });

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
    expect(sentBodies[0]).toEqual({ msg_type: 2, markdown: { content: '**加粗提示**' } });
    expect(sentBodies[0].msg_id).toBeUndefined();
    expect(sentBodies[0].msg_seq).toBeUndefined();
  });

  it('契约 7: recallMessage 仅认出站短 ID (msg_self_*)，本地拒绝 msg_* 与非短 ID 且不发 DELETE，120s 超限 40064004 透传不标库', async () => {
    const methodsAndUrls: Array<{ method: string; url: string }> = [];
    let shouldExpire = false;

    const { bridge, dbMessages, recalled } = createHarness(async (url, init) => {
      methodsAndUrls.push({ method: init?.method ?? 'GET', url });
      if (shouldExpire) {
        return new Response(JSON.stringify({ code: 40064004, message: '已经超出消息撤回时限' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    });

    dbMessages.set('ROBOT1.0_OUT_RECALL_1', {
      msg_id: 'ROBOT1.0_OUT_RECALL_1',
      peer: TEST_PEER,
      short_id: 'msg_self_1',
      self: 1,
    });
    dbMessages.set('ROBOT1.0_OUT_RECALL_2', {
      msg_id: 'ROBOT1.0_OUT_RECALL_2',
      peer: TEST_PEER,
      short_id: 'msg_self_2',
      self: 1,
    });
    dbMessages.set('ROBOT1.0_IN_1', {
      msg_id: 'ROBOT1.0_IN_1',
      peer: TEST_PEER,
      short_id: 'msg_1',
      self: 0,
    });

    // 1. 合法出站短 ID -> 查真实 msg_id 调 DELETE 并标库
    const okRes = await bridge.recallMessage(TEST_PEER, 'msg_self_1', { hidetip: true });
    expect(okRes.ok).toBe(true);
    expect(recalled.has('ROBOT1.0_OUT_RECALL_1')).toBe(true);
    expect(methodsAndUrls).toHaveLength(1);
    expect(methodsAndUrls[0].method).toBe('DELETE');
    expect(methodsAndUrls[0].url).toContain(`/v2/users/${TEST_OPENID}/messages/ROBOT1.0_OUT_RECALL_1?hidetip=true`);

    // 2. 传入入站短 ID msg_1 -> 本地拒绝 INBOUND_NOT_RECALLABLE，不打 DELETE API
    const inboundErr = await bridge.recallMessage(TEST_PEER, 'msg_1');
    expect(inboundErr.ok).toBe(false);
    expect(inboundErr.status).toBe(400);
    expect(inboundErr.code).toBe('INBOUND_NOT_RECALLABLE');
    expect(methodsAndUrls).toHaveLength(1);

    // 3. 传入旧长 ID 或非法串 -> 本地拒绝 INVALID_SHORT_ID，不打 DELETE API
    for (const badId of ['ROBOT1.0_OUT_RECALL_1', 'REFIDX_OUT_1', '', 'msg_0', 'invalid']) {
      const badRes = await bridge.recallMessage(TEST_PEER, badId);
      expect(badRes.ok).toBe(false);
      expect(badRes.status).toBe(400);
      expect(badRes.code).toBe('INVALID_SHORT_ID');
    }
    expect(methodsAndUrls).toHaveLength(1);

    // 4. 库中不存在的出站短 ID -> 返回 404 NOT_FOUND，不打 DELETE API
    const notFoundRes = await bridge.recallMessage(TEST_PEER, 'msg_self_999');
    expect(notFoundRes.ok).toBe(false);
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.code).toBe('NOT_FOUND');
    expect(methodsAndUrls).toHaveLength(1);

    // 5. 120s 超限 40064004 原样透传且不标库
    shouldExpire = true;
    const errRes = await bridge.recallMessage(TEST_PEER, 'msg_self_2');
    expect(errRes.ok).toBe(false);
    expect(errRes.code).toBe(40064004);
    expect(recalled.has('ROBOT1.0_OUT_RECALL_2')).toBe(false);
  });

  it('契约 8: replyTo 传入非短 ID（如 REFIDX_... / ROBOT1.0_...）或未命中时不伪造 message_reference；sendInputNotify 异常容错', async () => {
    const sentBodies: any[] = [];

    const { bridge, dbMessages } = createHarness(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.msg_type === 6) {
        throw new Error('network glitch on input notify');
      }
      sentBodies.push(body);
      return new Response(JSON.stringify({ id: `ROBOT1.0_OUT_${sentBodies.length}` }), { status: 200 });
    });

    dbMessages.set('ROBOT1.0_IN_RAW', {
      msg_id: 'ROBOT1.0_IN_RAW',
      peer: TEST_PEER,
      short_id: 'msg_10',
      ref_idx: 'REFIDX_RAW_10',
    });

    bridge.trackInboundContext(TEST_PEER, { msg_id: 'ROBOT1.0_IN_RAW', from_user: 'a1b2c3d4e5f60708' });

    // 1) KujiraGatewayClient 内部捕获网络异常并返回 ok:false（不抛错、不阻断后续发送）
    const notifyRes = await bridge.sendInputNotify(TEST_PEER);
    expect(notifyRes?.ok).toBe(false);

    // 2) 若底层自定义 gateway.sendInputNotify 直接抛异常，bridge 捕获容错返回 null
    const throwingBridge = new OutboundStreamBridge({} as any, {
      gateway: {
        sendC2CMessage: async () => ({ ok: true, status: 200, body: { id: 'OK' } }),
        sendInputNotify: async () => {
          throw new Error('unexpected gateway throw');
        },
        deleteC2CMessage: async () => ({ ok: true, status: 200, body: {} }),
        uploadC2CMedia: async () => ({ ok: true, status: 200, body: { file_info: 'fi' } }),
      },
    });
    await expect(
      throwingBridge.sendInputNotifyIfEnabled(TEST_PEER, { openid: TEST_OPENID, msgId: 'ROBOT1.0_IN_ERR' })
    ).resolves.toBeNull();

    // replyTo 传 REFIDX_... 或 ROBOT1.0_... 或不存在的 msg_999 -> 不发 message_reference
    for (const nonShort of ['REFIDX_RAW_10', 'ROBOT1.0_IN_RAW', 'msg_999']) {
      const res = await bridge.sendTextReply(TEST_PEER, '普通回复', { replyTo: nonShort });
      expect(res.ok).toBe(true);
    }

    expect(sentBodies).toHaveLength(3);
    for (const body of sentBodies) {
      expect(body.msg_type).toBe(2);
      expect(body.message_reference).toBeUndefined();
    }
  });
});
