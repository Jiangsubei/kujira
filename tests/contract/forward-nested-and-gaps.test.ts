/**
 * tests/contract/forward-nested-and-gaps.test.ts
 *
 * 契约测试：2026-11-18 实测补齐的合并转发与入站标签解析缺口
 *
 * 覆盖核心契约：
 * 1. 私聊 `[用户A和用户B的聊天记录]` 与群聊 `[群聊的聊天记录]` 首行标题均原样保留；
 * 2. 合并转发图片节点 `<attachmentType="image/jpeg",attachmentIndex=0,description="...">` 就地替换为图片占位，
 *    不泄露原始 XML/Base64，不误判为表情包，支持 `.png` / `.webp` 裸 GET 落盘；
 * 3. 单条消息内混排文本、`<attachmentType>` 与 `<faceType>` 时，就地转换严格保持原始相对顺序
 *    （同时覆盖合并转发 `formatForwardMessageContent` 与普通入站消息 `parseNormalizedContent`）；
 *    无匹配附件时 `<attachmentType>` 回退解码 `description.text`（如 `[图片]`）；
 * 4. 私聊来源嵌套合并转发（重复 4 行 `[卡片消息] 合并转发消息` 块）去重规整为
 *    `[嵌套合并转发（平台未展开，无法查看内容）]`；普通卡片节点也剥离尾部重复摘要行；
 * 5. 群聊来源 2/3 层嵌套合并转发被平台静默抽空（仅有 `[发送者]`）时渲染为
 *    `N. <发送者>: [未展开或不支持的消息内容]`；
 * 6. 合并转发内嵌 `[关联消息]` 引用块对齐聚合消息格式，就地渲染为 `[引用回复: "..."] <回复正文>`；
 * 7. 端到端链路（`resolveEmbeddedForwardMedia` → `shouldWakeup` → `formatExternalPrompt`）闭环验证，
 *    并验证 `author.username` / `author.avatar` 兼容。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { MediaStorageManager } from '../../src/storage/media.js';
import {
  formatForwardMessageContent,
  resolveEmbeddedForwardMedia,
} from '../../src/gateway/inbound-media.js';
import { parseNormalizedContent } from '../../src/gateway/segment-normalizer.js';
import { shouldWakeup } from '../../src/gateway/wakeup.js';
import { formatExternalPrompt } from '../../src/gateway/external-prompt.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0099';
const PEER = openidToPeer(MOCK_OPENID);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0x12),
]);

// RIFF....WEBP minimal header for webp detection
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),
  Buffer.alloc(24, 0x34),
]);

const IMG_DESC_B64 = Buffer.from(JSON.stringify({ text: '[图片]' }), 'utf8').toString('base64');
const SMILE_EXT_B64 = Buffer.from(JSON.stringify({ text: '[开心]' }), 'utf8').toString('base64');

describe('契约测试: 合并转发嵌套折叠、私聊来源、内嵌引用与 <attachmentType> 就地转换', () => {
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
        const addr = srv.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
  }

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-forward-gaps-'));
    manager = new MediaStorageManager({ dshHome: tmpHome, downloadDir: 'downloads' });
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((r) => s.close(() => r())).catch(() => {});
    }
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: 私聊来源 [用户A和用户B的聊天记录] 与内嵌 [关联消息] 引用块按聚合格式就地渲染', () => {
    const privateForward = [
      '[用户A和用户B的聊天记录]',
      '=== 消息 1 ===',
      '[消息内容] 第一句问候',
      '[发送者] 用户A',
      '',
      '=== 消息 2 ===',
      '[消息内容] 第二句回复',
      '[发送者] 用户B',
      '',
      '=== 消息 3 ===',
      '[消息内容] 两个30x',
      '[发送者] 用户A',
      '[关联消息]',
      '--- 第1条 ---',
      '    [消息内容] [图片]',
      '    [消息类型] 引用消息',
      '',
      '=== 消息 4 ===',
      '[消息内容] 收到收到',
      '[发送者] 用户B',
    ].join('\n');

    const formatted = formatForwardMessageContent(privateForward);

    expect(formatted).toBe(
      [
        '[用户A和用户B的聊天记录]',
        '1. 用户A: 第一句问候',
        '2. 用户B: 第二句回复',
        '3. 用户A: [引用回复: "[图片]"] 两个30x',
        '4. 用户B: 收到收到',
      ].join('\n')
    );
    expect(formatted).not.toContain('[关联消息]');
    expect(formatted).not.toContain('--- 第1条 ---');
    expect(formatted).not.toContain('[消息类型]');
  });

  it('契约 2: 合并转发图片节点 <attachmentType=...> 剥离并就地替换为 .png/.webp 本地路径，绝不误判表情包', async () => {
    const base = await startServer((req, res) => {
      if (req.url?.includes('fmt=webp')) {
        res.writeHead(200, { 'Content-Type': 'image/webp' });
        res.end(WEBP_BYTES);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });

    const pngUrl = `${base}/download?fmt=png&rkey=MOCK_RKEY_PNG`;
    const webpUrl = `${base}/download?fmt=webp&rkey=MOCK_RKEY_WEBP`;

    const groupImageForward = [
      '[群聊的聊天记录]',
      '=== 消息 1 ===',
      `[消息内容] <attachmentType="image/jpeg",attachmentIndex=0,description="${IMG_DESC_B64}">`,
      '[发送者] 群友甲',
      `[附件1] 类型:图片 文件名:MOCKHASH01.png 尺寸:800x612 大小:472.4KB URL:${pngUrl}`,
      '',
      '=== 消息 2 ===',
      `[消息内容] <attachmentType="image/jpeg",attachmentIndex=0,description="${IMG_DESC_B64}">`,
      '[发送者] 群友甲',
      `[附件1] 类型:图片 文件名:MOCKHASH02.webp 尺寸:1440x2560 大小:250.9KB URL:${webpUrl}`,
    ].join('\n');

    const res = await resolveEmbeddedForwardMedia(groupImageForward, PEER, manager);

    expect(res.localPaths).toHaveLength(2);
    expect(fs.existsSync(res.localPaths[0]!)).toBe(true);
    expect(fs.existsSync(res.localPaths[1]!)).toBe(true);

    expect(res.formattedContent).toBe(
      [
        '[群聊的聊天记录]',
        `1. 群友甲: [图片:${res.localPaths[0]!}]`,
        `2. 群友甲: [图片:${res.localPaths[1]!}]`,
      ].join('\n')
    );
    expect(res.formattedContent).not.toContain('<attachmentType');
    expect(res.formattedContent).not.toContain(IMG_DESC_B64);
    expect(res.formattedContent).not.toContain('[表情包:');
    expect(res.formattedContent).not.toContain('MOCK_RKEY_');
  });

  it('契约 3: 混排文本 + <attachmentType> + <faceType> 就地转换严格保持原始顺序（合并转发与普通消息双路径）', () => {
    const url0 = 'https://multimedia.nt.qq.com.cn/download?idx=0&rkey=MOCK_ORDER_0';
    const url1 = 'https://multimedia.nt.qq.com.cn/download?idx=1&rkey=MOCK_ORDER_1';

    // 路径 A: 合并转发节点混排（含多图与表情 + 无附件兜底）
    const mixedForward = [
      '[群聊的聊天记录]',
      '=== 消息 1 ===',
      `[消息内容] 先看图一 <attachmentType="image/jpeg",attachmentIndex=0,description="${IMG_DESC_B64}"> 太乐了 <faceType=4,faceId="",ext="${SMILE_EXT_B64}"> 再看图二 <attachmentType="image/jpeg",attachmentIndex=1,description="${IMG_DESC_B64}"> 结尾`,
      '[发送者] 群友乙',
      `[附件1] 类型:图片 文件名:one.png 尺寸:800x600 大小:10KB URL:${url0}`,
      `[附件2] 类型:图片 文件名:two.webp 尺寸:800x600 大小:20KB URL:${url1}`,
      '',
      '=== 消息 2 ===',
      `[消息内容] 无附件兜底 <attachmentType="image/jpeg",attachmentIndex=0,description="${IMG_DESC_B64}">`,
      '[发送者] 群友丙',
    ].join('\n');

    const replacements = new Map<string, string>([
      [url0, '[图片:/tmp/one.png]'],
      [url1, '[图片:/tmp/two.webp]'],
    ]);

    const formatted = formatForwardMessageContent(mixedForward, { replacements });
    expect(formatted).toBe(
      [
        '[群聊的聊天记录]',
        '1. 群友乙: 先看图一 [图片:/tmp/one.png] 太乐了 [表情: 开心] 再看图二 [图片:/tmp/two.webp] 结尾',
        '2. 群友丙: 无附件兜底 [图片]',
      ].join('\n')
    );

    // 路径 B: 普通入站消息 parseNormalizedContent 同理就地保持顺序
    const normalEvent: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_inline_order_001',
      content: `前文 <attachmentType="image/jpeg",attachmentIndex=0,description="${IMG_DESC_B64}"> 中间 <faceType=4,faceId="",ext="${SMILE_EXT_B64}"> 后文 <attachmentType="image/jpeg",attachmentIndex=1,description="${IMG_DESC_B64}">`,
      timestamp: '2026-11-18T16:45:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户', avatar: 'https://thirdqq.qlogo.cn/mock' },
      message_type: 0,
    };
    const descriptors: AttachmentDescriptor[] = [
      { kind: 'image', origin: 'inbound', local: { path: '/tmp/a.png' } },
      { kind: 'image', origin: 'inbound', local: { path: '/tmp/b.webp' } },
    ];
    const normalized = parseNormalizedContent(normalEvent, descriptors);
    expect(normalized).toBe('前文 [图片:/tmp/a.png] 中间 [表情: 开心] 后文 [图片:/tmp/b.webp]');
  });

  it('契约 4: 私聊嵌套合并转发折叠卡片去重为清晰占位；普通卡片节点也去除重复摘要行', () => {
    const nestedPrivateForward = [
      '[用户A和用户B的聊天记录]',
      '=== 消息 1 ===',
      '[消息内容] 写得挺干净的',
      '[发送者] 用户A',
      '',
      '=== 消息 2 ===',
      '[消息内容] [卡片消息] 合并转发消息',
      '摘要: [聊天记录]',
      '[发送者] 用户B',
      '[消息类型] 卡片消息',
      '[卡片消息] 合并转发消息 摘要:[聊天记录]',
      '',
      '=== 消息 3 ===',
      '[消息内容] [卡片消息] 合并转发消息',
      '摘要: [聊天记录]',
      '[发送者] 用户B',
      '[消息类型] 卡片消息',
      '[卡片消息] 合并转发消息 摘要:[聊天记录]',
      '',
      '=== 消息 4 ===',
      '[消息内容] [卡片消息] 小程序',
      '摘要: [QQ小程序]测试标题',
      '[发送者] 用户A',
      '[消息类型] 卡片消息',
      '[卡片消息] 小程序 摘要:[QQ小程序]测试标题',
    ].join('\n');

    const formatted = formatForwardMessageContent(nestedPrivateForward);
    expect(formatted).toBe(
      [
        '[用户A和用户B的聊天记录]',
        '1. 用户A: 写得挺干净的',
        '2. 用户B: [嵌套合并转发（平台未展开，无法查看内容）]',
        '3. 用户B: [嵌套合并转发（平台未展开，无法查看内容）]',
        '4. 用户A: [卡片消息] 小程序',
        '   摘要: [QQ小程序]测试标题',
      ].join('\n')
    );
    expect(formatted).not.toContain('[消息类型] 卡片消息');
    expect(formatted).not.toContain('摘要:[聊天记录]');
  });

  it('契约 5: 群聊 2/3 层嵌套合并转发被服务端静默抽空（仅剩 [发送者]）时输出明确占位', () => {
    const groupNestedHollow = [
      '[群聊的聊天记录]',
      '=== 消息 1 ===',
      '[发送者] 群友A',
      '',
      '=== 消息 2 ===',
      '[消息内容] 发的啥，看不懂',
      '[发送者] 群友B',
      '',
      '=== 消息 3 ===',
      '',
    ].join('\n');

    const formatted = formatForwardMessageContent(groupNestedHollow);
    expect(formatted).toBe(
      [
        '[群聊的聊天记录]',
        '1. 群友A: [未展开或不支持的消息内容]',
        '2. 群友B: 发的啥，看不懂',
        '3. [空消息]',
      ].join('\n')
    );
  });

  it('契约 6: 合并转发与外部唤醒链路端到端闭环（含 author.avatar 与脱敏检查）', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
    });
    const imgUrl = `${base}/download?rkey=E2E_NESTED_SECRET`;

    const event: QQC2CMessageCreateEvent = {
      id: 'ROBOT1.0_e2e_nested_001',
      content: [
        '[用户A和用户B的聊天记录]',
        '=== 消息 1 ===',
        `[消息内容] 看这个 <attachmentType="image/jpeg",attachmentIndex=0,description="${IMG_DESC_B64}">`,
        '[发送者] 用户A',
        `[附件1] 类型:图片 文件名:demo.png 尺寸:800x600 大小:100KB URL:${imgUrl}`,
        '',
        '=== 消息 2 ===',
        '[消息内容] [卡片消息] 合并转发消息',
        '摘要: [聊天记录]',
        '[发送者] 用户B',
        '[消息类型] 卡片消息',
        '[卡片消息] 合并转发消息 摘要:[聊天记录]',
        '',
        '=== 消息 3 ===',
        '[消息内容] 回复一句',
        '[发送者] 用户A',
        '[关联消息]',
        '--- 第1条 ---',
        '    [消息内容] [图片]',
        '    [消息类型] 引用消息',
      ].join('\n'),
      timestamp: '2026-11-18T16:40:09+08:00',
      author: {
        user_openid: MOCK_OPENID,
        username: '用户B',
        avatar: 'https://thirdqq.qlogo.cn/bqqthird?mock=1',
        bot: false,
      },
      message_type: 102,
    };

    const embedded = await resolveEmbeddedForwardMedia(event.content, PEER, manager);
    const decision = await shouldWakeup(event, {
      formatForwardContent: () => embedded.formattedContent,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.from_name).toBe('用户B');
    const prompt = formatExternalPrompt({ ...decision.payload!, short_id: 'msg_10' });

    expect(prompt).toContain('[用户A和用户B的聊天记录]');
    expect(prompt).toContain(`1. 用户A: 看这个 [图片:${embedded.localPaths[0]!}]`);
    expect(prompt).toContain('2. 用户B: [嵌套合并转发（平台未展开，无法查看内容）]');
    expect(prompt).toContain('3. 用户A: [引用回复: "[图片]"] 回复一句');
    expect(prompt).not.toContain('<attachmentType');
    expect(prompt).not.toContain('E2E_NESTED_SECRET');
    expect(prompt).not.toContain('[关联消息]');
  });
});
