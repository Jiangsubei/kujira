/**
 * tests/contract/forward-image-materialize.test.ts
 *
 * 契约测试: 官方 message_type=102 合并转发全量媒体裸 GET 落盘、对话流重排与选项 A 直链兜底
 *
 * 覆盖核心契约：
 * - FC-1 契约 1: `=== 消息 N ===` 重排为精简编号对话流，已落盘后正文不附带冗长 URL，
 *              `entries[0].sanitizedUrl` 保留脱敏 URL，`logger.warn` 不打印 query 凭证；
 * - FC-1 契约 2: 多模态全量落盘（视频 `moov -> mvhd` 时长 + 分辨率/大小、语音、文件、去重）
 *              + `<faceType=6>` 表情识别与 `getFaceByMd5` 收藏命中 + `<faceType=4,ext=...>` 商城表情 `ext.text`
 *              + 全量落盘路径 `localPaths` 按出现顺序去重（图片/表情/视频/语音/文件均含）；
 * - FC-1 契约 3: 默认取消 10 个数量与大小上限（12 个全量落盘）；显式传 `{ limit: 2 }` 时超出部分保留选项 A `直链: ...`；
 * - FC-1 契约 4: 单附件 HTTP 403/404 失败不阻断其余附件下载，正文保留 `(下载失败: ...)` 与真实 `直链: <rawUrl>`，日志保持脱敏；
 * - FC-1 契约 5: 与 `shouldWakeup` 真实联动，转发含视频 + 图片时 `payload.content` 为清晰对话流，`payload` 不含任何视觉载荷。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { computeBufferMd5, MediaStorageManager } from '../../src/storage/media.js';
import {
  resolveEmbeddedForwardImages,
  resolveEmbeddedForwardMedia,
} from '../../src/gateway/inbound-media.js';
import { shouldWakeup } from '../../src/gateway/wakeup.js';
import type { FaceRecord, QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0006';
const PEER = openidToPeer(MOCK_OPENID);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0x11),
]);
const FAV_PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0x55),
]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 0x22)]);
const GIF_PHOTO_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 0x33)]);
const WAV_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(24, 0x44),
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n%mock-forward-file\n');

function makeMp4WithDuration(timescale: number, duration: number): Buffer {
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('isom', 16, 'ascii');

  const mvhdPayloadLen = 100;
  const mvhd = Buffer.alloc(8 + mvhdPayloadLen);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write('mvhd', 4, 'ascii');
  mvhd.writeUInt8(0, 8); // version 0
  mvhd.writeUInt32BE(timescale, 8 + 12);
  mvhd.writeUInt32BE(duration, 8 + 16);

  const moov = Buffer.alloc(8 + mvhd.length);
  moov.writeUInt32BE(moov.length, 0);
  moov.write('moov', 4, 'ascii');
  mvhd.copy(moov, 8);

  return Buffer.concat([ftyp, moov]);
}

describe('契约测试: message_type=102 合并转发全量媒体裸 GET 落盘与对话流重排', () => {
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

  it('FC-1 契约 1: 重排 === 消息 N === 为编号对话流，已落盘正文不附带冗长 URL 且 logs/sanitizedUrl 脱敏', async () => {
    const requestedUrls: string[] = [];
    const seenAuthHeaders: Array<string | undefined> = [];
    const warnLogs: string[] = [];
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

    expect(resolveEmbeddedForwardImages).toBe(resolveEmbeddedForwardMedia);
    const res = await resolveEmbeddedForwardMedia(forwardText, PEER, manager, {
      logger: {
        warn: (...args: any[]) => warnLogs.push(args.map(String).join(' ')),
      },
    });

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('rkey=SECRET_RKEY_001');
    expect(seenAuthHeaders[0]).toBeUndefined();

    expect(res.localPaths).toHaveLength(1);
    const localPath = res.localPaths[0]!;
    expect(fs.existsSync(localPath)).toBe(true);
    expect(localPath.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);

    expect(res.replacements.get(imgUrl)).toBe(`[图片:${localPath}]`);
    expect(res.formattedContent).toBe(
      ['[群聊的聊天记录]', '1. 群友A: 大家看看这张截图', `2. 群友B: [图片:${localPath}]`].join('\n')
    );
    expect(res.sanitizedContent).toBe(res.formattedContent);
    expect(res.formattedContent).not.toContain('=== 消息');
    expect(res.formattedContent).not.toContain('[发送者]');
    expect(res.formattedContent).not.toContain('[消息内容]');
    expect(res.formattedContent).not.toContain('[附件1]');
    expect(res.formattedContent).not.toContain('SECRET_RKEY_001');
    expect(res.formattedContent).not.toContain('URL:');
    expect(res.formattedContent).not.toContain('http://');
    expect(res.entries[0]!.sanitizedUrl).toBe(`${base}/download`);
    expect(res.entries[0]!.sanitizedUrl).not.toContain('SECRET_RKEY_001');
    expect(warnLogs.join('\n')).not.toContain('SECRET_RKEY_001');
  });

  it('FC-1 契约 2: 多模态全量落盘（视频元信息/语音/文件/URL去重）与表情识别', async () => {
    const mp4Bytes = makeMp4WithDuration(1000, 8776);
    const favMd5 = computeBufferMd5(FAV_PNG_BYTES);
    const requestedUrls: string[] = [];

    const base = await startServer((req, res) => {
      requestedUrls.push(req.url || '');
      if (req.url?.includes('kind=video')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(mp4Bytes);
        return;
      }
      if (req.url?.includes('kind=voice')) {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(WAV_BYTES);
        return;
      }
      if (req.url?.includes('kind=file')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(PDF_BYTES);
        return;
      }
      if (req.url?.includes('kind=sticker')) {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(GIF_BYTES);
        return;
      }
      if (req.url?.includes('kind=favsticker')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(FAV_PNG_BYTES);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(GIF_PHOTO_BYTES);
    });

    const videoUrl = `${base}/download?kind=video&rkey=RKEY_VIDEO`;
    const voiceUrl = `${base}/download?kind=voice&rkey=RKEY_VOICE`;
    const fileUrl = `${base}/download?kind=file&rkey=RKEY_FILE`;
    const stickerUrl = `${base}/download?kind=sticker&rkey=RKEY_STICKER`;
    const favStickerUrl = `${base}/download?kind=favsticker&rkey=RKEY_FAV`;
    const photoUrl = `${base}/download?kind=photo&rkey=RKEY_PHOTO`;

    const mockFace: FaceRecord = {
      id: 'face_mock_fav_01',
      md5: favMd5,
      local_path: '/mock/faces/fav.png',
      mood: '嘲讽',
      tags: ['坏笑'],
      use_count: 1,
      enabled: 1,
      created_at: 1000,
    };

    const content = [
      '=== 消息 1 ===',
      '[发送者] 肥鱼酱',
      `[附件1] 类型:视频 文件名:demo.mp4 尺寸:720x1280 大小:829.6KB URL:${videoUrl}`,
      '=== 消息 2 ===',
      '[发送者] 阿狸',
      `[附件1] 类型:语音 文件名:voice_01.wav URL:${voiceUrl}`,
      '=== 消息 3 ===',
      '[发送者] 小明',
      `[附件1] 类型:文件 文件名:spec.pdf 大小:12.4KB URL:${fileUrl}`,
      '=== 消息 4 ===',
      '[发送者] 表情党',
      '[消息内容] <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      `[附件1] 类型:图片 文件名:emoji.gif 尺寸:240x240 大小:120KB URL:${stickerUrl}`,
      '=== 消息 5 ===',
      '[发送者] 收藏家',
      '[消息内容] <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      `[附件1] 类型:表情 文件名:fav.png 尺寸:240x240 大小:64KB URL:${favStickerUrl}`,
      '=== 消息 6 ===',
      '[发送者] 路人',
      '[消息内容] <faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ==">',
      '=== 消息 7 ===',
      '[发送者] 摄影师',
      `[附件1] 类型:动图 文件名:anim.gif 尺寸:240x240 大小:1.3MB URL:${photoUrl}`,
      '=== 消息 8 ===',
      '[发送者] 复读机',
      `[附件1] 类型:动图 文件名:anim.gif 尺寸:240x240 大小:1.3MB URL:${photoUrl}`,
    ].join('\n');

    const res = await resolveEmbeddedForwardMedia(content, PEER, manager, {
      getFaceByMd5: (md5) => (md5 === favMd5 ? mockFace : null),
    });

    // 同 URL 不重复下载，6 个唯一媒体全部下载落盘（消息 6 无附件共 7 个附件条目）
    expect(requestedUrls).toHaveLength(6);
    expect(res.entries).toHaveLength(7);
    expect(res.localPaths).toHaveLength(6);

    const videoEntry = res.entries.find((e) => e.mediaType === 'video')!;
    const voiceEntry = res.entries.find((e) => e.mediaType === 'voice')!;
    const fileEntry = res.entries.find((e) => e.mediaType === 'files')!;
    const stickerEntry = res.entries[3]!;
    const favEntry = res.entries[4]!;
    const photoEntry = res.entries[5]!;

    expect(videoEntry.localPath!.startsWith(path.join(tmpHome, 'downloads', 'video', PEER))).toBe(true);
    expect(videoEntry.durationSec).toBeCloseTo(8.776, 3);
    expect(voiceEntry.localPath!.startsWith(path.join(tmpHome, 'downloads', 'voice', PEER))).toBe(true);
    expect(fileEntry.localPath!.startsWith(path.join(tmpHome, 'downloads', 'files', PEER))).toBe(true);
    expect(stickerEntry.localPath!.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);
    expect(favEntry.localPath!.startsWith(path.join(tmpHome, 'downloads', 'sticker', PEER))).toBe(true);
    expect(photoEntry.localPath!.startsWith(path.join(tmpHome, 'downloads', 'image', PEER))).toBe(true);

    // 全量落盘路径按出现顺序去重，包含视频/语音/文件
    expect(res.localPaths).toEqual([
      videoEntry.localPath!,
      voiceEntry.localPath!,
      fileEntry.localPath!,
      stickerEntry.localPath!,
      favEntry.localPath!,
      photoEntry.localPath!,
    ]);

    expect(res.formattedContent).toBe(
      [
        `1. 肥鱼酱: [视频:demo.mp4 (720x1280, 829.6KB, 8.8s) 已保存: ${videoEntry.localPath!}]`,
        `2. 阿狸: [语音:voice_01.wav 已保存: ${voiceEntry.localPath!}]`,
        `3. 小明: [文件:spec.pdf 已保存: ${fileEntry.localPath!}]`,
        `4. 表情党: [表情包:${stickerEntry.localPath!}]`,
        `5. 收藏家: [表情包: face_mock_fav_01 (情绪: 嘲讽) 路径: ${favEntry.localPath!}]`,
        '6. 路人: [表情: 内有坏猫]',
        `7. 摄影师: [图片:${photoEntry.localPath!}]`,
        `8. 复读机: [图片:${photoEntry.localPath!}]`,
      ].join('\n')
    );
    expect(res.formattedContent).not.toContain('RKEY_');
    expect(res.formattedContent).not.toContain('<faceType');
  });

  it('FC-1 契约 3: 默认取消 10 个数量与大小上限（12 个全量落盘）；显式传 limit 时超出部分保留选项 A 直链', async () => {
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

    // 1. 默认无 limit：12 个内嵌附件全部完成裸 GET 落盘
    const res = await resolveEmbeddedForwardMedia(lines, PEER, manager);

    expect(downloadCalls).toBe(12);
    expect(res.entries).toHaveLength(12);
    expect(res.entries.filter((e) => e.downloaded)).toHaveLength(12);
    expect(res.localPaths).toHaveLength(12);
    expect(res.formattedContent).not.toContain('LIMIT_RKEY_');
    expect(res.formattedContent).not.toContain('链接已脱敏');

    // 2. 显式传 { limit: 2 }：仅下载前 2 个，超出部分保留选项 A 直链（绝不出现链接已脱敏）
    downloadCalls = 0;
    const limitedRes = await resolveEmbeddedForwardMedia(lines, PEER, manager, { limit: 2 });

    expect(downloadCalls).toBe(2);
    expect(limitedRes.entries).toHaveLength(12);
    expect(limitedRes.entries.filter((e) => e.downloaded)).toHaveLength(2);
    expect(limitedRes.entries.filter((e) => !e.downloaded)).toHaveLength(10);
    expect(limitedRes.formattedContent).toContain(`[图片:${limitedRes.localPaths[0]!}]`);
    expect(limitedRes.formattedContent).toContain(`[图片:${limitedRes.localPaths[1]!}]`);
    expect(limitedRes.formattedContent).toContain(
      `[图片:p_2.png 直链: ${base}/download?i=2&rkey=LIMIT_RKEY_2]`
    );
    expect(limitedRes.formattedContent).toContain(
      `[图片:p_11.png 直链: ${base}/download?i=11&rkey=LIMIT_RKEY_11]`
    );
    expect(limitedRes.formattedContent).not.toContain('[图片(链接已脱敏)]');
    expect(limitedRes.formattedContent).not.toContain('链接已脱敏');
  });

  it('FC-1 契约 4: 单附件 HTTP 403 失败不阻断其余附件下载，正文保留选项 A 真实直链，logger.warn 仍脱敏', async () => {
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
      '=== 消息 1 ===',
      '[发送者] 群友A',
      `[附件1] 类型:图片 文件名:bad.png URL:${badUrl}`,
      '=== 消息 2 ===',
      '[发送者] 群友B',
      `[附件1] 类型:图片 文件名:ok.png URL:${okUrl}`,
    ].join('\n');

    const res = await resolveEmbeddedForwardMedia(content, PEER, manager, {
      logger: {
        warn: (...args: any[]) => warnLogs.push(args.map(String).join(' ')),
      },
    });

    expect(res.localPaths).toHaveLength(1);
    expect(res.entries[0]!.downloaded).toBe(false);
    expect(res.entries[0]!.error).toBeTruthy();
    expect(res.entries[0]!.error).toContain('403');
    expect(res.entries[0]!.error).not.toContain('LEAK_CHECK_BAD');
    expect(res.entries[0]!.error).not.toContain('rkey=');
    expect(res.entries[1]!.downloaded).toBe(true);

    expect(res.formattedContent).toContain('1. 群友A: [图片:bad.png (下载失败:');
    expect(res.formattedContent).toContain(`直链: ${badUrl}]`);
    expect(res.formattedContent).toContain(`2. 群友B: [图片:${res.localPaths[0]!}]`);
    expect(res.formattedContent).not.toContain('LEAK_CHECK_OK');
    expect(res.formattedContent).not.toContain('链接已脱敏');

    expect(warnLogs.length).toBeGreaterThan(0);
    expect(warnLogs.join('\n')).toContain(`${base}/download`);
    expect(warnLogs.join('\n')).not.toContain('LEAK_CHECK_BAD');
    expect(warnLogs.join('\n')).not.toContain('rkey=');
  });

  it('FC-1 契约 5: 与 shouldWakeup 联动 — 视频 + 图片并发落盘时 payload.images 仅含图片且 content 为清晰对话流', async () => {
    const mp4Bytes = makeMp4WithDuration(1000, 8776);
    const base = await startServer((req, res) => {
      if (req.url?.includes('kind=video')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(mp4Bytes);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const videoUrl = `${base}/download?kind=video&rkey=WAKEUP_FWD_VIDEO_SECRET`;
    const imgUrl = `${base}/download?kind=image&appid=1406&rkey=WAKEUP_FWD_SECRET`;
    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_fwd_wakeup_001',
      content: [
        '[群聊的聊天记录]',
        '=== 消息 1 ===',
        '[发送者] 肥鱼酱',
        `[附件1] 类型:视频 文件名:clip.mp4 尺寸:720x1280 大小:829.6KB URL:${videoUrl}`,
        '=== 消息 2 ===',
        '[发送者] 群友B',
        '[消息内容] 顺便发张图',
        `[附件1] 类型:图片 文件名:img.png URL:${imgUrl}`,
      ].join('\n'),
      timestamp: '2026-11-11T18:45:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 102,
    };

    const embedded = await resolveEmbeddedForwardMedia(event.content, PEER, manager);
    const decision = await shouldWakeup(event, {
      formatForwardContent: () => embedded.formattedContent,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
    expect(embedded.localPaths).toHaveLength(2);
    expect('images' in decision.payload!).toBe(false);
    expect(embedded.localPaths.every((p) => fs.existsSync(p))).toBe(true);

    const videoEntry = embedded.entries.find((e) => e.mediaType === 'video')!;
    const imageEntry = embedded.entries.find((e) => e.mediaType === 'image')!;
    expect(decision.payload?.content).toBe(
      [
        '[群聊的聊天记录]',
        `1. 肥鱼酱: [视频:clip.mp4 (720x1280, 829.6KB, 8.8s) 已保存: ${videoEntry.localPath!}]`,
        `2. 群友B: 顺便发张图 [图片:${imageEntry.localPath!}]`,
      ].join('\n')
    );
    expect(decision.payload?.content).not.toContain('WAKEUP_FWD_SECRET');
    expect(decision.payload?.content).not.toContain('WAKEUP_FWD_VIDEO_SECRET');
    expect(decision.payload?.content).not.toContain('=== 消息');
  });
});
