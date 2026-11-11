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
 * 契约测试: 单聊文件与语音入站即时落盘装配闭环 (PF-001)
 *
 * 真实装配路径验证: bootDshKujira({ mountPlugin: true }) -> Official Gateway WS (C2C_MESSAGE_CREATE) ->
 * resolveInboundAttachments -> MediaStorageManager -> SQLite messages -> SessionManager.dispatchWakeup:
 * - PF-1: content_type="file" 常规文件 (.txt / .pdf) 裸 GET 即时落盘至 files/<peer>/ 并渲染 [文件:... 已保存: ...]；
 * - PF-2: 实测特征 — .png 走 content_type="file" 时按扩展名改判 'image'，落盘 image/<peer>/ 并渲染 [图片:path]；
 * - PF-3: 安全文件名净化防 ../ 与 ..\ 路径穿越；
 * - PF-4: content_type="voice" 优先拉取 voice_wav_url（忽略 audio/mp3 错报头），落盘 .wav 并保留 asr_refer_text；
 * - PF-5: voice_wav_url 失败回退 url；双失败时 local_path = null、保留 asr_refer_text、unavailable 脱敏且正文遵循选项 A 保留真实直链；
 * - PF-6: 空消息不落库不唤醒，纯空格消息正常入库并唤醒。
 */

const nativeFetch = globalThis.fetch;

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_APP_ID = 'app_kujira_mock';
const MOCK_APP_SECRET = 'secret_kujira_mock';
const MOCK_BOT_ID = 'bot_kujira_01';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 5),
]);
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(24, 1),
]);
const AMR_BYTES = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(20, 2)]);

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
            session_id: 'sess-pf-1',
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

describe('契约测试: 单聊文件与语音入站即时落盘装配闭环 (PF-001)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let servers: http.Server[] = [];
  let capturedFollowups: Array<{ content: string }> = [];

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  async function startHttpServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
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

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-pf-'));
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
      capturedFollowups.push({ content: text });
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

  it('PF-1: content_type="file" 常规文件 (.txt / .pdf) 裸 GET 即时落盘至 files/<peer>/ 并渲染唤醒路径', async () => {
    const srv = await startHttpServer((req, res) => {
      if (req.url?.includes('.pdf')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end('%PDF-1.7-mock');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('hello private file');
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_TXT_1',
      content: '',
      timestamp: '2026-11-11T12:10:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'file',
          filename: '演示文件.txt',
          size: 18,
          url: `${srv.baseUrl}/files/demo.txt?rkey=mock_secret`,
        },
      ],
    });

    const rowTxt = await waitForDbRow('ROBOT1.0_PF_TXT_1');
    await waitUntil(() => capturedFollowups.length >= 1, 3000, 'followup 1');

    const expectedFilesDir = path.resolve(tmpHome, 'kujira', 'downloads', 'files', MOCK_PEER);
    expect(rowTxt.type).toBe('file');
    expect(rowTxt.local_path).toBeTruthy();
    expect(path.resolve(rowTxt.local_path).startsWith(expectedFilesDir)).toBe(true);
    expect(rowTxt.local_path).toContain('演示文件.txt');
    expect(fs.existsSync(rowTxt.local_path)).toBe(true);
    expect(fs.readFileSync(rowTxt.local_path, 'utf8')).toBe('hello private file');
    expect(rowTxt.content).toBe(`[文件:演示文件.txt 已保存: ${rowTxt.local_path}]`);
    expect(capturedFollowups[0]!.content).toContain(`[文件:演示文件.txt 已保存: ${rowTxt.local_path}]`);
    expect(srv.requests[0]!.authorization).toBeUndefined();

    // 验证 .pdf 文件
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_PDF_1',
      content: '请查收报告',
      timestamp: '2026-11-11T12:10:05+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'file',
          filename: '季度报告.pdf',
          size: 13,
          url: `${srv.baseUrl}/files/report.pdf?rkey=mock_secret`,
        },
      ],
    });

    const rowPdf = await waitForDbRow('ROBOT1.0_PF_PDF_1');
    expect(rowPdf.type).toBe('file');
    expect(rowPdf.local_path).toContain('季度报告.pdf');
    expect(fs.readFileSync(rowPdf.local_path, 'utf8')).toBe('%PDF-1.7-mock');
    expect(rowPdf.content).toContain(`请查收报告 [文件:季度报告.pdf 已保存: ${rowPdf.local_path}]`);
  });

  it('PF-2: 实测特征 — .png 图片虽走 content_type="file"，按扩展名改判为 image 落盘并渲染 [图片:path]', async () => {
    const srv = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(PNG_BYTES);
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_PNG_AS_FILE',
      content: '',
      timestamp: '2026-11-11T12:11:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'file',
          filename: 'screenshot.png',
          size: PNG_BYTES.length,
          url: `${srv.baseUrl}/files/screenshot.png?rkey=mock_secret`,
        },
      ],
    });

    const row = await waitForDbRow('ROBOT1.0_PF_PNG_AS_FILE');
    const expectedFilesDir = path.resolve(tmpHome, 'kujira', 'downloads', 'image', MOCK_PEER);
    expect(row.type).toBe('image');
    expect(row.local_path).toBeTruthy();
    expect(path.resolve(row.local_path).startsWith(expectedFilesDir)).toBe(true);
    expect(String(row.local_path).endsWith('screenshot.png')).toBe(true);
    expect(Buffer.compare(fs.readFileSync(row.local_path), PNG_BYTES)).toBe(0);
    expect(row.content).toBe(`[图片:${row.local_path}]`);

    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts[0].kind).toBe('image');
    expect(parsedAtts[0].local?.format).toBe('png');
  });

  it('PF-3: 安全文件名净化防路径穿越 (../ 与 ..\\ 与纯点号命名均约束在 files/<peer>/ 内)', async () => {
    const srv = await startHttpServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(`payload:${req.url}`);
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    const expectedFilesDir = path.resolve(tmpHome, 'kujira', 'downloads', 'files', MOCK_PEER);

    // 1. POSIX ../ 穿越
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_TRAV_1',
      content: '',
      timestamp: '2026-11-11T12:12:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'file',
          filename: '../../etc/passwd.txt',
          size: 20,
          url: `${srv.baseUrl}/trav1?rkey=mock_secret`,
        },
      ],
    });

    const row1 = await waitForDbRow('ROBOT1.0_PF_TRAV_1');
    expect(row1.local_path).toBeTruthy();
    expect(path.dirname(path.resolve(row1.local_path))).toBe(expectedFilesDir);
    expect(path.basename(row1.local_path)).toBe('passwd.txt');
    expect(fs.existsSync(path.join(tmpHome, 'etc', 'passwd.txt'))).toBe(false);

    // 2. Windows ..\ 穿越 + 非法字符
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_TRAV_2',
      content: '',
      timestamp: '2026-11-11T12:12:05+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'file',
          filename: '..\\..\\Windows\\evil:name?.pdf',
          size: 20,
          url: `${srv.baseUrl}/trav2?rkey=mock_secret`,
        },
      ],
    });

    const row2 = await waitForDbRow('ROBOT1.0_PF_TRAV_2');
    expect(row2.local_path).toBeTruthy();
    expect(path.dirname(path.resolve(row2.local_path))).toBe(expectedFilesDir);
    expect(path.basename(row2.local_path)).toBe('evil_name_.pdf');

    // 3. 纯穿越字面量 ../../.. -> 净化后回退指纹命名，仍在 files/<peer>/ 内
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_TRAV_3',
      content: '',
      timestamp: '2026-11-11T12:12:10+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'file',
          filename: '../../../..',
          size: 20,
          url: `${srv.baseUrl}/trav3?rkey=mock_secret`,
        },
      ],
    });

    const row3 = await waitForDbRow('ROBOT1.0_PF_TRAV_3');
    expect(row3.local_path).toBeTruthy();
    expect(path.dirname(path.resolve(row3.local_path))).toBe(expectedFilesDir);
    expect(fs.existsSync(row3.local_path)).toBe(true);
  });

  it('PF-4: content_type="voice" 优先裸 GET 拉取 voice_wav_url（忽略 audio/mp3 错报头），落盘 .wav 并渲染 asr_refer_text', async () => {
    const srv = await startHttpServer((req, res) => {
      if (req.url?.includes('transcoded.wav')) {
        // 实测响应头会错报为 audio/mp3，程序必须按 content_type='voice' + 字节魔数落盘 .wav
        res.writeHead(200, { 'Content-Type': 'audio/mp3' });
        res.end(WAV_BYTES);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(AMR_BYTES);
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_VOICE_1',
      content: '',
      timestamp: '2026-11-11T12:13:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'voice',
          filename: 'voice_note.amr',
          size: WAV_BYTES.length,
          url: `${srv.baseUrl}/raw.amr?rkey=mock_secret`,
          voice_wav_url: `${srv.baseUrl}/transcoded.wav?rkey=mock_secret`,
          asr_refer_text: '今晚记得早点休息',
        },
      ],
    });

    const row = await waitForDbRow('ROBOT1.0_PF_VOICE_1');
    await waitUntil(() => capturedFollowups.length >= 1, 3000, 'voice followup');

    // 验证优先请求 voice_wav_url 且无 Authorization 头
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]!.url).toContain('transcoded.wav?rkey=mock_secret');
    expect(srv.requests[0]!.authorization).toBeUndefined();

    const expectedVoiceDir = path.resolve(tmpHome, 'kujira', 'downloads', 'voice', MOCK_PEER);
    expect(row.type).toBe('record');
    expect(row.local_path).toBeTruthy();
    expect(path.resolve(row.local_path).startsWith(expectedVoiceDir)).toBe(true);
    expect(String(row.local_path).endsWith('.wav')).toBe(true);
    expect(Buffer.compare(fs.readFileSync(row.local_path), WAV_BYTES)).toBe(0);

    expect(row.content).toBe(`[语音 已保存: ${row.local_path} (语音转文字: "今晚记得早点休息")]`);
    expect(capturedFollowups[0]!.content).toContain(row.local_path);
    expect(capturedFollowups[0]!.content).toContain('今晚记得早点休息');

    const parsedAtts = JSON.parse(row.attachments);
    expect(parsedAtts[0].kind).toBe('record');
    expect(parsedAtts[0].local?.format).toBe('wav');
    expect(parsedAtts[0].remote?.asrReferText).toBe('今晚记得早点休息');
  });

  it('PF-5: voice_wav_url 失败回退 url；双失败时 local_path = null、保留 asr_refer_text 并遵循选项 A 保留真实直链', async () => {
    const srv = await startHttpServer((req, res) => {
      if (req.url?.includes('wav-fail')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (req.url?.includes('amr-ok')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(AMR_BYTES);
        return;
      }
      res.writeHead(403);
      res.end('forbidden');
    });

    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    // 1. voice_wav_url 404 -> 回退 url
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_VOICE_FB',
      content: '',
      timestamp: '2026-11-11T12:14:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'voice',
          filename: 'fallback.amr',
          url: `${srv.baseUrl}/amr-ok.amr?rkey=mock_secret`,
          voice_wav_url: `${srv.baseUrl}/wav-fail.wav?rkey=mock_secret`,
          asr_refer_text: '语音回退识别',
        },
      ],
    });

    const rowFb = await waitForDbRow('ROBOT1.0_PF_VOICE_FB');
    expect(rowFb.type).toBe('record');
    expect(rowFb.local_path).toBeTruthy();
    expect(String(rowFb.local_path).endsWith('.amr')).toBe(true);
    expect(Buffer.compare(fs.readFileSync(rowFb.local_path), AMR_BYTES)).toBe(0);
    expect(rowFb.content).toContain('(语音转文字: "语音回退识别")');

    // 2. 双失败 -> local_path=null、保留转写文本、unavailable 保持脱敏、正文遵循选项 A 优先保留 voice_wav_url 直链
    const wavFailUrl = `${srv.baseUrl}/wav-fail.wav?rkey=mock_secret`;
    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_VOICE_DEAD',
      content: '',
      timestamp: '2026-11-11T12:14:10+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
      attachments: [
        {
          content_type: 'voice',
          filename: 'dead.amr',
          url: `${srv.baseUrl}/both-dead.amr?rkey=mock_secret`,
          voice_wav_url: wavFailUrl,
          asr_refer_text: '双失败保留转写',
        },
      ],
    });

    const rowDead = await waitForDbRow('ROBOT1.0_PF_VOICE_DEAD');
    expect(rowDead.type).toBe('record');
    expect(rowDead.local_path).toBeNull();
    expect(rowDead.content).toContain('(语音转文字: "双失败保留转写")');
    expect(rowDead.content).toContain('(下载失败:');
    expect(rowDead.content).toContain(`直链: ${wavFailUrl}`);
    expect(rowDead.content).not.toContain('链接已脱敏');

    const parsedAtts = JSON.parse(rowDead.attachments);
    expect(parsedAtts[0].unavailable).toBeTruthy();
    expect(String(parsedAtts[0].unavailable)).toContain('403');
    expect(String(parsedAtts[0].unavailable)).not.toContain('rkey');
    expect(String(parsedAtts[0].unavailable)).not.toContain('mock_secret');
  });

  it('PF-6: 完全为空的消息不落库不唤醒；纯空格消息保留入库与唤醒', async () => {
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;
    const before = capturedFollowups.length;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_EMPTY_1',
      content: '',
      timestamp: '2026-11-11T12:15:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
    });

    await new Promise((r) => setTimeout(r, 300));
    const db = new Database(dbPath(), { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM messages WHERE msg_id = ?').get('ROBOT1.0_PF_EMPTY_1')).toBeUndefined();
    } finally {
      db.close();
    }
    expect(capturedFollowups).toHaveLength(before);

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_PF_SPACE_1',
      content: '   ',
      timestamp: '2026-11-11T12:15:05+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户' },
      message_type: 0,
    });

    const spaceRow = await waitForDbRow('ROBOT1.0_PF_SPACE_1');
    await waitUntil(() => capturedFollowups.length > before, 3000, 'space wakeup');
    expect(spaceRow.content).toBe('   ');
    expect(capturedFollowups[capturedFollowups.length - 1]!.content).toContain('   ');
  });
});
