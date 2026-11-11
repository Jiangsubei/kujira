/**
 * tests/contract/forward-image-materialize.test.ts
 *
 * 契约测试: 官方 message_type=102 合并转发内嵌图片裸 GET 落盘与凭证 URL 脱敏替换
 *
 * 背景（实测报告 #5 §4）：
 *   QQ 官方 Bot API v2 下发合并转发 (`message_type: 102`) 时，服务端已直接把聊天记录展开至
 *   `d.content` 纯文本，其中内嵌图片以 `[附件k] 类型:图片 ... URL:https://...&rkey=...` 形式出现。
 *   入站处理必须限量直接裸 GET 落盘（不传 Authorization 头），并将含 `rkey` 的明文 URL 从正文
 *   替换为 `[图片:<local_path>]` 或 `[图片(链接已脱敏)]`，杜绝凭据注入模型上下文或日志。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import {
  resolveEmbeddedForwardImages,
  sanitizeForwardContentUrls,
} from '../../src/gateway/inbound-media.js';
import { shouldWakeup } from '../../src/gateway/wakeup.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0006';
const PEER = openidToPeer(MOCK_OPENID);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0x11),
]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 0x22)]);

describe('契约测试: message_type=102 合并转发内嵌图片裸 GET 落盘与脱敏', () => {
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
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-forward-materialize-'));
    manager = new MediaStorageManager({ dshHome: tmpHome, downloadDir: 'downloads' });
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    }
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('FC-1 契约 1: 提取 [附件k] ... URL:https://... 裸 GET 落盘（不带 Authorization 头）并脱敏正文', async () => {
    const requestedUrls: string[] = [];
    const seenAuthHeaders: Array<string | undefined> = [];
    const base = await startServer((req, res) => {
      requestedUrls.push(req.url || '');
      seenAuthHeaders.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const imgUrl = `${base}/download?appid=1406&fileid=FILE_A&rkey=SECRET_RKEY_001&spec=0`;
    const forwardText = [
      '[群聊的聊天记录]',
      '=== 消息 1 ===',
      '[消息内容] 大家看看这张截图',
      '[发送者] 群友A',
      '',
      '=== 消息 2 ===',
      '[发送者] 群友B',
      `[附件1] 类型:图片 文件名:shot.png 尺寸:1440x1920 大小:360.8KB URL:${imgUrl}`,
    ].join('\n');

    const res = await resolveEmbeddedForwardImages(forwardText, PEER, manager);

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('rkey=SECRET_RKEY_001');
    expect(seenAuthHeaders[0]).toBeUndefined();

    expect(res.localPaths).toHaveLength(1);
    const localPath = res.localPaths[0]!;
    expect(fs.existsSync(localPath)).toBe(true);
    expect(localPath.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);

    expect(res.replacements.get(imgUrl)).toBe(`[图片:${localPath}]`);
    expect(res.sanitizedContent).toContain(`[图片:${localPath}]`);
    expect(res.sanitizedContent).not.toContain('SECRET_RKEY_001');
    expect(res.sanitizedContent).not.toContain('URL:');
    expect(res.entries[0]!.sanitizedUrl).toBe(`${base}/download`);
    expect(JSON.stringify(res.entries)).not.toContain('SECRET_RKEY_001');
  });

  it('FC-1 契约 2: 动图/表情附件按 sticker 或 image 落盘并保留其余文本与多张顺序', async () => {
    const base = await startServer((req, res) => {
      if (req.url?.includes('sticker')) {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(GIF_BYTES);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const stickerUrl = `${base}/download?kind=sticker&rkey=RKEY_STICKER`;
    const photoUrl = `${base}/download?kind=photo&rkey=RKEY_PHOTO`;

    const content = [
      '=== 消息 1 ===',
      '[消息内容] <faceType=6,faceId="0",ext="abc">',
      `[附件1] 类型:表情 文件名:emoji.gif 尺寸:240x240 大小:120KB URL:${stickerUrl}`,
      '=== 消息 2 ===',
      `[附件1] 类型:动图 文件名:anim.gif 尺寸:240x240 大小:1.3MB URL:${photoUrl}`,
    ].join('\n');

    const res = await resolveEmbeddedForwardImages(content, PEER, manager);

    expect(res.localPaths).toHaveLength(2);
    expect(res.localPaths[0]!.startsWith(path.join(tmpHome, 'downloads', 'sticker', PEER))).toBe(true);
    expect(res.localPaths[1]!.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);
    expect(res.sanitizedContent).not.toContain('RKEY_STICKER');
    expect(res.sanitizedContent).not.toContain('RKEY_PHOTO');
  });

  it('FC-1 契约 3: 限量下载（默认上限 10；支持自定义 limit），超出上限仍强制脱敏 URL', async () => {
    let downloadCalls = 0;
    const base = await startServer((_req, res) => {
      downloadCalls++;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const lines = Array.from({ length: 12 }, (_v, i) => {
      const u = `${base}/download?i=${i}&rkey=LIMIT_RKEY_${i}`;
      return `[附件${i + 1}] 类型:图片 文件名:p_${i}.png URL:${u}`;
    }).join('\n');

    const res = await resolveEmbeddedForwardImages(lines, PEER, manager);

    expect(downloadCalls).toBe(10);
    expect(res.entries).toHaveLength(12);
    expect(res.entries.filter((e) => e.downloaded)).toHaveLength(10);
    expect(res.entries.filter((e) => !e.downloaded)).toHaveLength(2);
    expect(res.sanitizedContent).toContain('[图片(链接已脱敏)]');
    expect(res.sanitizedContent).not.toContain('LIMIT_RKEY_');
  });

  it('FC-1 契约 4: 单张下载失败不阻断其余图片落盘，且错误与日志绝不泄露 rkey', async () => {
    const base = await startServer((req, res) => {
      if (req.url?.includes('bad=1')) {
        res.writeHead(403);
        res.end('expired');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const badUrl = `${base}/download?bad=1&rkey=LEAK_CHECK_BAD`;
    const okUrl = `${base}/download?ok=1&rkey=LEAK_CHECK_OK`;
    const warnLogs: string[] = [];

    const content = [
      `[附件1] 类型:图片 文件名:bad.png URL:${badUrl}`,
      `[附件2] 类型:图片 文件名:ok.png URL:${okUrl}`,
    ].join('\n');

    const res = await resolveEmbeddedForwardImages(content, PEER, manager, 10, {
      warn: (...args: any[]) => warnLogs.push(args.map(String).join(' ')),
    });

    expect(res.localPaths).toHaveLength(1);
    expect(res.sanitizedContent).toContain('[图片(链接已脱敏)]');
    expect(res.sanitizedContent).toContain(`[图片:${res.localPaths[0]!}]`);
    expect(res.sanitizedContent).not.toContain('LEAK_CHECK_');
    expect(res.entries[0]!.error).toBeTruthy();
    expect(res.entries[0]!.error).not.toContain('LEAK_CHECK_BAD');
    expect(warnLogs.join('\n')).not.toContain('LEAK_CHECK_BAD');
  });

  it('FC-1 契约 5: 与 shouldWakeup 联动 — message_type=102 合并转发完整落盘并注入 payload.images', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const imgUrl = `${base}/download?appid=1406&rkey=WAKEUP_FWD_SECRET`;
    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_fwd_wakeup_001',
      content: `[群聊的聊天记录]\n=== 消息 1 ===\n[附件1] 类型:图片 文件名:img.png URL:${imgUrl}`,
      timestamp: '2026-11-11T18:45:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 102,
    };

    const embedded = await resolveEmbeddedForwardImages(event.content, PEER, manager);
    const decision = await shouldWakeup(event, {
      forwardImages: embedded.localPaths,
      sanitizeForwardContent: (raw) => sanitizeForwardContentUrls(raw, embedded.replacements),
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
    expect(decision.payload?.images).toEqual(embedded.localPaths);
    expect(decision.payload?.content).toContain(`[图片:${embedded.localPaths[0]!}]`);
    expect(decision.payload?.content).not.toContain('WAKEUP_FWD_SECRET');
  });
});
