/**
 * tests/contract/face-tools.test.ts
 * 契约测试: Agent 表情工具集 (list_faces, send_face, collect_face, manage_faces) 与门控
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { recordOutboundSelfMessage } from '../../src/outbound/self-record.js';
import {
  listFaces,
  sendFace,
  collectFace,
  manageFaces,
  createSendFaceTool,
  createCollectFaceTool,
  registerAgentTools,
} from '../../src/tools/index.js';
import { serializeAttachments } from '../../src/attachment/store.js';
import { openidToPeer } from '../../src/utils/peer.js';
import { QQ_FILE_TYPE_IMAGE, QQ_MSG_TYPE_MEDIA } from '../../src/constants/index.js';

const MOCK_OPENID = '3333444455556666777788889999AAAA';
const USER_PEER = openidToPeer(MOCK_OPENID);

function assertNoUndefinedFields(obj: unknown, currentPath = ''): void {
  if (obj === undefined) {
    throw new Error(`Found undefined at "${currentPath}"`);
  }
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => assertNoUndefinedFields(item, `${currentPath}[${idx}]`));
    return;
  }
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) {
      throw new Error(`Found undefined key "${currentPath ? `${currentPath}.${key}` : key}"`);
    }
    assertNoUndefinedFields(val, currentPath ? `${currentPath}.${key}` : key);
  }
}

describe('契约测试: Agent 表情工具集 (Face Tools Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let faceDir: string;
  let mockGateway: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-face-tools-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    db = new MessageDatabase(dbPath);
    db.init();
    db.upsertPeerOpenid(USER_PEER, MOCK_OPENID);
    faceDir = path.join(tmpDir, 'faces');
    fs.mkdirSync(faceDir, { recursive: true });

    mockGateway = {
      uploadC2CMedia: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { file_uuid: 'face_uuid_1', file_info: 'face_file_info_1', ttl: 86400 },
      }),
      sendC2CMessage: vi.fn(async (openid: string, payload: any, meta?: any) => {
        const rawId = 'ROBOT1.0_FACE_OUT_10001';
        const refIdx = 'REFIDX_FACE_10001';
        recordOutboundSelfMessage(
          {
            peer: meta?.peer ?? USER_PEER,
            openid,
            msgId: rawId,
            refIdx,
            replyTo: meta?.replyTo ?? null,
            msgType: 7,
            text: meta?.text,
            attachments: meta?.attachments,
            payload,
            time: Date.now(),
          },
          { db, botId: '1000000000', senderName: 'Kujira' }
        );
        return {
          ok: true,
          status: 200,
          body: {
            id: rawId,
            ext_info: { ref_idx: refIdx },
          },
        };
      }),
      sendC2CStreamMessage: vi.fn(),
      sendInputNotify: vi.fn(),
      deleteC2CMessage: vi.fn(),
      emitMessageSent: vi.fn(),
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: list_faces 分页、标签筛选与绝对路径透出', async () => {
    db.insertFace({
      id: 'face_active_1',
      file_path: '/secret/path/cat.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫', '可爱'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'face_active_2',
      file_path: '/secret/path/panda.jpg',
      md5: 'md5_2',
      source: 'collect',
      tags: ['熊猫头', '问号'],
      mood: '疑惑',
      enabled: true,
      size: 2048,
      format: 'jpg',
    });
    db.insertFace({
      id: 'face_disabled',
      file_path: '/secret/path/bad.png',
      md5: 'md5_3',
      source: 'manual',
      tags: ['猫猫'],
      mood: '卖萌',
      enabled: false,
      size: 1024,
      format: 'png',
    });

    const res = await listFaces({ mood: '卖萌' }, { db });

    expect(res.faces).toHaveLength(1);
    expect(res.faces[0]!.id).toBe('face_active_1');
    expect(res.faces[0]!.tags).toEqual(['猫猫', '可爱']);
    expect(res.faces[0]!.mood).toBe('卖萌');
    expect(res.faces[0]!.file_path).toBe('/secret/path/cat.png');
  });

  it('契约 1.1: list_faces 支持 query 综合模糊关键词与 tag/mood 模糊检索', async () => {
    db.insertFace({
      id: 'face_active_1',
      file_path: '/secret/path/cat.png',
      md5: 'md5_1',
      source: 'manual',
      tags: ['猫猫', '可爱'],
      mood: '卖萌',
      enabled: true,
      size: 1024,
      format: 'png',
    });
    db.insertFace({
      id: 'face_active_2',
      file_path: '/secret/path/panda.jpg',
      md5: 'md5_2',
      source: 'collect',
      tags: ['熊猫头', '问号'],
      mood: '疑惑',
      enabled: true,
      size: 2048,
      format: 'jpg',
    });

    const resQuery = await listFaces({ query: '问号' }, { db });
    expect(resQuery.faces.map((f) => f.id)).toContain('face_active_2');
    expect(resQuery.faces.map((f) => f.id)).not.toContain('face_active_1');

    const resTag = await listFaces({ tag: '猫' }, { db });
    expect(resTag.faces.map((f) => f.id)).toContain('face_active_1');

    const serialized = JSON.stringify(resQuery);
    expect(JSON.parse(serialized)).toEqual(resQuery);
  });

  it('契约 1.2: list_faces 支持 offset 分页并给出翻页提示', async () => {
    for (let i = 1; i <= 5; i++) {
      db.insertFace({
        id: `face_page_0${i}`,
        file_path: `/secret/path/page_${i}.png`,
        md5: `md5_page_${i}`,
        source: 'manual',
        tags: ['分页'],
        enabled: true,
        size: 100,
        format: 'png',
      });
    }

    const first = await listFaces({ offset: 0, limit: 2 }, { db });
    expect(first.faces).toHaveLength(2);
    expect(first.total).toBe(2);
    expect(first.total_matched).toBe(5);
    expect(first.offset).toBe(0);
    expect(first.limit).toBe(2);
    expect(first.has_more).toBe(true);
    expect((first as any).next_offset).toBeUndefined();

    const second = await listFaces({ offset: 2, limit: 2 }, { db });
    expect(second.faces).toHaveLength(2);
    expect(second.offset).toBe(2);
    expect(second.has_more).toBe(true);
    expect((second as any).next_offset).toBeUndefined();
    expect(second.faces.map((f) => f.id)).not.toEqual(first.faces.map((f) => f.id));

    const last = await listFaces({ offset: 4, limit: 2 }, { db });
    expect(last.faces).toHaveLength(1);
    expect(last.has_more).toBe(false);
    expect((last as any).next_offset).toBeUndefined();

    const clamped = await listFaces({ offset: -3, limit: 999 }, { db });
    expect(clamped.offset).toBe(0);
    expect(clamped.limit).toBe(100);
    expect(clamped.faces).toHaveLength(5);
  });

  it('契约 1.3: list_faces Render 使用跨页连续的全局序号', async () => {
    for (let i = 1; i <= 3; i++) {
      db.insertFace({
        id: `face_ordinal_0${i}`,
        file_path: `/secret/path/ordinal_${i}.png`,
        md5: `md5_ordinal_${i}`,
        source: 'manual',
        tags: [`序号${i}`],
        enabled: true,
        size: 100,
        format: 'png',
      });
    }

    const mockTools = { register: vi.fn() };
    registerAgentTools({ tools: mockTools } as any, {
      db,
      mediaManager: {} as any,
      config: () => ({ face_enabled: true } as any),
    } as any);
    const listTool = mockTools.register.mock.calls.map((c) => c[0]).find((t) => t.name === 'list_faces');

    const res = await listFaces({ offset: 1, limit: 2 }, { db });
    const text = (listTool as any).output.render({}, res)[0].text;
    expect(text).toContain('2. ');
    expect(text).toContain('3. ');
    expect(text).not.toContain('1. ');
  });

  it('契约 2: send_face 经 OutboundStreamBridge 四步上传 + msg_type=7 发送，标注 sticker 并记录频次', async () => {
    const testImgPath = path.join(faceDir, 'doge.png');
    fs.writeFileSync(testImgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

    db.insertFace({
      id: 'face_doge',
      file_path: testImgPath,
      md5: 'md5_doge',
      source: 'manual',
      tags: ['狗头'],
      mood: '调侃',
      enabled: true,
      size: 1024,
      format: 'png',
    });

    const bridge = new OutboundStreamBridge(new Context(), { gateway: mockGateway, db });
    const enqueueSpy = vi.spyOn(bridge.getSender(), 'enqueue');

    const res = await sendFace(
      { face_id: 'face_doge' },
      {
        db,
        outboundBridge: bridge,
        peer: USER_PEER,
      }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toBe('msg_self_1');
    expect((res as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(res);

    const sendFaceTool = createSendFaceTool();
    expect((sendFaceTool as any).output.render({}, res)[0].text).toBe(
      '已成功发送表情包 (ID: msg_self_1)'
    );

    expect(enqueueSpy).toHaveBeenCalled();
    expect(mockGateway.uploadC2CMedia).toHaveBeenCalledWith(
      MOCK_OPENID,
      expect.any(Uint8Array),
      expect.objectContaining({ fileType: QQ_FILE_TYPE_IMAGE })
    );
    expect(mockGateway.sendC2CMessage).toHaveBeenCalledWith(
      MOCK_OPENID,
      expect.objectContaining({
        msg_type: QQ_MSG_TYPE_MEDIA,
        media: { file_info: 'face_file_info_1' },
      }),
      expect.objectContaining({
        peer: USER_PEER,
        attachments: expect.arrayContaining([
          expect.objectContaining({
            kind: 'sticker',
            face: expect.objectContaining({ id: 'face_doge' }),
          }),
        ]),
      })
    );

    const updated = db.getFaceById('face_doge');
    expect(updated?.use_count).toBe(1);
    expect(updated?.last_used_at).toBeGreaterThan(0);

    bridge.dispose();
  });

  it('契约 2.1: send_face 遇到超大尺寸静态图片时，实际上传缩放到 240 的缩略图并生成缓存', async () => {
    const largeImgPath = path.join(faceDir, 'large_cat.png');
    await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toFile(largeImgPath);

    db.insertFace({
      id: 'face_large_cat',
      file_path: largeImgPath,
      md5: 'md5_large_cat',
      source: 'manual',
      tags: ['大猫'],
      mood: '呆滞',
      enabled: true,
      size: fs.statSync(largeImgPath).size,
      format: 'png',
    });

    let uploadedFileName = '';
    mockGateway.uploadC2CMedia.mockImplementationOnce(async (_openid: string, data: Uint8Array, opts: any) => {
      uploadedFileName = opts?.fileName ?? '';
      const meta = await sharp(Buffer.from(data)).metadata();
      expect(meta.width).toBe(240);
      expect(meta.height).toBe(180);
      return {
        ok: true,
        status: 200,
        body: { file_uuid: 'face_uuid_large', file_info: 'face_file_info_large', ttl: 86400 },
      };
    });

    const bridge = new OutboundStreamBridge(new Context(), { gateway: mockGateway, db });
    const res = await sendFace(
      { face_id: 'face_large_cat' },
      {
        db,
        outboundBridge: bridge,
        peer: USER_PEER,
      }
    );

    expect(res.success).toBe(true);
    expect(uploadedFileName).toContain('large_cat_240.png');

    bridge.dispose();
  });

  it('契约 3: send_face 表情不存在、已禁用或非单聊 peer 时返回清晰错误', async () => {
    const resNotFound = await sendFace(
      { face_id: 'non_existent' },
      { db, gateway: mockGateway, peer: USER_PEER }
    );
    expect(resNotFound.success).toBe(false);
    expect(resNotFound.error).toMatch(/不存在/);
    assertNoUndefinedFields(resNotFound);

    db.insertFace({
      id: 'face_disabled',
      file_path: '/path.png',
      md5: 'md5_dis',
      source: 'manual',
      tags: ['禁用'],
      enabled: false,
      size: 100,
      format: 'png',
    });

    const resDisabled = await sendFace(
      { face_id: 'face_disabled' },
      { db, gateway: mockGateway, peer: USER_PEER }
    );
    expect(resDisabled.success).toBe(false);
    expect(resDisabled.error).toMatch(/已禁用/);

    db.insertFace({
      id: 'face_valid',
      file_path: path.join(faceDir, 'v.png'),
      md5: 'md5_valid',
      source: 'manual',
      tags: ['测试'],
      enabled: true,
      size: 10,
      format: 'png',
    });
    const resGroup = await sendFace(
      { face_id: 'face_valid' },
      { db, gateway: mockGateway, peer: 'group_3000000001' }
    );
    expect(resGroup.success).toBe(false);
  });

  it('契约 4: collect_face 仅认短 message_id（及 inboundMsgIdGetter / readHistory 回退），落盘至 faceDir 并入库', async () => {
    const srcImgFile = path.join(tmpDir, 'downloaded_image.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(srcImgFile, pngBytes);
    const imgMd5 = crypto.createHash('md5').update(pngBytes).digest('hex');

    const imgRecord = {
      msg_id: 'ROBOT1.0_IMG_88881',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'image',
      content: `[图片:${srcImgFile}]`,
      raw: '{}',
      file_id: null,
      local_path: srcImgFile,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
      attachments: serializeAttachments([
        {
          kind: 'image',
          origin: 'inbound',
          local: { path: srcImgFile, format: 'png' },
        },
      ]),
    };
    db.saveMessage(imgRecord);
    const shortImgId = (imgRecord as any).short_id as string;
    expect(shortImgId).toBe('msg_1');

    // 传入原始长 ROBOT1.0_... 必须拒绝
    const resRejectLong = await collectFace(
      {
        message_id: 'ROBOT1.0_IMG_88881',
        tags: ['猫猫'],
        mood: '搞笑',
      },
      { db, peer: USER_PEER, faceDir }
    );
    expect(resRejectLong.success).toBe(false);
    expect(resRejectLong.error).toContain('msg_12');
    assertNoUndefinedFields(resRejectLong);

    // 传入短消息 ID msg_1 成功收藏
    const res = await collectFace(
      {
        message_id: shortImgId,
        tags: ['猫猫', '喝水'],
        mood: '搞笑',
      },
      {
        db,
        peer: USER_PEER,
        faceDir,
      }
    );

    expect(res.success).toBe(true);
    expect(res.face_id).toBeDefined();
    assertNoUndefinedFields(res);

    const storedFace = db.getFaceById(res.face_id!);
    expect(storedFace).toBeDefined();
    expect(storedFace?.md5).toBe(imgMd5);
    expect(storedFace?.tags).toEqual(['猫猫', '喝水']);
    expect(storedFace?.mood).toBe('搞笑');
    expect(fs.existsSync(storedFace!.file_path)).toBe(true);

    // 验证省略 message_id 时走 inboundMsgIdGetter(peer) 获取内部 ROBOT1.0_... 锚点或短 ID
    const resGetter = await collectFace(
      {
        tags: ['新标签'],
        mood: '开心',
      },
      {
        db,
        peer: USER_PEER,
        faceDir,
        inboundMsgIdGetter: () => 'ROBOT1.0_IMG_88881',
      }
    );
    expect(resGetter.success).toBe(true);
    expect(resGetter.duplicated).toBe(true);

    // 验证省略 message_id 与 inboundMsgIdGetter 时自动兜底 readHistory + getMessageByShortId
    const resFallbackHistory = await collectFace(
      {
        tags: ['自动兜底'],
        mood: '开心',
      },
      {
        db,
        peer: USER_PEER,
        faceDir,
      }
    );
    expect(resFallbackHistory.success).toBe(true);
    expect(resFallbackHistory.duplicated).toBe(true);

    const collectTool = createCollectFaceTool();
    expect((collectTool.parameters as any)?.properties?.message_id?.description).toContain('msg_12');
  });

  it('契约 4.1: 混合媒体消息中收敛到图片，绝不把视频或普通文件当表情收藏', async () => {
    const mediaDir = path.join(tmpDir, 'mixed-media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const videoBytes = Buffer.from('fake-mp4-video-bytes');
    const videoPath = path.join(mediaDir, 'clip.mp4');
    fs.writeFileSync(videoPath, videoBytes);
    const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42]);
    const imgPath = path.join(mediaDir, 'cat.png');
    fs.writeFileSync(imgPath, imgBytes);
    const pdfPath = path.join(mediaDir, 'report.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.7-mixed');

    // 模拟历史合并转发消息：local_path 仍指向首个附件（视频），attachments 中同时含图片
    const mixedRecord = {
      msg_id: 'ROBOT1.0_MIXED_88001',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'forward',
      content: '混合媒体转发',
      raw: '{}',
      file_id: null,
      local_path: videoPath,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
      attachments: serializeAttachments([
        { kind: 'video', origin: 'inbound', local: { path: videoPath, format: 'mp4' } },
        {
          kind: 'file',
          origin: 'inbound',
          fileName: 'report.pdf',
          local: { path: pdfPath, format: 'pdf' },
        },
        { kind: 'image', origin: 'inbound', local: { path: imgPath, format: 'png' } },
      ]),
    };
    db.saveMessage(mixedRecord);
    const mixedId = (mixedRecord as any).short_id as string;

    const resMixed = await collectFace(
      { message_id: mixedId, tags: ['猫猫'], mood: '开心' },
      { db, peer: USER_PEER, faceDir }
    );
    expect(resMixed.success).toBe(true);
    assertNoUndefinedFields(resMixed);

    const stored = db.getFaceById(resMixed.face_id!);
    expect(stored?.md5).toBe(crypto.createHash('md5').update(imgBytes).digest('hex'));
    expect(stored?.format).toBe('png');
    expect(fs.readFileSync(stored!.file_path).equals(imgBytes)).toBe(true);
    expect(fs.readFileSync(stored!.file_path).equals(videoBytes)).toBe(false);

    // 纯视频消息：明确拒绝，绝不把视频转存为表情
    const videoRecord = {
      ...mixedRecord,
      msg_id: 'ROBOT1.0_VIDEO_ONLY_88002',
      type: 'video',
      content: '视频',
      local_path: videoPath,
      attachments: serializeAttachments([
        { kind: 'video', origin: 'inbound', local: { path: videoPath, format: 'mp4' } },
      ]),
    };
    db.saveMessage(videoRecord);
    const videoId = (videoRecord as any).short_id as string;
    const resVideo = await collectFace(
      { message_id: videoId, tags: ['猫猫'], mood: '开心' },
      { db, peer: USER_PEER, faceDir }
    );
    expect(resVideo.success).toBe(false);
    expect(resVideo.error).toContain('未找到图片或表情附件');
    assertNoUndefinedFields(resVideo);

    // 普通文件消息（.pdf）：同样拒绝
    const fileRecord = {
      ...mixedRecord,
      msg_id: 'ROBOT1.0_FILE_ONLY_88003',
      type: 'file',
      content: '文件',
      local_path: pdfPath,
      attachments: serializeAttachments([
        {
          kind: 'file',
          origin: 'inbound',
          fileName: 'report.pdf',
          local: { path: pdfPath, format: 'pdf' },
        },
      ]),
    };
    db.saveMessage(fileRecord);
    const fileId = (fileRecord as any).short_id as string;
    const resFile = await collectFace(
      { message_id: fileId, tags: ['猫猫'], mood: '开心' },
      { db, peer: USER_PEER, faceDir }
    );
    expect(resFile.success).toBe(false);
    expect(resFile.error).toContain('未找到图片或表情附件');
  });

  it('契约 5: collect_face 重复偷图时显式告知已存在与既有标签', async () => {
    const srcImgFile = path.join(tmpDir, 'dup_image.png');
    fs.writeFileSync(srcImgFile, 'duplicate-content-xyz');
    const imgMd5 = crypto.createHash('md5').update('duplicate-content-xyz').digest('hex');

    db.insertFace({
      id: 'existing_face_id',
      file_path: '/already/stored.png',
      md5: imgMd5,
      source: 'collect',
      tags: ['已有标签1', '已有标签2'],
      mood: '已知情绪',
      enabled: true,
      size: 100,
      format: 'png',
    });

    const dupRecord = {
      msg_id: 'ROBOT1.0_IMG_88882',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '',
      file_id: null,
      local_path: srcImgFile,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
    };
    db.saveMessage(dupRecord);

    const res = await collectFace(
      {
        message_id: (dupRecord as any).short_id,
        tags: ['新标签'],
        mood: '新情绪',
      },
      {
        db,
        peer: USER_PEER,
        faceDir,
      }
    );

    expect(res.success).toBe(true);
    expect(res.duplicated).toBe(true);
    expect(res.face_id).toBe('existing_face_id');
    expect(res.message).toMatch(/已在你的表情库中存在/);
    expect(res.message).toMatch(/已有标签1/);
  });

  it('契约 6: collect_face 参数校验 (缺少 tags/mood 或目标消息无图片时拒绝)', async () => {
    const resNoTags = await collectFace(
      { mood: '卖萌' } as any,
      { db, peer: USER_PEER, faceDir }
    );
    expect(resNoTags.success).toBe(false);
    expect(resNoTags.error).toMatch(/tags/);

    const txtRecord = {
      msg_id: 'ROBOT1.0_TXT_88883',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'text',
      content: '纯文本消息',
      raw: '纯文本消息',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
    };
    db.saveMessage(txtRecord);

    const resNoImg = await collectFace(
      {
        message_id: (txtRecord as any).short_id,
        tags: ['标签'],
        mood: '情绪',
      },
      { db, peer: USER_PEER, faceDir }
    );
    expect(resNoImg.success).toBe(false);
    expect(resNoImg.error).toMatch(/未找到图片/);
  });

  it('契约 7: 门控装配契约 (face_enabled 为 false 时不注册表情工具)', () => {
    const mockTools = {
      register: vi.fn(),
    };
    const mockCtx = {
      tools: mockTools,
    };

    registerAgentTools(mockCtx as any, {
      db,
      mediaManager: {} as any,
      config: () => ({ face_enabled: false } as any),
    } as any);

    const registeredNamesFalse = mockTools.register.mock.calls.map((call) => call[0].name);
    expect(registeredNamesFalse).not.toContain('list_faces');
    expect(registeredNamesFalse).not.toContain('send_face');
    expect(registeredNamesFalse).not.toContain('collect_face');
    expect(registeredNamesFalse).not.toContain('manage_faces');

    mockTools.register.mockClear();
    registerAgentTools(mockCtx as any, {
      db,
      mediaManager: {} as any,
      config: () => ({ face_enabled: true } as any),
    } as any);

    const registeredNamesTrue = mockTools.register.mock.calls.map((call) => call[0].name);
    expect(registeredNamesTrue).toContain('list_faces');
    expect(registeredNamesTrue).toContain('send_face');
    expect(registeredNamesTrue).toContain('collect_face');
    expect(registeredNamesTrue).toContain('manage_faces');
  });

  it('契约 8: manage_faces 支持传入 face_id 为已有表情补全/更新 tags 与 mood', async () => {
    db.insertFace({
      id: 'face_to_edit',
      file_path: '/path/to/img.png',
      md5: 'md5_to_edit',
      source: 'manual',
      tags: [],
      enabled: true,
      size: 100,
      format: 'png',
    });

    const failNoTags = await manageFaces(
      { action: 'update', face_id: 'face_to_edit' } as any,
      { db }
    );
    expect(failNoTags.success).toBe(false);
    expect(failNoTags.error).toMatch(/tags 或 mood/);

    const successEdit = await manageFaces(
      {
        action: 'update',
        face_id: 'face_to_edit',
        tags: ['新打标猫猫', '喝水'],
        mood: '呆萌',
      },
      { db }
    );
    expect(successEdit.success).toBe(true);
    expect(successEdit.face_id).toBe('face_to_edit');
    assertNoUndefinedFields(successEdit);

    const edited = db.getFaceById('face_to_edit');
    expect(edited?.tags).toEqual(['新打标猫猫', '喝水']);
    expect(edited?.mood).toBe('呆萌');
  });

  it('契约 9: 达到容量上限且为 reject 策略时，collect_face 友好返回错误对象而非崩溃抛错', async () => {
    db.insertFace(
      {
        id: 'f1',
        file_path: '/f1.png',
        md5: 'md5_1',
        source: 'manual',
        tags: ['1'],
        enabled: true,
        size: 10,
        format: 'png',
      },
      { max: 2, evictPolicy: 'reject' }
    );

    db.insertFace(
      {
        id: 'f2',
        file_path: '/f2.png',
        md5: 'md5_2',
        source: 'manual',
        tags: ['2'],
        enabled: true,
        size: 10,
        format: 'png',
      },
      { max: 2, evictPolicy: 'reject' }
    );

    const newImg = path.join(tmpDir, 'new_img.png');
    fs.writeFileSync(newImg, 'new-img-data');

    const capRecord = {
      msg_id: 'ROBOT1.0_IMG_99901',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '',
      file_id: null,
      local_path: newImg,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
    };
    db.saveMessage(capRecord);

    const res = await collectFace(
      {
        message_id: (capRecord as any).short_id,
        tags: ['新表情'],
        mood: '开心',
      },
      {
        db,
        peer: USER_PEER,
        faceDir,
        faceStoreMax: 2,
        faceEvictPolicy: 'reject',
      }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/配额容量上限/);
    assertNoUndefinedFields(res);
  });

  it('契约 10: list_faces 返回结果必须严格满足 DSH Lossless JSON 约束', async () => {
    db.insertFace({
      id: 'face_untagged_1',
      file_path: '/path/untagged.png',
      md5: 'md5_untagged',
      source: 'manual',
      tags: [],
      enabled: true,
      size: 512,
      format: 'png',
    });

    const res = await listFaces({}, { db });

    expect(res.faces).toHaveLength(1);
    expect(res.faces[0]!.id).toBe('face_untagged_1');
    expect(Object.hasOwn(res, 'next_cursor')).toBe(false);
    expect(Object.hasOwn(res.faces[0]!, 'mood')).toBe(false);
    assertNoUndefinedFields(res);

    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const dshToolsPkg = require.resolve('@deepseek-ai/dsh-tools/package.json');
    const dshToolsRequire = createRequire(dshToolsPkg);
    const { isJsonValue, snapshotJsonValue } = dshToolsRequire('@deepseek-ai/dsh-util-values');

    expect(isJsonValue(res)).toBe(true);
    const snapshot = snapshotJsonValue(res);
    expect(snapshot).toBeDefined();
  });
});
