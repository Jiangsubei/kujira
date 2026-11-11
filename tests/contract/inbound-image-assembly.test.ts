import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import type { SessionManager } from '../../src/gateway/session.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import { openidToPeer } from '../../src/utils/peer.js';

/**
 * 契约测试: 入站图片落盘真实装配闭环 (Inbound Image Assembly)
 *
 * 真实装配路径: bootDshKujira({ mountPlugin: true }) -> Official Gateway WS (C2C_MESSAGE_CREATE) ->
 * resolveInboundAttachments (裸 GET 无 Authorization 头) -> MediaStorageManager 落盘 -> SQLite messages。
 *
 * - ASM-1: attachments[] 带 ?rkey=mock_secret 裸 GET 下载落入 dshHome/kujira/downloads/image/<peer>/，
 *          SQLite 写入 local_path 与 attachments JSON；
 * - ASM-2: 死链 / HTTP 403 失败时 local_path 为 null，描述符 unavailable 不泄漏 rkey query，正文与唤醒遵循选项 A 保留真实直链；
 * - ASM-3: 魔数纠偏（响应头错报 image/jpeg、文件名 .jpg 但字节为 PNG → 实际落盘 .png 且 format='png'）；
 * - ASM-4: 多图 attachments[] 并发裸 GET 下载并全部落盘记录至 attachments JSON 与正文；
 * - ASM-5: message_type=102 合并转发内嵌媒体（视频/图片/文件）全部入库为 attachments 并保留真实 rkey URL，`local_path` 收敛到图片。
 */

const nativeFetch = globalThis.fetch;

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_APP_ID = 'app_kujira_mock';
const MOCK_APP_SECRET = 'secret_kujira_mock';
const MOCK_BOT_ID = 'bot_kujira_01';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 3),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 7),
]);
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(16, 0x11),
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n%mock-forward-file\n');

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
            session_id: 'sess-img-1',
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

describe('契约测试: 入站图片落盘真实装配闭环 (Inbound Image Assembly)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let servers: http.Server[] = [];
  let capturedFollowups: Array<{ text: string }> = [];

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  async function startHttpServer(
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => void
  ): Promise<{ baseUrl: string; requests: Array<{ method: string; url: string; authorization?: string }> }> {
    const requests: Array<{ method: string; url: string; authorization?: string }> = [];
    const srv = http.createServer((req, res) => {
      requests.push({
        method: req.method || 'GET',
        url: req.url || '',
        authorization: req.headers.authorization,
      });
      handler(req, res);
    });
    servers.push(srv);
    await new Promise<void>((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = srv.address() as any;
    return {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      requests,
    };
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

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-inbound-img-'));
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
        return new Response(JSON.stringify({ id: 'ROBOT1.0_MOCK_ACK' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return nativeFetch(input, init);
    };

    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    vi.stubGlobal('fetch', mockFetch);

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        input_notify_enabled: false,
      },
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

    const sm = booted.ctx.get('kujira-session') as SessionManager;
    const agent = await sm.getOrCreateAgent(MOCK_PEER);
    const capture = (msg: any) => {
      const text = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => c?.text || '').join('')
        : String(msg?.content || '');
      capturedFollowups.push({ text });
    };
    (agent as any).followup = capture;
    (agent as any).steer = capture;
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

  it('ASM-1: C2C_MESSAGE_CREATE attachments[] 裸 GET 下载无 Authorization 头，落入 dshHome/kujira/downloads/image/<peer>/ 并写入 local_path 与 attachments JSON', async () => {
    const srv = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_IMG_1',
      content: '',
      timestamp: '2026-11-11T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IN_IMG_1'] },
      attachments: [
        {
          content_type: 'image/png',
          filename: 'photo.png',
          size: PNG_BYTES.length,
          width: 100,
          height: 100,
          url: `${srv.baseUrl}/img/photo.png?rkey=mock_secret`,
        },
      ],
    });

    const row = await waitForDbRow('ROBOT1.0_IN_IMG_1');
    await waitUntil(() => capturedFollowups.length === 1, 3000, 'followup captured');

    // 验证裸 GET 请求无 Authorization 头且携带完整 rkey query
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]!.method).toBe('GET');
    expect(srv.requests[0]!.url).toBe('/img/photo.png?rkey=mock_secret');
    expect(srv.requests[0]!.authorization).toBeUndefined();

    // 验证落盘路径位于 dshHome/kujira/downloads/image/<peer>/
    const expectedDir = path.resolve(tmpHome, 'kujira', 'downloads', 'image', MOCK_PEER);
    expect(row.type).toBe('image');
    expect(row.peer).toBe(MOCK_PEER);
    expect(row.ref_idx).toBe('REFIDX_IN_IMG_1');
    expect(row.local_path).toBeTruthy();
    expect(path.resolve(row.local_path).startsWith(expectedDir)).toBe(true);
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(row.local_path), PNG_BYTES)).toBe(0);

    // 验证 SQLite attachments JSON
    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts).toHaveLength(1);
    expect(parsedAtts[0].kind).toBe('image');
    expect(parsedAtts[0].origin).toBe('inbound');
    expect(parsedAtts[0].local?.path).toBe(row.local_path);
    expect(parsedAtts[0].local?.format).toBe('png');
    expect(parsedAtts[0].local?.fingerprint).toBeTruthy();
    expect(parsedAtts[0].local?.md5).toBeTruthy();

    // 正文与唤醒提示词只展示本地 OS 路径，绝不泄露 rkey query
    expect(row.content).toBe(`[图片:${row.local_path}]`);
    expect(row.content).not.toContain('rkey');
    expect(row.content).not.toContain('mock_secret');
    expect(capturedFollowups[0]!.text).toContain(`[图片:${row.local_path}]`);
    expect(capturedFollowups[0]!.text).not.toContain('rkey');
    expect(capturedFollowups[0]!.text).not.toContain('mock_secret');
  });

  it('ASM-2: 死链或 HTTP 403 失败时 local_path = null，unavailable 脱敏且正文与唤醒遵循选项 A 保留真实直链', async () => {
    const srv = await startHttpServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'rkey expired' }));
    });

    const rawUrl = `${srv.baseUrl}/expired/expired.png?rkey=mock_secret`;
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_IMG_DEAD',
      content: '看看这张失效图',
      timestamp: '2026-11-11T12:01:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IN_IMG_DEAD'] },
      attachments: [
        {
          content_type: 'image/png',
          filename: 'expired.png',
          size: 128,
          url: rawUrl,
        },
      ],
    });

    const row = await waitForDbRow('ROBOT1.0_IN_IMG_DEAD');
    await waitUntil(() => capturedFollowups.length === 1, 3000, 'followup captured for dead link');

    expect(row.local_path).toBeNull();
    expect(row.content).toContain('看看这张失效图');
    expect(row.content).toContain('(下载失败:');
    expect(row.content).toContain(`直链: ${rawUrl}`);
    expect(row.content).not.toContain('链接已脱敏');
    expect(capturedFollowups[0]!.text).toContain('(下载失败:');
    expect(capturedFollowups[0]!.text).toContain(`直链: ${rawUrl}`);
    expect(capturedFollowups[0]!.text).not.toContain('链接已脱敏');

    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts).toHaveLength(1);
    expect(parsedAtts[0].local).toBeUndefined();
    expect(parsedAtts[0].unavailable).toBeTruthy();
    expect(String(parsedAtts[0].unavailable)).toContain('403');
    expect(String(parsedAtts[0].unavailable)).not.toContain('rkey');
    expect(String(parsedAtts[0].unavailable)).not.toContain('mock_secret');
  });

  it('ASM-3: 响应头错报与伪扩展名纠偏 — 以真实字节魔数落盘 .png 且 format="png"', async () => {
    const srv = await startHttpServer((_req, res) => {
      // 模拟服务端响应头错报为 image/jpeg
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(PNG_BYTES);
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_IMG_MAGIC',
      content: '',
      timestamp: '2026-11-11T12:02:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'image/jpeg',
          filename: 'misnamed.jpg',
          size: PNG_BYTES.length,
          url: `${srv.baseUrl}/img/misnamed.jpg?rkey=mock_secret`,
        },
      ],
    });

    const row = await waitForDbRow('ROBOT1.0_IN_IMG_MAGIC');
    expect(row.local_path).toBeTruthy();
    expect(String(row.local_path).endsWith('.png')).toBe(true);
    expect(fs.existsSync(row.local_path)).toBe(true);

    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts[0].local?.format).toBe('png');
  });

  it('ASM-4: 多图 attachments[] 并发裸 GET 下载落盘并写入完整 attachments JSON', async () => {
    const srv = await startHttpServer((req, res) => {
      if (req.url?.includes('first')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG_BYTES);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(JPEG_BYTES);
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_IMG_MULTI',
      content: '两张图对比下',
      timestamp: '2026-11-11T12:03:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'image/png',
          filename: 'first.png',
          size: PNG_BYTES.length,
          url: `${srv.baseUrl}/img/first.png?rkey=mock_secret`,
        },
        {
          content_type: 'image/jpeg',
          filename: 'second.jpg',
          size: JPEG_BYTES.length,
          url: `${srv.baseUrl}/img/second.jpg?rkey=mock_secret`,
        },
      ],
    });

    const row = await waitForDbRow('ROBOT1.0_IN_IMG_MULTI');
    expect(srv.requests).toHaveLength(2);
    expect(srv.requests.every((r) => r.authorization === undefined)).toBe(true);

    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts).toHaveLength(2);
    expect(parsedAtts[0].local?.path).toBeTruthy();
    expect(parsedAtts[1].local?.path).toBeTruthy();
    expect(fs.existsSync(parsedAtts[0].local.path)).toBe(true);
    expect(fs.existsSync(parsedAtts[1].local.path)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(parsedAtts[0].local.path), PNG_BYTES)).toBe(0);
    expect(Buffer.compare(fs.readFileSync(parsedAtts[1].local.path), JPEG_BYTES)).toBe(0);
    expect(row.content).toContain(`[图片:${parsedAtts[0].local.path}]`);
    expect(row.content).toContain(`[图片:${parsedAtts[1].local.path}]`);
  });

  it('ASM-5: message_type=102 合并转发内嵌媒体全部入库为 attachments（保留真实 rkey），local_path 收敛到图片', async () => {
    const srv = await startHttpServer((req, res) => {
      if (req.url?.includes('clip.mp4')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(MP4_BYTES);
        return;
      }
      if (req.url?.includes('report.pdf')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(PDF_BYTES);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const videoUrl = `${srv.baseUrl}/media/clip.mp4?rkey=fwd_video_secret`;
    const imageUrl = `${srv.baseUrl}/media/cat.png?rkey=fwd_img_secret`;
    const fileUrl = `${srv.baseUrl}/media/report.pdf?rkey=fwd_file_secret`;
    const content = [
      '[群聊的聊天记录]',
      '=== 消息 1 ===',
      '[发送者] 群友A',
      `[附件1] 类型:视频 文件名:clip.mp4 尺寸:720x1280 URL:${videoUrl}`,
      '=== 消息 2 ===',
      '[发送者] 群友B',
      '看看这只猫',
      `[附件1] 类型:图片 文件名:cat.png URL:${imageUrl}`,
      '=== 消息 3 ===',
      '[发送者] 群友C',
      `[附件1] 类型:文件 文件名:report.pdf URL:${fileUrl}`,
    ].join('\n');

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_FORWARD_MEDIA',
      content,
      timestamp: '2026-11-11T12:04:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 102,
      message_scene: { ext: ['msg_idx=REFIDX_IN_FORWARD_MEDIA'] },
    });

    const row = await waitForDbRow('ROBOT1.0_IN_FORWARD_MEDIA');

    // 合并转发主导类型保持 forward，正文为结构化对话流
    expect(row.type).toBe('forward');
    expect(row.content).toContain('1. 群友A: [视频:clip.mp4');
    expect(row.content).toContain('2. 群友B: 看看这只猫 [图片:');
    expect(row.content).toContain('3. 群友C: [文件:report.pdf 已保存:');
    expect(row.content).not.toContain('rkey');
    expect(row.content).not.toContain('fwd_video_secret');

    // 全量内嵌媒体均入库为 attachments，目录分类正确
    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts.map((a: any) => a.kind)).toEqual(['video', 'image', 'file']);
    expect(parsedAtts.every((a: any) => a.origin === 'inbound')).toBe(true);
    const [videoAtt, imageAtt, fileAtt] = parsedAtts;
    expect(
      path.resolve(videoAtt.local.path).startsWith(
        path.resolve(tmpHome, 'kujira', 'downloads', 'video', MOCK_PEER)
      )
    ).toBe(true);
    expect(
      path.resolve(imageAtt.local.path).startsWith(
        path.resolve(tmpHome, 'kujira', 'downloads', 'image', MOCK_PEER)
      )
    ).toBe(true);
    expect(
      path.resolve(fileAtt.local.path).startsWith(
        path.resolve(tmpHome, 'kujira', 'downloads', 'files', MOCK_PEER)
      )
    ).toBe(true);
    expect(fs.existsSync(videoAtt.local.path)).toBe(true);
    expect(fs.existsSync(imageAtt.local.path)).toBe(true);
    expect(fs.existsSync(fileAtt.local.path)).toBe(true);

    // 入库保留官方真实响应（含 rkey），仅在展示层清洗
    expect(videoAtt.remote?.url).toBe(videoUrl);
    expect(imageAtt.remote?.url).toBe(imageUrl);
    expect(fileAtt.remote?.url).toBe(fileUrl);
    expect(imageAtt.local.fingerprint).toBeTruthy();
    expect(imageAtt.local.md5).toBeTruthy();

    // local_path 收敛到图片，而不是按出现顺序取视频
    expect(row.local_path).toBe(imageAtt.local.path);
  });
});
