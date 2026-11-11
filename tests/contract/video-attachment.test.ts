/**
 * tests/contract/video-attachment.test.ts
 *
 * 契约测试: QQ 官方 Bot 单聊视频附件分类、裸 GET 落盘与语义化渲染契约
 *
 * 核心契约（仅依赖 Batch 1 与 Batch 2 模块）：
 * 1. `renderAttachment` 对 `video` 支持 `local.path`、`local.dimensions`/`size`/`durationSec`、`remote.fileUuid`、`fileName`、`unavailable` 语义化渲染，遵循选项 A（已落盘不拼 URL；未落盘/失败有 URL 时保留 `直链:`）；
 * 2. `describeInboundAttachments` 对 `content_type: 'video/mp4'` 及空 `content_type` + `.mp4` 判定 `kind: 'video'` 与主导类型 `'video'`；
 * 3. `resolveInboundAttachments` 对视频执行裸 GET 落盘至 `downloads/video/<peer>/` 并解析 MP4 `moov -> mvhd` 时长与分辨率；
 * 4. `parseNormalizedContent` 与 `shouldWakeup` 在落盘成功/失败时输出准确占位文案。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import { describeInboundAttachments } from '../../src/attachment/classify.js';
import { formatAttachmentByteSize, renderAttachment } from '../../src/attachment/render.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import { resolveInboundAttachments } from '../../src/gateway/inbound-media.js';
import { parseNormalizedContent, shouldWakeup } from '../../src/gateway/wakeup.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0005';
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(32, 0xaa),
]);

function buildSampleMp4WithMvhd(durationSec: number, mdatPayloadBytes = 1024): Buffer {
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('mp41', 16, 'ascii');

  const mdat = Buffer.alloc(8 + mdatPayloadBytes, 0xaa);
  mdat.writeUInt32BE(8 + mdatPayloadBytes, 0);
  mdat.write('mdat', 4, 'ascii');

  const timescale = 1000;
  const durationUnits = Math.round(durationSec * timescale);
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write('mvhd', 4, 'ascii');
  mvhd.writeUInt8(0, 8);
  mvhd.writeUInt32BE(timescale, 20);
  mvhd.writeUInt32BE(durationUnits, 24);
  mvhd.writeUInt32BE(0x00010000, 28);
  mvhd.writeUInt16BE(0x0100, 32);

  const moov = Buffer.alloc(8 + mvhd.length);
  moov.writeUInt32BE(8 + mvhd.length, 0);
  moov.write('moov', 4, 'ascii');
  mvhd.copy(moov, 8);

  return Buffer.concat([ftyp, mdat, moov]);
}

describe('契约 1: 视频附件描述符语义化渲染 (renderAttachment)', () => {
  it('无任何元数据时保持兜底 [视频]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
    };
    expect(renderAttachment(desc)).toBe('[视频]');
  });

  it('未落盘但有 fileUuid、独立文件名与 remote.url 时遵循选项 A 输出直链', () => {
    const videoUrl = 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET_VIDEO_RKEY';
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: '精彩集锦.mp4',
      remote: {
        fileUuid: 'video-uuid-001',
        url: videoUrl,
      },
    };
    const rendered = renderAttachment(desc);
    expect(rendered).toBe(`[视频:精彩集锦.mp4 (ID:video-uuid-001) 直链: ${videoUrl}]`);
    expect(rendered).toContain(`直链: ${videoUrl}`);
    expect(rendered).not.toContain('(链接已脱敏)');
  });

  it('若文件名与 fileUuid 一致则不产生冗余冒号前缀', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: 'clip.mp4',
      remote: { fileUuid: 'clip.mp4' },
    };
    expect(renderAttachment(desc)).toBe('[视频 (ID:clip.mp4)]');
  });

  it('已落盘时呈现 [视频 已保存: <local_path>] 或带文件名与元信息格式，且不拼接 remote.url', () => {
    const bare: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      local: { path: 'C:\\data\\downloads\\video\\user_1\\clip.mp4', format: 'mp4' },
      remote: { url: 'https://multimedia.nt.qq.com.cn/download?rkey=SHOULD_NOT_SHOW' },
    };
    expect(renderAttachment(bare)).toBe(
      '[视频 已保存: C:\\data\\downloads\\video\\user_1\\clip.mp4]'
    );

    const named: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: '实况录屏.mp4',
      local: {
        path: 'C:\\data\\downloads\\video\\user_1\\live.mp4',
        format: 'mp4',
        dimensions: '720x1280',
        size: 849510,
        durationSec: 8.776,
      },
    };
    expect(renderAttachment(named)).toBe(
      '[视频:实况录屏.mp4 (720x1280, 829.6KB, 8.8s) 已保存: C:\\data\\downloads\\video\\user_1\\live.mp4]'
    );
  });

  it('落盘失败时：有 remote.url 输出下载失败原因与直链，无 remote.url 仍呈现入站落盘失败', () => {
    const descWithoutUrl: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: 'bad_video.mp4',
      remote: { fileUuid: 'bad_uuid' },
      unavailable: 'download_failed',
    };
    expect(renderAttachment(descWithoutUrl)).toBe('[视频:bad_video.mp4 (ID:bad_uuid) (入站落盘失败)]');

    const failUrl = 'https://multimedia.nt.qq.com.cn/download?rkey=FAILED_VIDEO_RKEY';
    const descWithUrl: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: 'bad_video.mp4',
      remote: { fileUuid: 'bad_uuid', url: failUrl },
      unavailable: 'HTTP 下载失败 (status: 404)',
    };
    expect(renderAttachment(descWithUrl)).toBe(
      `[视频:bad_video.mp4 (ID:bad_uuid) (下载失败: HTTP 下载失败 (status: 404)) 直链: ${failUrl}]`
    );
  });
});

describe('契约 2: 官方视频入站分类、裸 GET 落盘与唤醒归一化', () => {
  let tmpDir: string;
  let manager: MediaStorageManager;
  let servers: http.Server[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-video-att-'));
    manager = new MediaStorageManager({ dshHome: tmpDir, downloadDir: 'downloads' });
    servers = [];
  });

  afterEach(async () => {
    for (const srv of servers) {
      await new Promise<void>((r) => srv.close(() => r())).catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startVideoServer(
    status = 200,
    payload: Buffer = MP4_BYTES,
    onRequest?: (req: http.IncomingMessage) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        onRequest?.(req);
        res.writeHead(status, { 'Content-Type': 'video/mp4' });
        res.end(status === 200 ? payload : Buffer.from('error'));
      });
      srv.on('error', reject);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        resolve(`http://127.0.0.1:${addr.port}/demo.mp4?rkey=VIDEO_RKEY_SECRET`);
      });
    });
  }

  it('入站 video/mp4 附件裸 GET 落盘至 downloads/video/<peer>/ 并生成标准唤醒正文', async () => {
    const url = await startVideoServer(200);
    const peer = openidToPeer(MOCK_OPENID);
    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_video_001',
      content: '看看这个视频',
      timestamp: '2026-11-11T18:35:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        {
          content_type: 'video/mp4',
          filename: 'demo_clip.mp4',
          size: MP4_BYTES.length,
          url,
        },
      ],
    };

    const rawDesc = describeInboundAttachments(event);
    expect(rawDesc.type).toBe('video');
    expect(rawDesc.attachments[0]!.kind).toBe('video');

    const resolved = await resolveInboundAttachments(event, peer, manager);
    expect(resolved[0]!.local?.path).toBeTruthy();
    expect(resolved[0]!.local!.path.startsWith(path.join(tmpDir, 'downloads', 'video', peer))).toBe(true);
    expect(resolved[0]!.local!.path.endsWith('demo_clip.mp4')).toBe(true);
    expect(Buffer.compare(fs.readFileSync(resolved[0]!.local!.path), MP4_BYTES)).toBe(0);

    const normalized = parseNormalizedContent(event, resolved);
    expect(normalized).toBe(`看看这个视频 [视频:demo_clip.mp4 已保存: ${resolved[0]!.local!.path}]`);

    const decision = await shouldWakeup(event, { descriptors: resolved });
    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe(normalized);
    expect(decision.payload?.content).not.toContain('VIDEO_RKEY_SECRET');
  });

  it('视频下载失败时遵循选项 A 保留直链且 unavailable 不泄露凭证；无 URL 时呈入站落盘失败', async () => {
    const deadUrl = await startVideoServer(404);
    const peer = openidToPeer(MOCK_OPENID);
    const eventWithUrl: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_video_002',
      content: '',
      timestamp: '2026-11-11T18:36:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        {
          content_type: 'video/mp4',
          filename: 'missing.mp4',
          url: deadUrl,
        },
      ],
    };

    const resolved = await resolveInboundAttachments(eventWithUrl, peer, manager);
    expect(resolved[0]!.local).toBeUndefined();
    expect(resolved[0]!.unavailable).toBeTruthy();
    expect(resolved[0]!.unavailable).toContain('HTTP 下载失败 (status: 404):');
    expect(resolved[0]!.unavailable).not.toContain('VIDEO_RKEY_SECRET');

    const decision = await shouldWakeup(eventWithUrl, { descriptors: resolved });
    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe(
      `[视频:missing.mp4 (下载失败: ${resolved[0]!.unavailable}) 直链: ${deadUrl}]`
    );
    expect(decision.payload?.content).toContain(`直链: ${deadUrl}`);
    expect(decision.payload?.content).not.toContain('(链接已脱敏)');

    const eventNoUrl: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_video_003',
      content: '',
      timestamp: '2026-11-11T18:36:10+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        {
          content_type: 'video/mp4',
          filename: 'bad_video.mp4',
        },
      ],
    };
    const resolvedNoUrl = await resolveInboundAttachments(eventNoUrl, peer, manager);
    expect(resolvedNoUrl[0]!.unavailable).toBe('no_download_url');
    const decisionNoUrl = await shouldWakeup(eventNoUrl, { descriptors: resolvedNoUrl });
    expect(decisionNoUrl.payload?.content).toBe('[视频:bad_video.mp4 (入站落盘失败)]');
  });

  it('直入真实 MP4 元数据提取（含 moov->mvhd 8.776s 与 width/height，含无 content_type 的 clip.mp4 场景）', async () => {
    const realMp4 = buildSampleMp4WithMvhd(8.776, 1024);
    const seenAuthHeaders: Array<string | undefined> = [];
    const videoUrl = await startVideoServer(200, realMp4, (req) => {
      seenAuthHeaders.push(req.headers.authorization);
    });
    const peer = openidToPeer(MOCK_OPENID);
    const expectedSizeText = formatAttachmentByteSize(realMp4.length);

    // 场景 A: 标准 video/mp4 + width/height
    const eventWithType: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_video_004',
      content: '',
      timestamp: '2026-11-11T18:37:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        {
          content_type: 'video/mp4',
          filename: 'real_meta.mp4',
          width: 720,
          height: 1280,
          size: realMp4.length,
          url: videoUrl,
        },
      ],
    };

    const resolvedA = await resolveInboundAttachments(eventWithType, peer, manager);
    expect(seenAuthHeaders[0]).toBeUndefined();
    expect(resolvedA[0]!.local?.path.startsWith(path.join(tmpDir, 'downloads', 'video', peer))).toBe(true);
    expect(resolvedA[0]!.local?.path.endsWith('real_meta.mp4')).toBe(true);
    expect(resolvedA[0]!.local?.dimensions).toBe('720x1280');
    expect(resolvedA[0]!.local?.durationSec).toBeCloseTo(8.776, 3);
    expect(resolvedA[0]!.local?.size).toBe(realMp4.length);

    const normalizedA = parseNormalizedContent(eventWithType, resolvedA);
    expect(normalizedA).toBe(
      `[视频:real_meta.mp4 (720x1280, ${expectedSizeText}, 8.8s) 已保存: ${resolvedA[0]!.local!.path}]`
    );

    // 场景 B: 无 content_type 但文件名 clip.mp4
    const eventWithoutType: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_video_005',
      content: '',
      timestamp: '2026-11-11T18:38:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        {
          filename: 'clip.mp4',
          width: 720,
          height: 1280,
          size: realMp4.length,
          url: videoUrl,
        },
      ],
    };

    const rawNoType = describeInboundAttachments(eventWithoutType);
    expect(rawNoType.type).toBe('video');
    expect(rawNoType.attachments[0]!.kind).toBe('video');

    const resolvedB = await resolveInboundAttachments(eventWithoutType, peer, manager);
    expect(seenAuthHeaders[1]).toBeUndefined();
    expect(resolvedB[0]!.kind).toBe('video');
    expect(resolvedB[0]!.local?.path.startsWith(path.join(tmpDir, 'downloads', 'video', peer))).toBe(true);
    expect(resolvedB[0]!.local?.path.endsWith('clip.mp4')).toBe(true);
    expect(resolvedB[0]!.local?.dimensions).toBe('720x1280');
    expect(resolvedB[0]!.local?.durationSec).toBeCloseTo(8.776, 3);

    const normalizedB = parseNormalizedContent(eventWithoutType, resolvedB);
    expect(normalizedB).toBe(
      `[视频:clip.mp4 (720x1280, ${expectedSizeText}, 8.8s) 已保存: ${resolvedB[0]!.local!.path}]`
    );
  });
});
