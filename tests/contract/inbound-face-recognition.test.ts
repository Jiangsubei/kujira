/**
 * tests/contract/inbound-face-recognition.test.ts
 *
 * 契约测试: 入站图片识别本地表情库并替换语义 (Inbound Face Recognition Contract)
 *
 * 覆盖契约（仅依赖 Batch 1 与 Batch 2 模块）：
 * 1. `formatFacePlaceholder` 格式化语义占位符（含情绪 / 无情绪）；
 * 2. `parseNormalizedContent` 对官方 `QQC2CMessageCreateEvent` + `AttachmentDescriptor[]` 进行 MD5 命中识别：
 *    - 命中启用且未删除的表情包 → 升格为 `[表情包: <face_id> (情绪: <mood>) 路径: <local_path>]`；
 *    - 已被软删除或已禁用的表情包 → 不触发识别；
 *    - 已预先绑定 `descriptor.face` → 直接复用，不再查库；
 * 3. 与 `resolveInboundAttachments` + `shouldWakeup` 串联：裸 GET 落盘后计算 MD5 命中表情库并注入 `WakeupPayload`。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import { resolveInboundAttachments } from '../../src/gateway/inbound-media.js';
import {
  formatFacePlaceholder,
  parseNormalizedContent,
  shouldWakeup,
} from '../../src/gateway/wakeup.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import type { FaceRecord, QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0004';
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('契约测试: 入站图片识别本地表情库并替换语义 (Inbound Face Recognition Contract)', () => {
  let tmpDir: string;
  let faceStore: Map<string, FaceRecord>;
  let servers: http.Server[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-inbound-face-'));
    faceStore = new Map<string, FaceRecord>();
    servers = [];
  });

  afterEach(async () => {
    for (const srv of servers) {
      await new Promise<void>((r) => srv.close(() => r())).catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockImageFile(content: string, name = 'test.png'): { filePath: string; md5: string; buf: Buffer } {
    const filePath = path.join(tmpDir, name);
    const buf = Buffer.concat([PNG_HEADER, Buffer.from(content)]);
    fs.writeFileSync(filePath, buf);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    return { filePath, md5, buf };
  }

  function registerFace(record: FaceRecord): void {
    faceStore.set(record.md5.toLowerCase(), record);
  }

  const lookupFace = (md5: string): FaceRecord | undefined => faceStore.get(md5.toLowerCase());

  function makeEvent(overrides: Partial<QQC2CMessageCreateEvent> = {}): QQC2CMessageCreateEvent {
    return {
      id: 'ROBOT1.0_face_001',
      content: '',
      timestamp: '2026-11-11T18:40:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
      ...overrides,
    };
  }

  describe('1. formatFacePlaceholder 格式化语义占位符', () => {
    it('契约 1.1: 包含情绪与标签时仅拼入情绪与 face_id，省略详细标签', () => {
      const res = formatFacePlaceholder({
        id: 'face_a1b2c3d4',
        mood: '嘲讽',
        tags: ['猫猫', '叹气'],
      } as any);
      expect(res).toBe('[表情包: face_a1b2c3d4 (情绪: 嘲讽)]');
    });

    it('契约 1.2: 仅包含情绪，无标签', () => {
      const res = formatFacePlaceholder({
        id: 'face_a1b2c3d4',
        mood: '卖萌',
      });
      expect(res).toBe('[表情包: face_a1b2c3d4 (情绪: 卖萌)]');
    });

    it('契约 1.3: 无情绪时降级为仅 face_id', () => {
      const res = formatFacePlaceholder({ id: 'face_a1b2c3d4' });
      expect(res).toBe('[表情包: face_a1b2c3d4]');
    });

    it('契约 1.4: 携带本地路径时拼接 路径: <localPath>', () => {
      const res = formatFacePlaceholder({ id: 'face_a1b2c3d4', mood: '开心' }, '/faces/a.png');
      expect(res).toBe('[表情包: face_a1b2c3d4 (情绪: 开心) 路径: /faces/a.png]');
    });
  });

  describe('2. parseNormalizedContent 入站表情识别契约', () => {
    it('契约 2.1: 入站 image 描述符若 MD5 命中已收藏表情库，升格为语义占位符', () => {
      const { filePath, md5 } = createMockImageFile('cat-sigh-image-bytes', 'cat.png');

      registerFace({
        id: 'face_cat_sigh',
        file_path: '/faces/cat.png',
        md5,
        added_at: Date.now(),
        source: 'collect',
        tags: ['猫猫', '叹气'],
        mood: '嘲讽',
        enabled: true,
        size: 100,
        format: 'png',
        use_count: 0,
      });

      const descriptors: AttachmentDescriptor[] = [
        {
          kind: 'image',
          origin: 'inbound',
          local: { path: filePath, format: 'png', md5 },
        },
      ];

      const content = parseNormalizedContent(makeEvent(), descriptors, {
        getFaceByMd5: lookupFace,
      });

      expect(content).toBe(`[表情包: face_cat_sigh (情绪: 嘲讽) 路径: ${filePath}]`);
      expect(descriptors[0]!.face?.id).toBe('face_cat_sigh');
    });

    it('契约 2.2: 描述符未预先附带 md5 时，基于 local.path 自动计算文件 MD5 并命中表情库', () => {
      const { filePath, md5 } = createMockImageFile('doge-look-bytes', 'doge.png');

      registerFace({
        id: 'face_doge',
        file_path: '/faces/doge.png',
        md5,
        added_at: Date.now(),
        source: 'collect',
        tags: ['柴犬'],
        mood: '蔑视',
        enabled: true,
        size: 200,
        format: 'png',
        use_count: 0,
      });

      const descriptors: AttachmentDescriptor[] = [
        {
          kind: 'image',
          origin: 'inbound',
          local: { path: filePath, format: 'png' },
        },
      ];

      const content = parseNormalizedContent(makeEvent(), descriptors, {
        getFaceByMd5: lookupFace,
      });

      expect(content).toBe(`[表情包: face_doge (情绪: 蔑视) 路径: ${filePath}]`);
      expect(content).not.toContain('[图片:');
    });

    it('契约 2.3: 未收藏的普通图片保持 [图片:/path] 格式不变', () => {
      const { filePath } = createMockImageFile('uncollected-photo-bytes', 'scenery.png');
      const descriptors: AttachmentDescriptor[] = [
        { kind: 'image', origin: 'inbound', local: { path: filePath, format: 'png' } },
      ];

      const content = parseNormalizedContent(makeEvent(), descriptors, {
        getFaceByMd5: lookupFace,
      });

      expect(content).toBe(`[图片:${filePath}]`);
    });

    it('契约 2.4: 已被软删除或已禁用的表情包绝不触发表情识别', () => {
      const { filePath, md5 } = createMockImageFile('deleted-face-bytes', 'deleted.png');

      registerFace({
        id: 'face_deleted',
        file_path: '/faces/deleted.png',
        md5,
        added_at: Date.now(),
        source: 'collect',
        tags: ['已删'],
        mood: '无',
        enabled: true,
        size: 100,
        format: 'png',
        use_count: 0,
        deleted_at: Date.now(),
      });

      const { filePath: disabledPath, md5: disabledMd5 } = createMockImageFile(
        'disabled-face-bytes',
        'disabled.png'
      );
      registerFace({
        id: 'face_disabled',
        file_path: '/faces/disabled.png',
        md5: disabledMd5,
        added_at: Date.now(),
        source: 'collect',
        tags: ['禁用'],
        mood: '冷漠',
        enabled: false,
        size: 100,
        format: 'png',
        use_count: 0,
      });

      const content = parseNormalizedContent(
        makeEvent(),
        [
          { kind: 'image', origin: 'inbound', local: { path: filePath, md5 } },
          { kind: 'image', origin: 'inbound', local: { path: disabledPath, md5: disabledMd5 } },
        ],
        { getFaceByMd5: lookupFace }
      );

      expect(content).toBe(`[图片:${filePath}] [图片:${disabledPath}]`);
      expect(content).not.toContain('face_deleted');
      expect(content).not.toContain('face_disabled');
    });

    it('契约 2.5: 描述符已预先绑定 face 时直接使用，不重复查库', () => {
      let called = 0;
      const descriptors: AttachmentDescriptor[] = [
        {
          kind: 'sticker',
          origin: 'inbound',
          local: { path: '/tmp/test.png' },
          face: { id: 'face_pre_bound', mood: '得意', tags: ['哈哈'] },
        },
      ];

      const content = parseNormalizedContent(makeEvent(), descriptors, {
        getFaceByMd5: () => {
          called++;
          return undefined;
        },
      });

      expect(called).toBe(0);
      expect(content).toBe('[表情包: face_pre_bound (情绪: 得意) 路径: /tmp/test.png]');
    });
  });

  describe('3. 裸 GET 落盘 + shouldWakeup 全链路表情识别契约', () => {
    it('契约 3.1: 入站附件下载落盘后命中本地表情库，WakeupPayload 携带语义占位符与本地路径', async () => {
      const { md5, buf } = createMockImageFile('happy-cat-network-bytes', 'happy.png');
      registerFace({
        id: 'face_happy_cat',
        file_path: '/faces/happy.png',
        md5,
        added_at: Date.now(),
        source: 'collect',
        tags: ['猫', '开心'],
        mood: '喜悦',
        enabled: true,
        size: buf.length,
        format: 'png',
        use_count: 0,
      });

      const url = await new Promise<string>((resolve, reject) => {
        const srv = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(buf);
        });
        srv.on('error', reject);
        servers.push(srv);
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as any;
          resolve(`http://127.0.0.1:${addr.port}/face.png?rkey=FACE_RKEY`);
        });
      });

      const manager = new MediaStorageManager({ dshHome: tmpDir, downloadDir: 'downloads' });
      const peer = openidToPeer(MOCK_OPENID);
      const event = makeEvent({
        content: '看这个表情',
        attachments: [{ content_type: 'image/png', filename: 'face.png', size: buf.length, url }],
      });

      const descriptors = await resolveInboundAttachments(event, peer, manager);
      const decision = await shouldWakeup(event, {
        descriptors,
        getFaceByMd5: lookupFace,
      });

      expect(decision.wakeup).toBe(true);
      expect(decision.payload?.peer).toBe(peer);
      expect(decision.payload?.content).toContain('[表情包: face_happy_cat (情绪: 喜悦) 路径:');
      expect(decision.payload?.content).not.toContain('FACE_RKEY');
      expect(decision.payload?.images).toEqual([descriptors[0]!.local!.path]);
    });
  });
});
