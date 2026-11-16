/**
 * 契约测试: send_file 文件源归一化、四类媒体映射、四步分片上传下发与短出站 ID 契约
 *
 * 覆盖规范:
 * - 支持 本地绝对路径 / file:// URI / http(s):// URL / base64:// & data:;base64 四种形态；
 * - file_type 支持 'image' | 'file' | 'video' | 'voice'，映射到 QQMediaFileType (1/4/2/3)；
 * - 经 OutboundStreamBridge.sendMediaReply 完成 uploadC2CMedia + msg_type=7 下发，通过 resolveOutboundShortId 返回短出站 ID msg_self_<n>（无 ref_idx，绝不暴露 ROBOT1.0_...）；
 * - HTTP 拉取报错脱敏去 query 凭证，不泄漏 token / rkey；无 gateway/peer 或不存在文件绝不假成功。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageDatabase } from '../../src/storage/database.js';
import { recordOutboundSelfMessage } from '../../src/outbound/self-record.js';
import { sendFile, createSendFileTool } from '../../src/tools/index.js';
import {
  classifySendFileSource,
  detectSendFileType,
} from '../../src/tools/file-source.js';
import { openidToPeer } from '../../src/utils/peer.js';
import {
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
  QQ_MSG_TYPE_MEDIA,
} from '../../src/constants/index.js';

const MOCK_OPENID = 'CCCCDDDDEEEEFFFF0000111122223333';
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

function stubGateway(overrides: Record<string, any> = {}, targetDb?: MessageDatabase) {
  const uploadCalls: Array<{ openid: string; size: number; options: any }> = [];
  const sendCalls: Array<{ openid: string; payload: any; meta: any }> = [];
  let outSeq = 1000;

  const gateway = {
    uploadC2CMedia: vi.fn(async (openid: string, bytes: Uint8Array, options: any) => {
      uploadCalls.push({ openid, size: bytes.length, options });
      return {
        ok: true,
        status: 200,
        body: {
          file_uuid: 'uuid_mock_001',
          file_info: 'file_info_mock_001',
          ttl: 86400,
        },
      };
    }),
    sendC2CMessage: vi.fn(async (openid: string, payload: any, meta: any) => {
      sendCalls.push({ openid, payload, meta });
      outSeq += 1;
      const rawId = `ROBOT1.0_MEDIA_OUT_${outSeq}`;
      const refIdx = `REFIDX_MEDIA_${outSeq}`;
      if (targetDb) {
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
          { db: targetDb, botId: '1000000000', senderName: 'Kujira' }
        );
      }
      return {
        ok: true,
        status: 200,
        body: {
          id: rawId,
          ext_info: { ref_idx: refIdx },
        },
      };
    }),
    sendInputNotify: vi.fn(),
    deleteC2CMessage: vi.fn(),
    emitMessageSent: vi.fn(),
    ...overrides,
  };

  return { gateway, uploadCalls, sendCalls };
}

describe('契约测试: send_file 四形态归一化与四步上传下发', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-send-file-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('契约 1: base64:// 与 data:...;base64, 解码 Buffer 并上传下发（仅返回短出站 ID 且绝不暴露长 ID）', async () => {
    const { gateway, uploadCalls, sendCalls } = stubGateway({}, db);

    const resB64 = await sendFile(
      { file_path: 'base64://aGVsbG8=' },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway, db }
    );
    expect(resB64.success).toBe(true);
    expect(resB64.message_id).toBe('msg_self_1');
    expect((resB64 as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(resB64);
    expect(uploadCalls[0]!.options.fileType).toBe(QQ_FILE_TYPE_FILE);
    expect(sendCalls[0]!.payload).toMatchObject({
      msg_type: QQ_MSG_TYPE_MEDIA,
      media: { file_info: 'file_info_mock_001' },
    });

    const pngHeaderB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const resDataUri = await sendFile(
      { file_path: `data:image/png;base64,${pngHeaderB64}` },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway, db }
    );
    expect(resDataUri.success).toBe(true);
    expect(resDataUri.message_id).toBe('msg_self_2');
    expect(uploadCalls[1]!.options.fileType).toBe(QQ_FILE_TYPE_IMAGE);

    // 若简化测试未挂载 db 落库，则省略 message_id 绝不泄露 ROBOT1.0_...
    const { gateway: noDbGw } = stubGateway();
    const resNoDb = await sendFile(
      { file_path: 'base64://aGVsbG8=' },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway: noDbGw }
    );
    expect(resNoDb.success).toBe(true);
    expect(resNoDb.message_id).toBeUndefined();
    assertNoUndefinedFields(resNoDb);

    // 验证 tool.output.render 仅渲染短 ID，不拼 ref_idx
    const tool = createSendFileTool({ peer: USER_PEER, openid: MOCK_OPENID, gateway, db });
    expect((tool as any).output.render({}, { success: true, message_id: 'msg_self_1' })[0].text).toBe(
      '文件发送成功 (ID: msg_self_1)'
    );
    expect((tool as any).output.render({}, { success: true })[0].text).toBe('文件发送成功');
  });

  it('契约 2: 本地绝对路径与 file:// URI 校验读取并正确映射四类文件类型', async () => {
    const imgPath = path.join(tmpDir, 'chart.png');
    const vidPath = path.join(tmpDir, 'clip.mp4');
    const wavPath = path.join(tmpDir, 'voice.wav');
    const docPath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    fs.writeFileSync(vidPath, Buffer.from('fake-mp4-data'));
    fs.writeFileSync(wavPath, Buffer.from('RIFF1234WAVE'));
    fs.writeFileSync(docPath, Buffer.from('%PDF-1.4'));

    const { gateway, uploadCalls } = stubGateway();

    const rImg = await sendFile(
      { file_path: pathToFileURL(imgPath).href },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );
    const rVid = await sendFile(
      { file_path: vidPath },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );
    const rVoice = await sendFile(
      { file_path: wavPath },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );
    const rDoc = await sendFile(
      { file_path: docPath },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );

    expect(rImg.success).toBe(true);
    expect(rVid.success).toBe(true);
    expect(rVoice.success).toBe(true);
    expect(rDoc.success).toBe(true);

    expect(uploadCalls.map((c) => c.options.fileType)).toEqual([
      QQ_FILE_TYPE_IMAGE,
      QQ_FILE_TYPE_VIDEO,
      QQ_FILE_TYPE_AUDIO,
      QQ_FILE_TYPE_FILE,
    ]);
  });

  it('契约 3: file_type 参数强制覆盖扩展名推导', async () => {
    const docPath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(docPath, 'fake-content');
    const { gateway, uploadCalls } = stubGateway();

    const res = await sendFile(
      { file_path: docPath, file_type: 'image' },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );
    expect(res.success).toBe(true);
    expect(uploadCalls[0]!.options.fileType).toBe(QQ_FILE_TYPE_IMAGE);

    const pngPath = path.join(tmpDir, 'photo.png');
    fs.writeFileSync(pngPath, 'fake-png');
    const resAsFile = await sendFile(
      { file_path: pngPath, file_type: 'file' },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );
    expect(resAsFile.success).toBe(true);
    expect(uploadCalls[1]!.options.fileType).toBe(QQ_FILE_TYPE_FILE);
  });

  it('契约 4: http(s):// URL 拉取字节流上传；拉取失败时报错脱敏去 query 凭证', async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/ok.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { gateway, uploadCalls } = stubGateway();

      // 1. 成功拉取并识别为 image
      const okRes = await sendFile(
        { file_path: `${baseUrl}/ok.png?rkey=SECRET_TOKEN_XYZ` },
        { peer: USER_PEER, openid: MOCK_OPENID, gateway }
      );
      expect(okRes.success).toBe(true);
      expect(uploadCalls[0]!.options.fileType).toBe(QQ_FILE_TYPE_IMAGE);

      // 2. 404 错误必须剥离 query 凭证
      const failRes = await sendFile(
        { file_path: `${baseUrl}/missing.png?rkey=TOP_SECRET_CREDENTIAL` },
        { peer: USER_PEER, openid: MOCK_OPENID, gateway }
      );
      expect(failRes.success).toBe(false);
      expect(failRes.error).toContain('404');
      expect(failRes.error).not.toContain('TOP_SECRET_CREDENTIAL');
      expect(failRes.error).not.toContain('rkey=');
      assertNoUndefinedFields(failRes);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('契约 5: 错误分层 —— 无 gateway/peer、本地路径不存在、上传/发送失败与缺少 body.id 绝不假成功', async () => {
    // 1. 无 peer/gateway
    const noCtx = await sendFile({ file_path: 'https://example.com/a.pdf' });
    expect(noCtx.success).toBe(false);
    expect(noCtx.message_id).toBeUndefined();
    assertNoUndefinedFields(noCtx);

    // 2. 拒绝群聊 peer
    const { gateway } = stubGateway();
    const groupRes = await sendFile(
      { file_path: 'https://example.com/a.pdf' },
      { peer: 'group_3000000001', gateway }
    );
    expect(groupRes.success).toBe(false);
    assertNoUndefinedFields(groupRes);

    // 3. 本地路径不存在
    const missing = path.join(tmpDir, 'definitely-missing-98765.txt');
    const missRes = await sendFile(
      { file_path: missing },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway }
    );
    expect(missRes.success).toBe(false);
    expect(missRes.error).toContain('本地路径不存在');
    expect(gateway.uploadC2CMedia).not.toHaveBeenCalled();

    // 4. 上传失败透传错误
    const failUploadGw = stubGateway({
      uploadC2CMedia: async () => ({
        ok: false,
        status: 400,
        code: 850019,
        message: '富媒体文件格式不支持',
        body: null,
      }),
    }).gateway;
    const realFile = path.join(tmpDir, 'test.bin');
    fs.writeFileSync(realFile, 'abc');
    const upFail = await sendFile(
      { file_path: realFile },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway: failUploadGw }
    );
    expect(upFail.success).toBe(false);
    expect(upFail.error).toContain('富媒体文件格式不支持');

    // 5. 成功但缺少 body.id 绝不写死假 ID
    const noIdGw = stubGateway({
      sendC2CMessage: async () => ({ ok: true, status: 200, body: {} }),
    }).gateway;
    const noIdRes = await sendFile(
      { file_path: realFile },
      { peer: USER_PEER, openid: MOCK_OPENID, gateway: noIdGw }
    );
    expect(noIdRes.success).toBe(false);
    expect(noIdRes.error).toContain('message_id');
  });
});

describe('契约测试: classifySendFileSource 与 detectSendFileType 单元', () => {
  it('四形态识别与四种媒体类型推导（无 WSL /mnt/ 翻译逻辑）', () => {
    const b64 = classifySendFileSource('base64://aGVsbG8=');
    expect('source' in b64 && b64.source.kind).toBe('base64');

    const dataUri = classifySendFileSource('data:video/mp4;base64,aGVsbG8=');
    expect('source' in dataUri && dataUri.source).toMatchObject({
      kind: 'base64',
      mimeType: 'video/mp4',
    });

    const url = classifySendFileSource('https://example.com/a.png?x=1');
    expect('source' in url && url.source).toMatchObject({
      kind: 'url',
      value: 'https://example.com/a.png?x=1',
      fileName: 'a.png',
    });

    const tmpFile = path.join(os.tmpdir(), 'kujira-classify-check.txt');
    const fileUri = classifySendFileSource(pathToFileURL(tmpFile).href);
    expect('source' in fileUri && fileUri.source).toMatchObject({
      kind: 'file-uri',
      localPath: path.resolve(tmpFile),
    });

    const rel = classifySendFileSource('relative/path.txt');
    expect('error' in rel).toBe(true);

    expect(detectSendFileType('voice', 'https://example.com/a.png')).toBe('voice');
    expect(detectSendFileType('video', 'https://example.com/a.png')).toBe('video');
    expect(detectSendFileType(undefined, 'https://example.com/a.png')).toBe('image');
    expect(detectSendFileType(undefined, 'https://example.com/clip.mp4')).toBe('video');
    expect(detectSendFileType(undefined, 'https://example.com/audio.wav')).toBe('voice');
    expect(detectSendFileType(undefined, 'https://example.com/doc.pdf')).toBe('file');
  });
});
