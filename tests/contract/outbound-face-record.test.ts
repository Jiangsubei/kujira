/**
 * tests/contract/outbound-face-record.test.ts
 *
 * 契约测试: 出站表情/富媒体自记录消费统一描述符与四步分片上传闭环
 *
 * 覆盖规范:
 * 1. 无 OneBot 段与 get_msg 回查，直接消费旁路 `AttachmentDescriptor[]` 落库；
 * 2. 四步分片上传严格遵循：1-based parts[].index 升序 + 累积 offset + 每片自身 block_size +
 *    裸 PUT（不附鉴权头）+ upload_part_finish 上报该片真实 block_size + /files；
 * 3. `(openid, md5, fileType)` 本地 24h `media_upload_cache` 命中复用 `file_info`，未命中绝不假设秒传；
 * 4. 真实发送成功后立即写入 `messages`（`self=1`、`attachments` 保留 face 与本地事实），且不污染 `inbound_reply_slots`。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { KujiraGatewayClient } from '../../src/gateway/server.js';
import { buildSelfMessageRecord, recordOutboundSelfMessage } from '../../src/outbound/self-record.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import type { MediaUploadCacheRecord, MessageRecord } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const BOT_ID = '1000000000';
const TEST_OPENID = '00112233445566778899AABBCCDDEEFF';
const TEST_PEER = openidToPeer(TEST_OPENID);
const SENDER_NAME = '测试助手';

function pngBytes(size = 32): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (size <= header.length) return header;
  return Buffer.concat([header, Buffer.alloc(size - header.length, 5)]);
}

function createV2MediaDb(dbPath: string) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      time INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      raw TEXT NOT NULL,
      file_id TEXT,
      local_path TEXT,
      fingerprint TEXT,
      recalled INTEGER NOT NULL DEFAULT 0,
      self INTEGER NOT NULL DEFAULT 0,
      reply_to TEXT,
      ref_idx TEXT,
      source TEXT NOT NULL DEFAULT 'qq',
      attachments TEXT
    );
    CREATE TABLE IF NOT EXISTS inbound_reply_slots (
      msg_id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      openid TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_upload_cache (
      openid TEXT NOT NULL,
      md5 TEXT NOT NULL,
      file_type INTEGER NOT NULL,
      file_info TEXT NOT NULL,
      file_uuid TEXT,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (openid, md5, file_type)
    );
  `);

  const insertMsg = raw.prepare(`
    INSERT OR IGNORE INTO messages (
      msg_id, peer, user_id, sender_name, time, type, content, raw,
      file_id, local_path, fingerprint, recalled, self, reply_to, ref_idx, source, attachments
    ) VALUES (
      @msg_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
      @file_id, @local_path, @fingerprint, @recalled, @self, @reply_to, @ref_idx, @source, @attachments
    )
  `);

  const db = {
    getOpenidByPeer: (peer: string) => (peer === TEST_PEER ? TEST_OPENID : null),
    saveMessageIfNotExists(record: MessageRecord): boolean {
      const res = insertMsg.run({
        msg_id: record.msg_id,
        peer: record.peer,
        user_id: record.user_id,
        sender_name: record.sender_name || '',
        time: record.time,
        type: record.type,
        content: record.content,
        raw: record.raw,
        file_id: record.file_id ?? null,
        local_path: record.local_path ?? null,
        fingerprint: record.fingerprint ?? null,
        recalled: record.recalled ? 1 : 0,
        self: record.self ? 1 : 0,
        reply_to: record.reply_to ?? null,
        ref_idx: record.ref_idx ?? null,
        source: record.source ?? 'qq',
        attachments: record.attachments ?? null,
      });
      return res.changes > 0;
    },
    getCachedMediaUpload(openid: string, md5: string, fileType: number): MediaUploadCacheRecord | null {
      const row = raw
        .prepare('SELECT * FROM media_upload_cache WHERE openid = ? AND md5 = ? AND file_type = ?')
        .get(openid, md5, fileType) as MediaUploadCacheRecord | undefined;
      return row ?? null;
    },
    saveCachedMediaUpload(record: MediaUploadCacheRecord): void {
      raw
        .prepare(
          `INSERT OR REPLACE INTO media_upload_cache (openid, md5, file_type, file_info, file_uuid, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(record.openid, record.md5, record.file_type, record.file_info, record.file_uuid ?? null, record.expires_at);
    },
    getMessage: (msgId: string) => raw.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId) as any,
    listInboundSlots: () => raw.prepare('SELECT * FROM inbound_reply_slots').all() as any[],
  };

  return { raw, db };
}

describe('契约测试: 出站表情包描述符自记录 (纯函数)', () => {
  it('契约 1: 旁路携带 sticker/face 描述符时正确渲染 content 并序列化 attachments', () => {
    const facePath = path.join('/faces', 'face_x.png');
    const provided: AttachmentDescriptor[] = [
      {
        kind: 'sticker',
        origin: 'outbound',
        local: { path: facePath, format: 'png', md5: 'abcdef0123456789abcdef0123456789' },
        face: { id: 'face_x', mood: '嘲讽', tags: ['猫猫'] },
        remote: { fileId: 'uuid_sticker_1' },
      },
    ];

    const record = buildSelfMessageRecord(
      {
        peer: TEST_PEER,
        openid: TEST_OPENID,
        msgId: 'ROBOT1.0_OUT_STICKER_1',
        refIdx: 'REFIDX_OUT_STICKER_1',
        msgType: 7,
        time: 1793800000000,
        attachments: provided,
      },
      { botId: BOT_ID, senderName: SENDER_NAME }
    )!;

    expect(record.type).toBe('sticker');
    expect(record.content).toBe(`[表情包: face_x (情绪: 嘲讽) 路径: ${facePath}]`);
    expect(record.local_path).toBe(facePath);
    expect(record.file_id).toBe('uuid_sticker_1');
    expect(record.ref_idx).toBe('REFIDX_OUT_STICKER_1');
    expect(JSON.parse(record.attachments!)[0].face.id).toBe('face_x');
  });
});

describe('契约测试: 四步分片上传 + 24h 本地缓存 + 自记录落库闭环', () => {
  let tmpDir: string;
  let store: ReturnType<typeof createV2MediaDb>;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-face-record-'));
    store = createV2MediaDb(path.join(tmpDir, 'messages.sqlite'));
  });

  afterEach(async () => {
    store.raw.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 2: 1-based 分片乱序返回仍按 index 升序 + 累积 offset + 每片 block_size 裸 PUT，且二次发送命中 24h 本地缓存', async () => {
    const data = pngBytes(25); // 25 字节，切分为 15B + 10B 两片
    const localFile = path.join(tmpDir, 'face.png');
    await fsp.writeFile(localFile, data);

    const calls: Array<{ url: string; method: string; headers: any; bodyLen?: number; bodyJson?: any }> = [];
    const uploadedBytes: Buffer[] = [];
    let msgCounter = 0;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.includes('getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 7200 }), { status: 200 });
      }
      if (url.includes('cos.accelerate.myqcloud.com')) {
        const buf = Buffer.from(init?.body as Uint8Array);
        uploadedBytes.push(buf);
        calls.push({ url, method, headers: init?.headers, bodyLen: buf.length });
        // 验证裸 PUT 不含 Authorization 头
        expect((init?.headers as any)?.Authorization).toBeUndefined();
        return new Response('', { status: 200 });
      }

      const jsonBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, headers: init?.headers, bodyJson: jsonBody });

      if (url.endsWith('/upload_prepare')) {
        // 故意倒序返回 1-based parts (index=2 在前，index=1 在后)，验证排序与累积偏移
        return new Response(
          JSON.stringify({
            upload_id: 'up_001',
            block_size: 15,
            parts: [
              { index: 2, presigned_url: 'https://qqbot-file-upload-1251316161.cos.accelerate.myqcloud.com/p2?sig=secret2', block_size: '10' },
              { index: 1, presigned_url: 'https://qqbot-file-upload-1251316161.cos.accelerate.myqcloud.com/p1?sig=secret1', block_size: '15' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/upload_part_finish')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.endsWith('/files')) {
        return new Response(
          JSON.stringify({ file_uuid: 'uuid_up_001', file_info: 'FILE_INFO_BASE64_001', ttl: 86400 }),
          { status: 200 }
        );
      }
      if (url.endsWith('/messages')) {
        msgCounter += 1;
        return new Response(
          JSON.stringify({
            id: `ROBOT1.0_OUT_FACE_${msgCounter}`,
            ext_info: { ref_idx: `REFIDX_OUT_FACE_${msgCounter}` },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const gateway = new KujiraGatewayClient({
      credentials: { appId: 'mock_app_id', appSecret: 'mock_app_secret' },
      fetchFn: fetchMock,
      onMessageSent: (event) => {
        recordOutboundSelfMessage(event, {
          db: store.db,
          botId: BOT_ID,
          senderName: SENDER_NAME,
        });
      },
    });

    const bridge = new OutboundStreamBridge({} as any, {
      gateway,
      db: store.db,
    });

    const descriptor: AttachmentDescriptor = {
      kind: 'sticker',
      origin: 'outbound',
      local: { path: localFile, format: 'png' },
      face: { id: 'face_x', mood: '嘲讽', tags: ['猫猫'] },
    };

    // 第一次发送：完整执行四步分片上传 + msg_type=7 发送
    const res1 = await bridge.sendMediaReply(TEST_PEER, {
      filePath: localFile,
      fileType: 1,
      fileName: 'face.png',
      attachments: [descriptor],
    });
    expect(res1.ok).toBe(true);

    // 校验分片顺序、累积切片字节与每片自身 block_size 上报
    expect(uploadedBytes).toHaveLength(2);
    expect(Buffer.concat(uploadedBytes).equals(data)).toBe(true);
    expect(uploadedBytes[0].length).toBe(15);
    expect(uploadedBytes[1].length).toBe(10);

    const finishes = calls.filter((c) => c.url.endsWith('/upload_part_finish'));
    expect(finishes).toHaveLength(2);
    expect(finishes[0].bodyJson.part_index).toBe(1);
    expect(finishes[0].bodyJson.block_size).toBe('15');
    expect(finishes[1].bodyJson.part_index).toBe(2);
    expect(finishes[1].bodyJson.block_size).toBe('10');

    // 校验自记录写入 messages，且不污染 inbound_reply_slots
    const row1 = store.db.getMessage('ROBOT1.0_OUT_FACE_1');
    expect(row1).toBeDefined();
    expect(row1.self).toBe(1);
    expect(row1.type).toBe('sticker');
    expect(row1.content).toContain('[表情包: face_x (情绪: 嘲讽)');
    expect(row1.ref_idx).toBe('REFIDX_OUT_FACE_1');
    expect(store.db.listInboundSlots()).toHaveLength(0);

    // 第二次发送同一文件：命中 24h media_upload_cache，跳过 upload_prepare / PUT / files 直接发送 msg_type=7
    const callCountBeforeSecond = calls.length;
    const res2 = await bridge.sendMediaReply(TEST_PEER, {
      filePath: localFile,
      fileType: 1,
      fileName: 'face.png',
      attachments: [descriptor],
    });
    expect(res2.ok).toBe(true);
    const secondCalls = calls.slice(callCountBeforeSecond);
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0].url.endsWith('/messages')).toBe(true);
    expect(secondCalls[0].bodyJson.media.file_info).toBe('FILE_INFO_BASE64_001');
  });
});
