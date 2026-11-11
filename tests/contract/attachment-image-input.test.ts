/**
 * tests/contract/attachment-image-input.test.ts
 *
 * 契约测试: 入站媒体回归纯文本本地路径占位模式（绝不暴露含凭证 URL，支持模型按需读图）
 *
 * 覆盖规范（仅依赖 Batch 1 与 Batch 2 模块）：
 * 1. 入站 PNG 图片经 `resolveInboundAttachments` 裸 GET 落盘后，`parseNormalizedContent` 与 `shouldWakeup`
 *    输出纯文本本地路径占位 `[图片:<localPath>]`，且 `payload.images` 收集物理路径；
 * 2. 多张图片及以 `content_type === 'file'` 下发的 `.png` 文件均保存真实扩展名与确定性本地路径；
 * 3. 下载失败或无本地路径时，渲染文本绝不回退泄露带 `rkey` query 凭证的 `remote.url`。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import { resolveInboundAttachments } from '../../src/gateway/inbound-media.js';
import { parseNormalizedContent, shouldWakeup } from '../../src/gateway/wakeup.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0002';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

describe('契约测试: 入站媒体纯文本路径占位与安全边界 (Batch 2)', () => {
  let tmpHome: string;
  let manager: MediaStorageManager;
  let servers: http.Server[] = [];

  async function startLoopback(body: Buffer, status = 200, queryPath = '/img.png?rkey=SECRET_KEY_1'): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'image/png' });
        res.end(body);
      });
      srv.on('error', reject);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as any;
        resolve(`http://127.0.0.1:${addr.port}${queryPath}`);
      });
    });
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-image-input-'));
    manager = new MediaStorageManager({ dshHome: tmpHome, downloadDir: 'downloads' });
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    }
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: 单张 PNG 入站裸 GET 落盘 → 正文纯文本路径占位且绝不含凭证 URL', async () => {
    const url = await startLoopback(PNG_1X1);
    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_img_input_001',
      content: '帮我看看这张图',
      timestamp: '2026-11-11T18:30:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        {
          content_type: 'image/png',
          filename: '95C5A03B7A.png',
          size: PNG_1X1.length,
          url,
        },
      ],
    };

    const descriptors = await resolveInboundAttachments(event, 'user_mock_01', manager);
    const decision = await shouldWakeup(event, { descriptors });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
    expect(decision.payload?.images).toHaveLength(1);
    const localPath = decision.payload!.images![0]!;
    expect(fs.existsSync(localPath)).toBe(true);
    expect(localPath.endsWith('.png')).toBe(true);

    expect(decision.payload?.content).toContain(`帮我看看这张图 [图片:${localPath}]`);
    expect(decision.payload?.content).not.toContain('SECRET_KEY_1');
    expect(decision.payload?.content).not.toContain('http://');
  });

  it('契约 2: 多图 + content_type=file 的 .png 文件入站 → 均保留确定性本地路径供按需读图', async () => {
    const url1 = await startLoopback(PNG_1X1, 200, '/a.png?rkey=RKEY_A');
    const url2 = await startLoopback(PNG_1X1, 200, '/b.png?rkey=RKEY_B');
    const filePngUrl = await startLoopback(PNG_1X1, 200, '/doc.png?rkey=RKEY_FILE');

    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_img_input_002',
      content: '',
      timestamp: '2026-11-11T18:31:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        { content_type: 'image/png', filename: 'first.png', url: url1 },
        { content_type: 'image/png', filename: 'second.png', url: url2 },
        { content_type: 'file', filename: 'screenshot.png', url: filePngUrl },
      ],
    };

    const descriptors = await resolveInboundAttachments(event, 'user_mock_02', manager);
    const normalized = parseNormalizedContent(event, descriptors);
    const decision = await shouldWakeup(event, { descriptors });

    expect(descriptors).toHaveLength(3);
    expect(descriptors[2]!.kind).toBe('file');
    expect(descriptors[2]!.local?.path.endsWith('screenshot.png')).toBe(true);
    expect(descriptors[2]!.local?.format).toBe('png');

    expect(normalized).toContain('[图片:');
    expect(normalized).toContain('[文件:screenshot.png 已保存:');
    expect(normalized).not.toContain('RKEY_');
    expect(decision.payload?.images).toHaveLength(3);
  });

  it('契约 3: 落盘失败时渲染文本严禁回退泄露 remote.url 中的凭证', async () => {
    const deadUrl = await startLoopback(Buffer.from('forbidden'), 403, '/secret.png?rkey=DO_NOT_LEAK');
    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_img_input_003',
      content: '图裂了吗',
      timestamp: '2026-11-11T18:32:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      attachments: [
        { content_type: 'image/png', filename: 'broken.png', url: deadUrl },
      ],
    };

    const descriptors = await resolveInboundAttachments(event, 'user_mock_03', manager);
    const decision = await shouldWakeup(event, { descriptors });

    expect(descriptors[0]!.local).toBeUndefined();
    expect(descriptors[0]!.unavailable).toBeTruthy();
    expect(descriptors[0]!.unavailable).not.toContain('DO_NOT_LEAK');
    expect(decision.payload?.content).toBe('图裂了吗 [图片:broken.png (入站落盘失败)]');
    expect(decision.payload?.content).not.toContain('DO_NOT_LEAK');
  });
});
