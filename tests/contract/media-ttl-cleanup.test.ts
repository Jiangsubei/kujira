import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MediaStorageManager,
  cleanExpiredMedia,
  startMediaCleanupTask,
  detectBufferExt,
  sanitizeUrlForLog,
} from '../../src/storage/media.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = '0123456789ABCDEF0123456789ABCDEF';
const MOCK_PEER = openidToPeer(MOCK_OPENID);

describe('契约测试: 入站媒体 TTL 清理、魔数识别与 URL 脱敏 (Media TTL & Security Contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MessageDatabase;
  let mediaManager: MediaStorageManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-media-ttl-test-'));
    dbPath = path.join(tmpDir, 'test-msg.db');
    db = new MessageDatabase(dbPath);
    mediaManager = new MediaStorageManager({
      downloadDir: tmpDir,
      db,
      ttlDays: 7,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    try {
      db.close();
    } catch {}
    if (tmpDir && fs.existsSync(tmpDir)) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 一级去重命中时自动刷新文件 mtime，实现 TTL 活跃续期', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const fileId = 'file_dedup_l1_test';

    const res1 = await mediaManager.saveBuffer(pngBuffer, { fileId, type: 'image', sessionId: MOCK_PEER });
    expect(res1.deduplicated).toBe(false);
    expect(fs.existsSync(res1.localPath)).toBe(true);

    db.saveMessage({
      msg_id: 'ROBOT1.0_1001',
      peer: MOCK_PEER,
      user_id: MOCK_OPENID,
      sender_name: 'test',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '{}',
      file_id: fileId,
      local_path: res1.localPath,
      fingerprint: res1.fingerprint,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const fiveDaysAgoSec = (Date.now() - 5 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(res1.localPath, fiveDaysAgoSec, fiveDaysAgoSec);

    const beforeSaveNow = Date.now();
    const res2 = await mediaManager.saveBuffer(pngBuffer, { fileId, type: 'image', sessionId: MOCK_PEER });
    expect(res2.deduplicated).toBe(true);
    expect(res2.level).toBe(1);
    expect(res2.localPath).toBe(res1.localPath);

    const statAfter = await fsp.stat(res1.localPath);
    expect(statAfter.mtimeMs).toBeGreaterThanOrEqual(beforeSaveNow - 1000);
  });

  it('契约 2: 二级指纹去重命中时自动刷新文件 mtime，实现 TTL 活跃续期', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x09, 0x08]);

    const res1 = await mediaManager.saveBuffer(pngBuffer, { type: 'image', sessionId: MOCK_PEER });
    expect(res1.deduplicated).toBe(false);

    db.saveMessage({
      msg_id: 'ROBOT1.0_2001',
      peer: MOCK_PEER,
      user_id: MOCK_OPENID,
      sender_name: 'test',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '{}',
      file_id: 'origin_fid',
      local_path: res1.localPath,
      fingerprint: res1.fingerprint,
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const sixDaysAgoSec = (Date.now() - 6 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(res1.localPath, sixDaysAgoSec, sixDaysAgoSec);

    const beforeSaveNow = Date.now();
    const res2 = await mediaManager.saveBuffer(pngBuffer, { fileId: 'different_fid_2', type: 'image' });
    expect(res2.deduplicated).toBe(true);
    expect(res2.level).toBe(2);
    expect(res2.localPath).toBe(res1.localPath);

    const statAfter = await fsp.stat(res1.localPath);
    expect(statAfter.mtimeMs).toBeGreaterThanOrEqual(beforeSaveNow - 1000);
  });

  it('契约 3: cleanExpiredMedia 正确按 mtime 与 ttlDays 清理超期文件并更新数据库', async () => {
    const targetDir = path.join(tmpDir, 'image');
    await fsp.mkdir(targetDir, { recursive: true });

    const expiredFile = path.join(targetDir, 'expired.png');
    const freshFile = path.join(targetDir, 'fresh.png');
    await fsp.writeFile(expiredFile, 'expired-data');
    await fsp.writeFile(freshFile, 'fresh-data');

    db.saveMessage({
      msg_id: 'ROBOT1.0_3001',
      peer: MOCK_PEER,
      user_id: MOCK_OPENID,
      sender_name: 'test',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '{}',
      file_id: 'fid_expired',
      local_path: expiredFile,
      fingerprint: 'hash_expired',
      recalled: 0,
      self: 0,
      reply_to: null,
    });
    db.saveMessage({
      msg_id: 'ROBOT1.0_3002',
      peer: MOCK_PEER,
      user_id: MOCK_OPENID,
      sender_name: 'test',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '{}',
      file_id: 'fid_fresh',
      local_path: freshFile,
      fingerprint: 'hash_fresh',
      recalled: 0,
      self: 0,
      reply_to: null,
    });

    const eightDaysAgoSec = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(expiredFile, eightDaysAgoSec, eightDaysAgoSec);

    const twoDaysAgoSec = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    await fsp.utimes(freshFile, twoDaysAgoSec, twoDaysAgoSec);

    const result = await cleanExpiredMedia(tmpDir, 7, db);
    expect(result.deletedFiles).toBe(1);
    expect(fs.existsSync(expiredFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);

    const expiredRecord = db.getByFileId('fid_expired');
    expect(expiredRecord?.local_path).toBeFalsy();
    const freshRecord = db.getByFileId('fid_fresh');
    expect(freshRecord?.local_path).toBe(freshFile);
  });

  it('契约 4: startMediaCleanupTask 支持启动初期延迟执行首轮清理并支持生命周期清理', async () => {
    let cleanCalled = 0;
    const mockManager = {
      cleanExpired: async () => {
        cleanCalled++;
        return { deletedFiles: 0, freedBytes: 0 };
      },
    } as any;

    const disposedCallbacks: Array<() => void> = [];
    const mockCtx = {
      logger: { error: vi.fn() },
      on: (event: string, cb: () => void) => {
        if (event === 'dispose') {
          disposedCallbacks.push(cb);
        }
      },
    };

    const stop = startMediaCleanupTask(mockCtx, mockManager, 60000, 20);
    expect(cleanCalled).toBe(0);

    await new Promise((r) => setTimeout(r, 60));
    expect(cleanCalled).toBe(1);

    stop();
  });

  it('契约 5: detectBufferExt 与 saveBuffer 正确识别 WAV / AMR / OGG / M4A / MP4 魔数及 voice/video 目录', async () => {
    const wavBuf = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
    const amrBuf = Buffer.from('#!AMR\n\x00\x01\x02\x03');
    const oggBuf = Buffer.from('OggS\x00\x02\x00\x00');
    const m4aBuf = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypM4A '), Buffer.alloc(8)]);
    const mp4Buf = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(8)]);

    expect(detectBufferExt(wavBuf)).toBe('wav');
    expect(detectBufferExt(amrBuf)).toBe('amr');
    expect(detectBufferExt(oggBuf)).toBe('ogg');
    expect(detectBufferExt(m4aBuf)).toBe('m4a');
    expect(detectBufferExt(mp4Buf)).toBe('mp4');

    const savedWav = await mediaManager.saveBuffer(wavBuf, { type: 'voice', sessionId: MOCK_PEER });
    expect(savedWav.localPath).toContain(path.join('voice', MOCK_PEER));
    expect(savedWav.localPath.endsWith('.wav')).toBe(true);

    const savedAmr = await mediaManager.saveBuffer(amrBuf, {
      type: 'voice',
      sessionId: MOCK_PEER,
      filename: 'voice_clip.mp3',
    });
    expect(savedAmr.localPath.endsWith('.amr')).toBe(true);

    const savedMp4 = await mediaManager.saveBuffer(mp4Buf, { type: 'video', sessionId: MOCK_PEER });
    expect(savedMp4.localPath).toContain(path.join('video', MOCK_PEER));
    expect(savedMp4.localPath.endsWith('.mp4')).toBe(true);
  });

  it('契约 6: downloadAndSave 裸 GET 下载（不带鉴权头）、不采信错误 Content-Type，且异常与日志严禁暴露 query 凭证', async () => {
    expect(
      sanitizeUrlForLog('https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=SECRET_RKEY_999&spec=0#hash')
    ).toBe('https://multimedia.nt.qq.com.cn/download');

    // 场景 A: 服务端返回错误的 audio/mp3 Content-Type，但实际字节流为 #!AMR
    const amrBytes = Buffer.from('#!AMR\n\x04\x05\x06');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mp3' }),
      arrayBuffer: async () => amrBytes.buffer.slice(amrBytes.byteOffset, amrBytes.byteOffset + amrBytes.byteLength),
    });
    vi.stubGlobal('fetch', fetchMock);

    const signedUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=TOP_SECRET_KEY';
    const saved = await mediaManager.downloadAndSave(signedUrl, {
      type: 'voice',
      sessionId: MOCK_PEER,
      filename: 'raw_voice.amr',
    });

    // 验证裸 GET（无 second options 参数 / 无 Authorization 头）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([signedUrl]);
    expect(saved.localPath.endsWith('.amr')).toBe(true);

    // 场景 B: HTTP 下载失败时，异常消息必须剥离 ?rkey=... 凭证
    const failFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', failFetch);

    await expect(mediaManager.downloadAndSave(signedUrl, { type: 'image' })).rejects.toThrow(
      /https:\/\/multimedia\.nt\.qq\.com\.cn\/download/
    );
    await expect(mediaManager.downloadAndSave(signedUrl, { type: 'image' })).rejects.not.toThrow(/TOP_SECRET_KEY|rkey=/);
  });

  it('契约 7: 落盘文件名执行 path.basename 与危险字符净化，并基于 path.relative 拦截路径穿越', async () => {
    const buf = Buffer.from('safe-content');
    const res = await mediaManager.saveBuffer(buf, {
      type: 'files',
      sessionId: MOCK_PEER,
      filename: '../../etc/sub\\report:2026?.txt',
    });

    const expectedDir = path.resolve(mediaManager.getDownloadDir('files', MOCK_PEER));
    expect(path.dirname(res.localPath)).toBe(expectedDir);
    expect(path.basename(res.localPath)).toBe('report_2026_.txt');

    await expect(
      mediaManager.saveBuffer(buf, {
        type: 'files',
        sessionId: MOCK_PEER,
        filename: '..',
      })
    ).rejects.toThrow(/路径穿越/);
  });
});
