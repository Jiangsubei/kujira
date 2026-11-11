/**
 * tests/contract/gateway-actions.test.ts
 * 契约测试: QQ 官方 Bot API v2 KujiraGatewayClient 全协议动作契约
 *
 * 通过注入 `fetchFn` 与 `createWebSocket` 真实走通 KujiraGatewayClient 协议栈，验证：
 * - `getAccessToken` singleflight 并发合并、提前 60s (`QQ_TOKEN_REFRESH_MARGIN_MS`) 自动刷新、401 退避重取；
 * - WSS Gateway `HELLO` -> `IDENTIFY (intents = 1 << 25)` -> `READY` -> `getStatus()` / `onC2CMessage` / `onDispatch('FRIEND_ADD')`；
 * - `sendC2CMessage`: `msg_type=2` 空内容本地拦截 (`40034011`) & 剔除冗余 `content`、`msg_type=0`、`onMessageSent` 事件；
 * - `sendC2CStreamMessage`: 空 `msg_id` 本地拦截 (`50015001`) 与合法发送；
 * - `sendInputNotify`: `msg_type=6` 跳过 `onMessageSent` 自记录；
 * - `deleteC2CMessage`: 支持 `?hidetip=true`；
 * - `uploadC2CMedia`: 1-based `parts[].index` 升序 + `block_size` 四步分片 + 裸 PUT + `media_upload_cache` 24h 复用 + 软限降级 `file_type=4` + `>200MB` 硬上限拒收；
 * - `fetchAttachment`: 裸 GET 无鉴权头 + 错误与日志 URL query 脱敏。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  KujiraGatewayClient,
  type GatewayReadyInfo,
  type OutboundSentEvent,
  type QqWebSocketLike,
  type QqWsEvent,
} from '../../src/gateway/server.js';
import {
  QQ_API_BASE,
  QQ_BOT_TOKEN_URL,
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_INTENT_GROUP_AND_C2C_EVENT,
  QQ_MEDIA_HARD_LIMIT,
  QQ_MEDIA_SOFT_LIMIT_AUDIO,
  QQ_MEDIA_SOFT_LIMIT_IMAGE,
  QQ_MEDIA_SOFT_LIMIT_VIDEO,
  QQ_MSG_TYPE_INPUT_NOTIFY,
  QQ_MSG_TYPE_MARKDOWN,
  QQ_MSG_TYPE_TEXT,
  QQ_TOKEN_REFRESH_MARGIN_MS,
} from '../../src/constants/index.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_APP_ID = '100001';
const MOCK_SECRET = 'mock-bot-secret-xyz';

class FakeGatewayWs implements QqWebSocketLike {
  readyState = 0;
  readonly sentFrames: any[] = [];
  private listeners = new Map<string, Set<(ev: QqWsEvent) => void>>();

  constructor(public readonly url: string) {}

  addEventListener(type: string, listener: (ev: QqWsEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'closed' });
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  emitFrame(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  private emit(type: string, ev: QqWsEvent): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      fn(ev);
    }
  }
}

interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

describe('契约测试: KujiraGatewayClient Official Bot v2 全协议动作契约', () => {
  const clients: KujiraGatewayClient[] = [];
  const tmpDirs: string[] = [];

  function trackClient(client: KujiraGatewayClient): KujiraGatewayClient {
    clients.push(client);
    return client;
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const c of clients.splice(0)) {
      c.stop();
    }
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it('契约 1: getAccessToken — singleflight 并发去重、提前 60s 自动刷新与 401 退避重取', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

    let tokenCalls = 0;
    let gatewayCalls = 0;
    const calls: RecordedFetch[] = [];

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';
      const headers = (init?.headers as Record<string, string>) || {};
      const bodyText = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, headers, bodyText });

      if (url === QQ_BOT_TOKEN_URL) {
        tokenCalls += 1;
        return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 120 });
      }
      if (url === `${QQ_API_BASE}/gateway`) {
        gatewayCalls += 1;
        if (gatewayCalls === 1) {
          return jsonResponse({ message: 'unauthorized' }, 401);
        }
        return jsonResponse({ url: 'wss://gateway.sgroup.qq.com/ws' });
      }
      return jsonResponse({}, 404);
    };

    const client = trackClient(
      new KujiraGatewayClient({
        appId: MOCK_APP_ID,
        appSecret: MOCK_SECRET,
        fetchFn,
        authRetryDelayMs: 0,
      })
    );

    // 1. 并发 5 次 getAccessToken -> singleflight 只发 1 次 token 请求
    const concurrent = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    expect(concurrent).toEqual(['tok-1', 'tok-1', 'tok-1', 'tok-1', 'tok-1']);
    expect(tokenCalls).toBe(1);
    expect(JSON.parse(calls[0]!.bodyText!)).toEqual({
      appId: MOCK_APP_ID,
      clientSecret: MOCK_SECRET,
    });

    // 2. 推进 59s（剩余 61s > 60s 缓冲期）-> 复用缓存 tok-1
    vi.advanceTimersByTime(59_000);
    expect(await client.getAccessToken()).toBe('tok-1');
    expect(tokenCalls).toBe(1);

    // 3. 再推进 2s（剩余 59s < QQ_TOKEN_REFRESH_MARGIN_MS=60_000）-> 自动刷新拿到 tok-2
    expect(QQ_TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
    vi.advanceTimersByTime(2_000);
    expect(await client.getAccessToken()).toBe('tok-2');
    expect(tokenCalls).toBe(2);

    // 4. 请求 /v2/users/{openid}/messages 或 REST 接口遇 401 -> 退避重取 tok-3 并自动携带新 token 重试
    let msgAttempt = 0;
    const authFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers as Record<string, string>) || {};
      calls.push({ url, method: init?.method || 'GET', headers });
      if (url === QQ_BOT_TOKEN_URL) {
        tokenCalls += 1;
        return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 7200 });
      }
      msgAttempt += 1;
      if (msgAttempt === 1) {
        return jsonResponse({ message: 'token expired' }, 401);
      }
      return jsonResponse({ id: 'ROBOT1.0_RETRY_OK' }, 200);
    };

    const retryClient = trackClient(
      new KujiraGatewayClient({
        appId: MOCK_APP_ID,
        appSecret: MOCK_SECRET,
        fetchFn: authFetch,
        authRetryDelayMs: 0,
      })
    );

    const res = await retryClient.sendC2CMessage(MOCK_OPENID, {
      msg_type: QQ_MSG_TYPE_TEXT,
      content: 'hi',
    });
    expect(res.ok).toBe(true);
    expect(res.body.id).toBe('ROBOT1.0_RETRY_OK');
    expect(msgAttempt).toBe(2);
    const authHeaders = calls.filter((c) => c.url.includes('/messages')).map((c) => c.headers.Authorization);
    expect(authHeaders).toEqual(['QQBot tok-3', 'QQBot tok-4']);
  });

  it('契约 2: WSS Gateway — HELLO -> IDENTIFY (intents=1<<25) -> READY -> getStatus / onC2CMessage / onDispatch(FRIEND_ADD)', async () => {
    let fakeWs: FakeGatewayWs | null = null;
    const readyEvents: GatewayReadyInfo[] = [];
    const c2cEvents: any[] = [];
    const dispatchEvents: Array<{ name: string; data: unknown }> = [];

    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === QQ_BOT_TOKEN_URL) {
        return jsonResponse({ access_token: 'ws-tok-1', expires_in: 7200 });
      }
      if (url === `${QQ_API_BASE}/gateway`) {
        return jsonResponse({ url: 'wss://gateway.sgroup.qq.com/ws' });
      }
      return jsonResponse({}, 404);
    };

    const client = trackClient(
      new KujiraGatewayClient({
        appId: MOCK_APP_ID,
        appSecret: MOCK_SECRET,
        fetchFn,
        createWebSocket: (url) => {
          fakeWs = new FakeGatewayWs(url);
          return fakeWs;
        },
        onReady: (info) => readyEvents.push(info),
        onC2CMessage: (ev) => c2cEvents.push(ev),
        onDispatch: (name, data) => dispatchEvents.push({ name, data }),
      })
    );

    await client.start();
    expect(fakeWs).not.toBeNull();
    expect(fakeWs!.url).toBe('wss://gateway.sgroup.qq.com/ws');

    // 1. Open + HELLO -> IDENTIFY (intents = 1 << 25)
    fakeWs!.emitOpen();
    fakeWs!.emitFrame({ op: 10, d: { heartbeat_interval: 45_000 } });
    await vi.waitFor(() => expect(fakeWs!.sentFrames).toHaveLength(1));

    expect(QQ_INTENT_GROUP_AND_C2C_EVENT).toBe(1 << 25);
    expect(fakeWs!.sentFrames[0]).toMatchObject({
      op: 2,
      d: {
        token: 'QQBot ws-tok-1',
        intents: QQ_INTENT_GROUP_AND_C2C_EVENT,
      },
    });

    // 2. READY -> getStatus() 就绪
    fakeWs!.emitFrame({
      op: 0,
      s: 1,
      t: 'READY',
      d: {
        session_id: 'gw-sess-1',
        user: { id: 'bot-101', username: 'KujiraBot', bot: true },
      },
    });
    expect(readyEvents).toEqual([{ sessionId: 'gw-sess-1', botId: 'bot-101', botName: 'KujiraBot' }]);
    expect(client.getStatus()).toEqual({
      connected: true,
      ready: true,
      botId: 'bot-101',
      botName: 'KujiraBot',
      reconnectAttempts: 0,
    });

    // 3. C2C_MESSAGE_CREATE -> onC2CMessage
    const c2cPayload = {
      id: 'ROBOT1.0_IN_1',
      content: '你好 Kujira',
      timestamp: '2026-06-01T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
    };
    fakeWs!.emitFrame({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: c2cPayload });
    expect(c2cEvents).toEqual([c2cPayload]);

    // 4. FRIEND_ADD -> onDispatch('FRIEND_ADD')（不触发 onC2CMessage）
    const friendAddData = { openid: MOCK_OPENID, timestamp: '2026-06-01T12:01:00+08:00' };
    fakeWs!.emitFrame({ op: 0, s: 3, t: 'FRIEND_ADD', d: friendAddData });
    expect(c2cEvents).toHaveLength(1);
    expect(dispatchEvents.some((e) => e.name === 'FRIEND_ADD' && (e.data as any).openid === MOCK_OPENID)).toBe(true);
  });

  it('契约 3: sendC2CMessage (msg_type=2 非空校验/去冗余 content、msg_type=0、onMessageSent)、流式 50015001、输入状态跳过自记录、撤回 ?hidetip=true', async () => {
    const requests: RecordedFetch[] = [];
    const sentEvents: OutboundSentEvent[] = [];
    let outIdx = 0;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';
      const headers = (init?.headers as Record<string, string>) || {};
      const bodyText = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ url, method, headers, bodyText });

      if (url === QQ_BOT_TOKEN_URL) {
        return jsonResponse({ access_token: 'rest-tok-1', expires_in: 7200 });
      }
      if (url.endsWith('/messages') && method === 'POST') {
        outIdx += 1;
        return jsonResponse({
          id: `ROBOT1.0_OUT_${outIdx}`,
          timestamp: '2026-06-01T12:00:00+08:00',
          ext_info: { ref_idx: `REFIDX_OUT_${outIdx}` },
        });
      }
      if (url.endsWith('/stream_messages') && method === 'POST') {
        return jsonResponse({ id: 'STREAM_OUT_1', remain_msg_len: 0 });
      }
      if (method === 'DELETE') {
        return jsonResponse({});
      }
      return jsonResponse({}, 404);
    };

    const client = trackClient(
      new KujiraGatewayClient({
        appId: MOCK_APP_ID,
        appSecret: MOCK_SECRET,
        fetchFn,
        onMessageSent: (ev) => sentEvents.push(ev),
      })
    );

    // 1. msg_type=2 空 markdown.content 拦截（40034011），不发 HTTP 请求
    const emptyMd = await client.sendC2CMessage(MOCK_OPENID, {
      msg_type: QQ_MSG_TYPE_MARKDOWN,
      markdown: { content: '   ' },
    });
    expect(emptyMd.ok).toBe(false);
    expect(emptyMd.code).toBe(40034011);
    expect(requests).toHaveLength(0);

    // 2. msg_type=2 正常发送：严格去除冗余 content，仅发 markdown.content，触发 onMessageSent
    const mdRes = await client.sendC2CMessage(MOCK_OPENID, {
      msg_type: QQ_MSG_TYPE_MARKDOWN,
      content: 'should-be-stripped',
      markdown: { content: '# 标题\n正文' },
      msg_id: 'ROBOT1.0_IN_1',
      msg_seq: 1,
    });
    expect(mdRes.ok).toBe(true);
    const mdReq = requests.find((r) => r.url.endsWith('/messages'))!;
    const mdBody = JSON.parse(mdReq.bodyText!);
    expect(mdBody.msg_type).toBe(2);
    expect(mdBody.markdown).toEqual({ content: '# 标题\n正文' });
    expect(Object.hasOwn(mdBody, 'content')).toBe(false);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      peer: openidToPeer(MOCK_OPENID),
      openid: MOCK_OPENID,
      msgId: 'ROBOT1.0_OUT_1',
      refIdx: 'REFIDX_OUT_1',
      msgType: 2,
      text: '# 标题\n正文',
    });

    // 3. msg_type=0 纯文本发送 + onMessageSent
    const txtRes = await client.sendC2CMessage(MOCK_OPENID, {
      msg_type: QQ_MSG_TYPE_TEXT,
      content: '纯文本回复',
      msg_id: 'ROBOT1.0_IN_1',
      msg_seq: 2,
    });
    expect(txtRes.ok).toBe(true);
    expect(sentEvents).toHaveLength(2);
    expect(sentEvents[1]).toMatchObject({
      msgId: 'ROBOT1.0_OUT_2',
      msgType: 0,
      text: '纯文本回复',
    });

    // 4. sendC2CStreamMessage 空 msg_id 本地拦截 50015001
    const countBeforeStream = requests.length;
    const badStream = await client.sendC2CStreamMessage(MOCK_OPENID, {
      input_mode: 'append',
      input_state: 1,
      index: 0,
      content_type: 'markdown',
      content_raw: 'delta',
      msg_id: '   ',
      msg_seq: 3,
    });
    expect(badStream.ok).toBe(false);
    expect(badStream.code).toBe(50015001);
    expect(requests).toHaveLength(countBeforeStream);

    const goodStream = await client.sendC2CStreamMessage(MOCK_OPENID, {
      input_mode: 'append',
      input_state: 1,
      index: 0,
      content_type: 'markdown',
      content_raw: 'delta',
      msg_id: 'ROBOT1.0_IN_1',
      msg_seq: 3,
    });
    expect(goodStream.ok).toBe(true);
    expect(goodStream.body.id).toBe('STREAM_OUT_1');

    // 5. sendInputNotify msg_type=6 跳过 onMessageSent 自记录
    const notifyRes = await client.sendInputNotify(MOCK_OPENID, 'ROBOT1.0_IN_1', 4);
    expect(notifyRes.ok).toBe(true);
    const notifyReq = requests[requests.length - 1]!;
    expect(JSON.parse(notifyReq.bodyText!)).toEqual({
      msg_type: QQ_MSG_TYPE_INPUT_NOTIFY,
      input_notify: { input_type: 1, input_second: 60 },
      msg_id: 'ROBOT1.0_IN_1',
      msg_seq: 4,
    });
    expect(sentEvents).toHaveLength(2); // 未增加

    // 6. deleteC2CMessage ?hidetip=true 与默认撤回
    const delHide = await client.deleteC2CMessage(MOCK_OPENID, 'ROBOT1.0_OUT_1', true);
    expect(delHide.ok).toBe(true);
    expect(requests[requests.length - 1]!.method).toBe('DELETE');
    expect(requests[requests.length - 1]!.url).toBe(
      `${QQ_API_BASE}/v2/users/${MOCK_OPENID}/messages/ROBOT1.0_OUT_1?hidetip=true`
    );

    const delPlain = await client.deleteC2CMessage(MOCK_OPENID, 'ROBOT1.0_OUT_2');
    expect(delPlain.ok).toBe(true);
    expect(requests[requests.length - 1]!.url).toBe(
      `${QQ_API_BASE}/v2/users/${MOCK_OPENID}/messages/ROBOT1.0_OUT_2`
    );
  });

  it('契约 4: uploadC2CMedia — 1-based 四步分片 + block_size + media_upload_cache 24h 复用 + 软限降级 file_type=4 + >200MB 拒收', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-gw-upload-'));
    tmpDirs.push(tmpDir);
    const db = new MessageDatabase(path.join(tmpDir, 'cache.sqlite'));
    db.init();

    const requests: RecordedFetch[] = [];
    const putChunks: Array<{ url: string; bytes: Uint8Array; headers: Record<string, string> }> = [];
    let mergeCalls = 0;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';
      const headers = (init?.headers as Record<string, string>) || {};
      const bodyText = typeof init?.body === 'string' ? init.body : undefined;
      const bodyBytes = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined;
      requests.push({ url, method, headers, bodyText, bodyBytes });

      if (url === QQ_BOT_TOKEN_URL) {
        return jsonResponse({ access_token: 'upload-tok-1', expires_in: 7200 });
      }
      if (url.endsWith('/upload_prepare')) {
        const reqBody = JSON.parse(bodyText!);
        if (Number(reqBody.file_size) === 10) {
          // 故意乱序返回 index=2 与 index=1，验证客户端按 1-based index 升序排序与独立 block_size
          return jsonResponse({
            upload_id: 'up-10bytes',
            block_size: '4',
            parts: [
              { index: 2, presigned_url: 'https://cos.example/part2?rkey=secret2', block_size: '6' },
              { index: 1, presigned_url: 'https://cos.example/part1?rkey=secret1', block_size: '4' },
            ],
          });
        }
        return jsonResponse({
          upload_id: 'up-single',
          block_size: reqBody.file_size,
          parts: [{ index: 1, presigned_url: 'https://cos.example/single?rkey=s', block_size: reqBody.file_size }],
        });
      }
      if (url.startsWith('https://cos.example/') && method === 'PUT') {
        putChunks.push({ url, bytes: bodyBytes!, headers });
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/upload_part_finish')) {
        return jsonResponse({});
      }
      if (url.endsWith('/files')) {
        mergeCalls += 1;
        return jsonResponse({
          file_uuid: `uuid-${mergeCalls}`,
          file_info: `file-info-${mergeCalls}`,
          ttl: 86_400,
        });
      }
      return jsonResponse({}, 404);
    };

    const client = trackClient(
      new KujiraGatewayClient({
        appId: MOCK_APP_ID,
        appSecret: MOCK_SECRET,
        fetchFn,
      })
    );

    // 1. 10 字节分片（4 + 6），验证 1-based 顺序、裸 PUT 无鉴权头、upload_part_finish 上报真实 block_size 与 md5
    const sampleBuf = Buffer.from('0123456789', 'utf8');
    const up1 = await client.uploadC2CMedia(MOCK_OPENID, sampleBuf, {
      fileType: QQ_FILE_TYPE_IMAGE,
      fileName: 'pic.png',
      db,
    });
    expect(up1.ok).toBe(true);
    expect(up1.body).toEqual({
      file_uuid: 'uuid-1',
      file_info: 'file-info-1',
      ttl: 86_400,
    });

    expect(putChunks).toHaveLength(2);
    expect(putChunks[0]!.url).toContain('/part1');
    expect(Buffer.from(putChunks[0]!.bytes).toString('utf8')).toBe('0123');
    expect(putChunks[0]!.headers.Authorization).toBeUndefined();
    expect(putChunks[1]!.url).toContain('/part2');
    expect(Buffer.from(putChunks[1]!.bytes).toString('utf8')).toBe('456789');
    expect(putChunks[1]!.headers.Authorization).toBeUndefined();

    const finishReqs = requests
      .filter((r) => r.url.endsWith('/upload_part_finish'))
      .map((r) => JSON.parse(r.bodyText!));
    expect(finishReqs).toEqual([
      { upload_id: 'up-10bytes', part_index: 1, block_size: '4', md5: md5Hex(sampleBuf.subarray(0, 4)) },
      { upload_id: 'up-10bytes', part_index: 2, block_size: '6', md5: md5Hex(sampleBuf.subarray(4, 10)) },
    ]);

    // 2. 相同 (openid, md5, fileType) 再次上传 -> 命中 24h media_upload_cache，不触发新的 HTTP 上传
    const reqCountAfterFirst = requests.length;
    const upCached = await client.uploadC2CMedia(MOCK_OPENID, sampleBuf, {
      fileType: QQ_FILE_TYPE_IMAGE,
      fileName: 'pic.png',
      db,
    });
    expect(upCached.ok).toBe(true);
    expect(upCached.body.file_info).toBe('file-info-1');
    expect(requests).toHaveLength(reqCountAfterFirst);

    // 3. 软限超限自动降级 file_type=4 (图片 >20MB / 语音 >20MB / 视频 >30MB)
    requests.length = 0;
    const overImage = new Uint8Array(QQ_MEDIA_SOFT_LIMIT_IMAGE + 1);
    overImage[0] = 1;
    const overImgRes = await client.uploadC2CMedia(MOCK_OPENID, overImage, {
      fileType: QQ_FILE_TYPE_IMAGE,
      fileName: 'big.png',
    });
    expect(overImgRes.ok).toBe(true);
    const imgPrep = JSON.parse(requests.find((r) => r.url.endsWith('/upload_prepare'))!.bodyText!);
    expect(imgPrep.file_type).toBe(QQ_FILE_TYPE_FILE);

    requests.length = 0;
    const overAudio = new Uint8Array(QQ_MEDIA_SOFT_LIMIT_AUDIO + 1);
    overAudio[0] = 2;
    await client.uploadC2CMedia(MOCK_OPENID, overAudio, {
      fileType: QQ_FILE_TYPE_AUDIO,
      fileName: 'big.wav',
    });
    const audioPrep = JSON.parse(requests.find((r) => r.url.endsWith('/upload_prepare'))!.bodyText!);
    expect(audioPrep.file_type).toBe(QQ_FILE_TYPE_FILE);

    requests.length = 0;
    const overVideo = new Uint8Array(QQ_MEDIA_SOFT_LIMIT_VIDEO + 1);
    overVideo[0] = 3;
    await client.uploadC2CMedia(MOCK_OPENID, overVideo, {
      fileType: QQ_FILE_TYPE_VIDEO,
      fileName: 'big.mp4',
    });
    const videoPrep = JSON.parse(requests.find((r) => r.url.endsWith('/upload_prepare'))!.bodyText!);
    expect(videoPrep.file_type).toBe(QQ_FILE_TYPE_FILE);

    // 4. 超过 200MB 硬上限本地直接拒收（不发起任何网络请求）
    requests.length = 0;
    const overHard = new Uint8Array(QQ_MEDIA_HARD_LIMIT + 1);
    const hardRes = await client.uploadC2CMedia(MOCK_OPENID, overHard, {
      fileType: QQ_FILE_TYPE_FILE,
      fileName: 'huge.bin',
    });
    expect(hardRes.ok).toBe(false);
    expect(hardRes.status).toBe(400);
    expect(hardRes.message).toContain('200MB');
    expect(requests).toHaveLength(0);

    db.close();
  });

  it('契约 5: fetchAttachment — 裸 GET 无鉴权头，异常时 URL query 参数彻底脱敏', async () => {
    const requests: RecordedFetch[] = [];
    const secretUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=SUPER_SECRET_RKEY&token=TOK_XYZ';

    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers as Record<string, string>) || {};
      requests.push({ url, method: init?.method || 'GET', headers });

      if (url.includes('fail=1')) {
        throw new Error(`connect failed for ${url}`);
      }
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    };

    const client = trackClient(
      new KujiraGatewayClient({
        appId: MOCK_APP_ID,
        appSecret: MOCK_SECRET,
        fetchFn,
      })
    );

    const okRes = await client.fetchAttachment(secretUrl);
    expect(okRes.ok).toBe(true);
    expect(Array.from(okRes.bytes)).toEqual([1, 2, 3, 4]);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers.Authorization).toBeUndefined();

    const failRes = await client.fetchAttachment(`${secretUrl}&fail=1`);
    expect(failRes.ok).toBe(false);
    expect(failRes.message).toContain('?<redacted>');
    expect(failRes.message).not.toContain('SUPER_SECRET_RKEY');
    expect(failRes.message).not.toContain('TOK_XYZ');
  });
});
