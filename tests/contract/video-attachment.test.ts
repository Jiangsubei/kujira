/**
 * tests/contract/video-attachment.test.ts
 *
 * 契约测试: QQ 官方 Bot 单聊视频附件分类、裸 GET 落盘与语义化渲染契约
 *
 * 核心契约（仅依赖 Batch 1 与 Batch 2 模块）：
 * 1. `renderAttachment` 对 `video` 支持 `local.path`、`remote.fileUuid`、`fileName`、`unavailable` 语义化渲染，且不暴露凭证 URL；
 * 2. `describeInboundAttachments` 对 `content_type: 'video/mp4'` 判定 `kind: 'video'` 与主导类型 `'video'`；
 * 3. `resolveInboundAttachments` 对视频执行裸 GET 落盘至 `downloads/video/<peer>/`；
 * 4. `parseNormalizedContent` 与 `shouldWakeup` 在落盘成功/失败时输出准确、无凭证泄漏的占位文案。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import { describeInboundAttachments } from '../../src/attachment/classify.js';
import { renderAttachment } from '../../src/attachment/render.js';
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

describe('契约 1: 视频附件描述符语义化渲染 (renderAttachment)', () => {
  it('无任何元数据时保持兜底 [视频]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
    };
    expect(renderAttachment(desc)).toBe('[视频]');
  });

  it('未落盘但有 fileUuid 与独立文件名时呈现 [视频:<fileName> (ID:<fileUuid>)]，绝不输出 remote.url', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: '精彩集锦.mp4',
      remote: {
        fileUuid: 'video-uuid-001',
        url: 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET_VIDEO_RKEY',
      },
    };
    const rendered = renderAttachment(desc);
    expect(rendered).toBe('[视频:精彩集锦.mp4 (ID:video-uuid-001)]');
    expect(rendered).not.toContain('SECRET_VIDEO_RKEY');
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

  it('已落盘时呈现 [视频 已保存: <local_path>] 或带文件名格式', () => {
    const bare: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      local: { path: 'C:\\data\\downloads\\video\\user_1\\clip.mp4', format: 'mp4' },
    };
    expect(renderAttachment(bare)).toBe(
      '[视频 已保存: C:\\data\\downloads\\video\\user_1\\clip.mp4]'
    );

    const named: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: '实况录屏.mp4',
      local: { path: 'C:\\data\\downloads\\video\\user_1\\live.mp4', format: 'mp4' },
    };
    expect(renderAttachment(named)).toBe(
      '[视频:实况录屏.mp4 已保存: C:\\data\\downloads\\video\\user_1\\live.mp4]'
    );
  });

  it('落盘失败时如实标记 [视频... (入站落盘失败)]', () => {
    const desc: AttachmentDescriptor = {
      kind: 'video',
      origin: 'inbound',
      fileName: 'bad_video.mp4',
      remote: { fileUuid: 'bad_uuid' },
      unavailable: 'download_failed',
    };
    expect(renderAttachment(desc)).toBe('[视频:bad_video.mp4 (ID:bad_uuid) (入站落盘失败)]');
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

  async function startVideoServer(status = 200): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'video/mp4' });
        res.end(status === 200 ? MP4_BYTES : Buffer.from('error'));
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

  it('视频下载失败时标记落盘失败且绝不暴露带凭证 URL', async () => {
    const deadUrl = await startVideoServer(404);
    const peer = openidToPeer(MOCK_OPENID);
    const event: QQC2CMessageCreateEvent = {
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

    const resolved = await resolveInboundAttachments(event, peer, manager);
    expect(resolved[0]!.local).toBeUndefined();
    expect(resolved[0]!.unavailable).toBeTruthy();
    expect(resolved[0]!.unavailable).not.toContain('VIDEO_RKEY_SECRET');

    const decision = await shouldWakeup(event, { descriptors: resolved });
    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe('[视频:missing.mp4 (入站落盘失败)]');
    expect(decision.payload?.content).not.toContain('VIDEO_RKEY_SECRET');
  });
});
