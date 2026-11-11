/**
 * 契约测试: 单聊资源抓取 (fetch_chat_resource) 与官方合并转发展开 (expand_forward_message)
 *
 * 覆盖规范:
 * - fetch_chat_resource:
 *   1. 移除 busid / group_id / group-file-resolve / private-file / SnowLuma / get_file；
 *   2. db.getByFileId 一级去重命中 local_path 直接复用；
 *   3. 未落盘时从 attachments JSON (deserializeAttachments) 查找 descriptor 的 local.path 或直链
 *      (voice 优先 voiceWavUrl，其余取 remote.url) 裸 GET 落盘并写回 db.updateLocalPath；
 *   4. 无可用直链时明确提示「资源直链不存在或已过期，QQ 官方 Bot API 不支持按 file_id 事后刷新旧资源链接」；
 *   5. 报错与结果严禁泄漏带 query 凭证 (rkey/token/sig) 的完整 URL；
 *   6. 批量 files[] 支持 Partial Success 与 inFlightDownloads 并发去重；
 * - expand_forward_message:
 *   7. 适配官方 message_type=102 已展开合并转发，按 msg_id / forward_id / content 解析 ForwardNode[]；
 *   8. 调用 resolveEmbeddedForwardImages 限量落盘内嵌图片（上限 10 张）并将 URL 脱敏替换，绝不泄露 rkey。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fetchChatResource,
  expandForwardMessage,
  createFetchChatResourceTool,
  inFlightDownloads,
} from '../../src/tools/index.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { MediaStorageManager } from '../../src/storage/media.js';
import { serializeAttachments } from '../../src/attachment/store.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'DDDDEEEEFFFF00001111222233334444';
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

describe('契约测试: fetch_chat_resource 与 expand_forward_message (QQ 官方 C2C 单聊)', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(() => {
    inFlightDownloads.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-res-fetch-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
  });

  afterEach(() => {
    inFlightDownloads.clear();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function stubMedia() {
    const mediaCalls: Array<{ urlOrPath: string; opts: any }> = [];
    const mediaManager = {
      downloadAndSave: vi.fn(async (urlOrPath: string, opts: any) => {
        mediaCalls.push({ urlOrPath, opts });
        const ext = opts?.ext || 'dat';
        const outDir = path.join(tmpDir, 'downloads', opts?.type || 'files');
        fs.mkdirSync(outDir, { recursive: true });
        const savedPath = path.join(outDir, opts?.filename || `dl_${mediaCalls.length}.${ext}`);
        fs.writeFileSync(savedPath, 'mock-binary');
        return {
          localPath: savedPath,
          fingerprint: `fp-${mediaCalls.length}`,
          deduplicated: false,
          md5: `md5-${mediaCalls.length}`,
        };
      }),
    } as unknown as MediaStorageManager;
    return { mediaManager, mediaCalls };
  }

  it('契约 1: createFetchChatResourceTool 参数表中彻底移除 busid，msg_id 说明指向短消息 ID', () => {
    const tool = createFetchChatResourceTool();
    const props = (tool.parameters as any)?.properties;
    expect(props?.busid).toBeUndefined();
    expect(props?.files?.items?.properties?.busid).toBeUndefined();
    expect(props?.file_id).toBeDefined();
    expect(props?.msg_id).toBeDefined();
    expect(props?.msg_id?.description).toContain('msg_12');
    expect(props?.url).toBeDefined();
  });

  it('契约 2: 一级缓存命中 —— db.getByFileId 或短 msg_id (getMessageByShortId) 已有 local_path 直接复用，严禁按长 ID 兜底', async () => {
    const cachedFile = path.join(tmpDir, 'cached.pdf');
    fs.writeFileSync(cachedFile, 'cached-pdf');

    const cachedRec = {
      msg_id: 'ROBOT1.0_CACHED_1',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'file',
      content: `[文件:cached.pdf 已保存: ${cachedFile}]`,
      raw: '{}',
      file_id: 'file_cached_001',
      local_path: cachedFile,
      fingerprint: 'fp_cached',
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
    };
    db.saveMessage(cachedRec);

    const { mediaManager, mediaCalls } = stubMedia();
    const res = await fetchChatResource(
      { file_id: 'file_cached_001' },
      { peer: USER_PEER, db, mediaManager }
    );

    expect(res.success).toBe(true);
    expect(res.local_path).toBe(cachedFile);
    expect(mediaCalls).toHaveLength(0);
    assertNoUndefinedFields(res);

    // 传入短消息 ID msg_1 成功通过 getMessageByShortId 命中缓存
    const resByShortMsgId = await fetchChatResource(
      { msg_id: (cachedRec as any).short_id },
      { peer: USER_PEER, db, mediaManager }
    );
    expect(resByShortMsgId.success).toBe(true);
    expect(resByShortMsgId.local_path).toBe(cachedFile);
    assertNoUndefinedFields(resByShortMsgId);

    // 传入原始长 msg_id 不兼容兜底 getMessage，直接报错
    const resByLongMsgId = await fetchChatResource(
      { msg_id: 'ROBOT1.0_CACHED_1' },
      { peer: USER_PEER, db, mediaManager }
    );
    expect(resByLongMsgId.success).toBe(false);
    expect(resByLongMsgId.error).toContain('msg_12');
    assertNoUndefinedFields(resByLongMsgId);

    const resByLongFileId = await fetchChatResource(
      { file_id: 'ROBOT1.0_CACHED_1' },
      { peer: USER_PEER, db, mediaManager }
    );
    expect(resByLongFileId.success).toBe(false);
    assertNoUndefinedFields(resByLongFileId);
  });

  it('契约 3: 从 attachments JSON 提取直链裸 GET 落盘（语音优先 voiceWavUrl）并回写 db.updateLocalPath', async () => {
    const attachmentsJson = serializeAttachments([
      {
        kind: 'record',
        origin: 'inbound',
        fileName: 'clip.amr',
        remote: {
          fileId: 'voice_file_001',
          contentType: 'voice',
          url: 'https://multimedia.nt.qq.com.cn/download?rkey=RAW_AMR_SECRET',
          voiceWavUrl: 'https://qqbot.ugcimg.cn/voice/converted.wav?rkey=WAV_SECRET',
          asrReferText: '你好呀',
        },
      },
    ]);

    db.saveMessage({
      msg_id: 'ROBOT1.0_VOICE_1',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'record',
      content: '[语音 (语音转文字: "你好呀")]',
      raw: '{}',
      file_id: 'voice_file_001',
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: attachmentsJson,
    });

    const { mediaManager, mediaCalls } = stubMedia();
    const res = await fetchChatResource(
      { file_id: 'voice_file_001' },
      { peer: USER_PEER, db, mediaManager }
    );

    expect(res.success).toBe(true);
    expect(res.local_path).toBeDefined();
    expect(fs.existsSync(res.local_path!)).toBe(true);
    assertNoUndefinedFields(res);

    // 验证优先拉取 voiceWavUrl，且落盘 sessionId 为 user_<hash>
    expect(mediaCalls).toHaveLength(1);
    expect(mediaCalls[0]!.urlOrPath).toBe('https://qqbot.ugcimg.cn/voice/converted.wav?rkey=WAV_SECRET');
    expect(mediaCalls[0]!.opts.type).toBe('voice');
    expect(mediaCalls[0]!.opts.sessionId).toBe(USER_PEER);

    // 验证写回 db.local_path
    const updated = db.getMessage('ROBOT1.0_VOICE_1');
    expect(updated?.local_path).toBe(res.local_path);
    expect(updated?.fingerprint).toBe('fp-1');
  });

  it('契约 4: 无可用直链时明确提示官方 Bot API 不支持按 file_id 事后刷新旧资源链接', async () => {
    const res = await fetchChatResource(
      { file_id: 'expired_or_missing_id' },
      { peer: USER_PEER, db }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('QQ 官方 Bot API 不支持按 file_id 事后刷新旧资源链接');
    assertNoUndefinedFields(res);
  });

  it('契约 5: 下载异常时报错严格脱敏，绝不泄漏 query 凭证 (rkey / token / sig)', async () => {
    const { mediaManager } = stubMedia();
    (mediaManager.downloadAndSave as any).mockRejectedValueOnce(
      new Error('HTTP 下载失败 (status: 403): https://multimedia.nt.qq.com.cn/download?rkey=LEAK_FORBIDDEN_999&sig=SECRET_SIG')
    );

    const res = await fetchChatResource(
      {
        file_id: 'https://multimedia.nt.qq.com.cn/download?rkey=LEAK_FORBIDDEN_999&sig=SECRET_SIG',
      },
      { peer: USER_PEER, db, mediaManager }
    );

    expect(res.success).toBe(false);
    expect(res.error).not.toContain('LEAK_FORBIDDEN_999');
    expect(res.error).not.toContain('SECRET_SIG');
    expect(res.error).not.toContain('rkey=');
    expect(res.results?.[0]?.file_id).not.toContain('LEAK_FORBIDDEN_999');
    assertNoUndefinedFields(res);
  });

  it('契约 6: 批量 files[] 支持部分成功 (Partial Success) 且并发同 file_id 共享 inFlightDownloads', async () => {
    const { mediaManager, mediaCalls } = stubMedia();
    db.saveMessage({
      msg_id: 'ROBOT1.0_IMG_OK',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      raw: '{}',
      file_id: 'img_ok_1',
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq',
      attachments: serializeAttachments([
        {
          kind: 'image',
          origin: 'inbound',
          fileName: 'pic.png',
          remote: {
            fileId: 'img_ok_1',
            url: 'https://multimedia.nt.qq.com.cn/download?rkey=IMG_OK_KEY',
          },
        },
      ]),
    });

    // 批量混合成功与无直链失败
    const batchRes = await fetchChatResource(
      {
        files: [
          { file_id: 'img_ok_1', file_name: 'pic.png' },
          { file_id: 'img_missing_2', file_name: 'gone.png' },
        ],
      },
      { peer: USER_PEER, db, mediaManager }
    );

    expect(batchRes.success).toBe(true);
    expect(batchRes.total).toBe(2);
    expect(batchRes.downloaded_count).toBe(1);
    expect(batchRes.results?.[0]?.success).toBe(true);
    expect(batchRes.results?.[1]?.success).toBe(false);
    assertNoUndefinedFields(batchRes);

    // Single-Flight 并发去重测试
    let resolveDelayed!: (val: any) => void;
    const delayedMedia = {
      downloadAndSave: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveDelayed = resolve;
          })
      ),
    } as unknown as MediaStorageManager;

    const p1 = fetchChatResource(
      { file_id: 'single_flight_1', url: 'https://example.com/a.bin' },
      { peer: USER_PEER, mediaManager: delayedMedia }
    );
    const p2 = fetchChatResource(
      { file_id: 'single_flight_1', url: 'https://example.com/a.bin' },
      { peer: USER_PEER, mediaManager: delayedMedia }
    );
    expect((delayedMedia.downloadAndSave as any).mock.calls).toHaveLength(1);
    resolveDelayed({ localPath: path.join(tmpDir, 'sf.bin'), fingerprint: 'fp-sf', deduplicated: false });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.local_path).toBe(r2.local_path);
    expect(mediaCalls).toHaveLength(1);
  });

  it('契约 7: expand_forward_message 解析官方 message_type=102 合并转发、限量落盘内嵌图片并彻底剥离 rkey', async () => {
    const forwardContent = [
      '[群聊的聊天记录]',
      '=== 消息 1 ===',
      '[消息内容] 周五聚餐地点定了吗？',
      '[发送者] 朋友A',
      '',
      '=== 消息 2 ===',
      '[发送者] 朋友B',
      '[附件1] 类型:图片 文件名:menu.jpg 尺寸:1080x1920 大小:256KB URL:https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=TOP_SECRET_RKEY_123&spec=0',
    ].join('\n');

    const fwdRecord = {
      msg_id: 'ROBOT1.0_FWD_102',
      peer: USER_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: Date.now(),
      type: 'forward',
      content: forwardContent,
      raw: JSON.stringify({ id: 'ROBOT1.0_FWD_102', message_type: 102, content: forwardContent }),
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      source: 'qq' as const,
    };
    db.saveMessage(fwdRecord);
    const fwdShortId = (fwdRecord as any).short_id as string;
    expect(fwdShortId).toBe('msg_1');

    const { mediaManager, mediaCalls } = stubMedia();
    const res = await expandForwardMessage(
      { msg_id: fwdShortId },
      { peer: USER_PEER, db, mediaManager }
    );

    expect(res.success).toBe(true);
    expect(res.title).toBe('[群聊的聊天记录]');
    expect(res.images_downloaded).toBe(1);
    expect(res.messages).toHaveLength(2);
    expect(res.messages?.[0]).toMatchObject({
      index: 1,
      sender_name: '朋友A',
      content: '周五聚餐地点定了吗？',
    });
    expect(res.messages?.[1]?.sender_name).toBe('朋友B');
    expect(res.messages?.[1]?.attachments?.[0]?.local_path).toBeDefined();
    expect(res.content).toContain('[图片:');
    expect(res.content).not.toContain('TOP_SECRET_RKEY_123');
    expect(JSON.stringify(res)).not.toContain('rkey=');
    expect(mediaCalls).toHaveLength(1);
    assertNoUndefinedFields(res);

    // 兼容 forward_id 别名且缺失记录清晰报错
    const resAlias = await expandForwardMessage(
      { forward_id: fwdShortId },
      { peer: USER_PEER, db, mediaManager }
    );
    expect(resAlias.success).toBe(true);

    const resMissing = await expandForwardMessage(
      { msg_id: 'msg_999' },
      { peer: USER_PEER, db }
    );
    expect(resMissing.success).toBe(false);
    assertNoUndefinedFields(resMissing);

    // 严禁按长 ID / REFIDX / file_id 兼容查询
    const resLongRejected = await expandForwardMessage(
      { msg_id: 'ROBOT1.0_FWD_102' },
      { peer: USER_PEER, db, mediaManager }
    );
    expect(resLongRejected.success).toBe(false);
    expect(resLongRejected.error).toContain('msg_12');
    assertNoUndefinedFields(resLongRejected);
  });
});
