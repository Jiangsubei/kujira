/**
 * tests/contract/inbound-image-resolve.test.ts
 *
 * 契约测试: QQ 官方 Bot 入站附件裸 GET 下载、语音 WAV 优先、文件安全净化与凭证脱敏
 *
 * 覆盖实测契约：
 * 1. 所有入站 `attachments[]` 均直接裸 GET（不附带 Authorization 头）；
 * 2. 图片下载后按字节魔数纠正扩展名落盘至 `downloads/image/<peer>/`；
 * 3. `content_type === 'voice'` 忽略响应头错报 `audio/mp3`，优先拉取 `voice_wav_url`（`ext: 'wav'`），
 *    无 WAV 地址或失败时回退 `url`，且始终保留 `asr_refer_text`；
 * 4. `content_type === 'file'` 对 `.png` 保留真实扩展名与魔数格式，并对外部 `filename` 做 `path.basename` + 危险字符净化防路径穿越；
 * 5. 下载报错与日志彻底剥离 URL query 凭证（不含 `rkey`）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import {
  resolveInboundAttachments,
  sanitizeErrorMessage,
  sanitizeInboundFilename,
  sanitizeUrlForLog,
} from '../../src/gateway/inbound-media.js';
import { openidToPeer } from '../../src/utils/peer.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0003';
const PEER = openidToPeer(MOCK_OPENID);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(48, 7),
]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 1)]);
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(32, 0),
]);
const AMR_BYTES = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(16, 2)]);

function makeEvent(attachments: QQC2CMessageCreateEvent['attachments']): QQC2CMessageCreateEvent {
  return {
    id: 'ROBOT1.0_media_001',
    content: '',
    timestamp: '2026-11-11T18:28:47+08:00',
    author: { user_openid: MOCK_OPENID, username: '' },
    message_type: 0,
    attachments,
  };
}

describe('契约测试: 入站媒体裸 GET 下载与安全脱敏 (Inbound Media Resolve)', () => {
  let tmpHome: string;
  let manager: MediaStorageManager;
  let servers: http.Server[] = [];

  async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(handler);
      srv.on('error', reject);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-inbound-media-'));
    manager = new MediaStorageManager({ dshHome: tmpHome, downloadDir: 'downloads' });
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    }
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: image/* 裸 GET（绝不带 Authorization 头）并按魔数纠偏扩展名落盘', async () => {
    let seenAuthHeader: string | undefined;
    const base = await startServer((req, res) => {
      seenAuthHeader = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(GIF_BYTES);
    });

    const event = makeEvent([
      {
        content_type: 'image/jpeg',
        filename: 'FAKE_HASH.jpg',
        size: GIF_BYTES.length,
        url: `${base}/download?appid=1406&rkey=SECRET_IMG_KEY`,
      },
    ]);

    const result = await resolveInboundAttachments(event, PEER, manager);
    expect(seenAuthHeader).toBeUndefined();
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('image');
    expect(result[0]!.local?.format).toBe('gif');
    expect(result[0]!.local?.path.endsWith('.gif')).toBe(true);
    expect(result[0]!.local?.path.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);
    expect(Buffer.compare(fs.readFileSync(result[0]!.local!.path), GIF_BYTES)).toBe(0);
  });

  it('契约 2: 语音忽略响应头错报 audio/mp3，优先拉取 voice_wav_url (.wav) 并保留 asr_refer_text', async () => {
    let amrCalled = 0;
    let wavCalled = 0;
    const base = await startServer((req, res) => {
      if (req.url?.startsWith('/wav')) {
        wavCalled++;
        // 故意错报 audio/mp3 以验证不信任响应头
        res.writeHead(200, { 'Content-Type': 'audio/mp3' });
        res.end(WAV_BYTES);
        return;
      }
      amrCalled++;
      res.writeHead(200, { 'Content-Type': 'audio/mp3' });
      res.end(AMR_BYTES);
    });

    const event = makeEvent([
      {
        content_type: 'voice',
        filename: 'A1B2C3D4.amr',
        url: `${base}/amr?rkey=AMR_SECRET`,
        voice_wav_url: `${base}/wav?sig=WAV_SECRET`,
        asr_refer_text: '你好，这是一条语音消息',
      },
    ]);

    const result = await resolveInboundAttachments(event, PEER, manager);
    expect(wavCalled).toBe(1);
    expect(amrCalled).toBe(0);
    expect(result[0]!.kind).toBe('record');
    expect(result[0]!.local?.path.endsWith('.wav')).toBe(true);
    expect(result[0]!.local?.format).toBe('wav');
    expect(result[0]!.local?.path.startsWith(path.join(tmpHome, 'downloads', 'voice', PEER))).toBe(true);
    expect(result[0]!.remote?.asrReferText).toBe('你好，这是一条语音消息');
    expect(Buffer.compare(fs.readFileSync(result[0]!.local!.path), WAV_BYTES)).toBe(0);
  });

  it('契约 3: voice_wav_url 缺失或失败时回退拉取原始 url，仍保留 asr_refer_text', async () => {
    const base = await startServer((req, res) => {
      if (req.url?.startsWith('/wav')) {
        res.writeHead(502);
        res.end('bad gateway');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mp3' });
      res.end(AMR_BYTES);
    });

    const event = makeEvent([
      {
        content_type: 'voice',
        filename: 'fallback.amr',
        url: `${base}/amr?rkey=AMR_SECRET`,
        voice_wav_url: `${base}/wav?sig=WAV_FAIL_SECRET`,
        asr_refer_text: '回退测试',
      },
    ]);

    const warnLogs: string[] = [];
    const result = await resolveInboundAttachments(event, PEER, manager, {
      warn: (...args: any[]) => warnLogs.push(args.map(String).join(' ')),
    });

    expect(result[0]!.local?.path.endsWith('.amr')).toBe(true);
    expect(result[0]!.remote?.asrReferText).toBe('回退测试');
    expect(Buffer.compare(fs.readFileSync(result[0]!.local!.path), AMR_BYTES)).toBe(0);
    // 日志严禁包含 query 凭证
    expect(warnLogs.join('\n')).not.toContain('WAV_FAIL_SECRET');
  });

  it('契约 4: content_type=file 的 .png 按扩展名改判 image，保留扩展名与魔数，并净化 filename 路径穿越', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(PNG_BYTES);
    });

    const event = makeEvent([
      {
        content_type: 'file',
        filename: '../../../../../etc/..\\..\\real_image.png',
        size: PNG_BYTES.length,
        url: `${base}/file?rkey=FILE_SECRET`,
      },
    ]);

    const result = await resolveInboundAttachments(event, PEER, manager);
    const targetDir = path.join(tmpHome, 'downloads', 'image', PEER);

    expect(result[0]!.kind).toBe('image');
    expect(result[0]!.fileName).toBe('real_image.png');
    expect(result[0]!.local?.format).toBe('png');
    expect(result[0]!.local?.path.startsWith(targetDir)).toBe(true);
    expect(result[0]!.local?.path.endsWith('real_image.png')).toBe(true);
    expect(sanitizeInboundFilename('..')).toBeUndefined();
    expect(sanitizeInboundFilename('../../a:b*c?.pdf')).toBe('a_b_c_.pdf');
  });

  it('契约 5: 下载失败时的错误信息与 logger 必须彻底剥离 URL query 凭证', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(403);
      res.end('expired');
    });

    const secretUrl = `${base}/download?appid=1406&rkey=SUPER_SECRET_RKEY_XYZ&spec=0`;
    const warnLogs: string[] = [];
    const result = await resolveInboundAttachments(
      makeEvent([
        {
          content_type: 'image/png',
          filename: 'expired.png',
          url: secretUrl,
        },
      ]),
      PEER,
      manager,
      {
        warn: (...args: any[]) => warnLogs.push(args.map(String).join(' ')),
      }
    );

    expect(result[0]!.local).toBeUndefined();
    expect(result[0]!.unavailable).toBeTruthy();
    expect(result[0]!.unavailable).not.toContain('SUPER_SECRET_RKEY_XYZ');
    expect(result[0]!.unavailable).not.toContain('appid=1406');
    expect(warnLogs.join('\n')).not.toContain('SUPER_SECRET_RKEY_XYZ');

    expect(sanitizeUrlForLog(secretUrl)).toBe(`${base}/download`);
    expect(
      sanitizeErrorMessage(new Error(`HTTP 403 at ${secretUrl}`))
    ).not.toContain('SUPER_SECRET_RKEY_XYZ');
  });
});
