/**
 * tests/contract/wakeup.test.ts
 *
 * 契约测试: QQ 官方 Bot v2 C2C 单聊唤醒门控与载荷解析 (Wakeup Gate Contract)
 *
 * 覆盖实测契约（仅依赖 Batch 1 与 Batch 2 模块）：
 * 1. `shouldWakeup` 基于 `openidToPeer` 映射 `user_<hash16>`、`from_user` 透传 `openid`、解析 ISO-8601 时间戳；
 * 2. 自循环防护 (`author.bot === true`)、非法 openid 拒绝、纯空消息过滤（纯空格保留唤醒）；
 * 3. `message_scene.ext` 提取 `msg_idx=REFIDX_...` 与 `ref_msg_idx=REFIDX_.../TMP_...`；
 * 4. 入站引用精确还原 (`message_type === 103`)：优先凭 `REFIDX_` 查本地库，未命中或遇 `TMP_` 时由 `msg_elements[]` 回退；
 * 5. 入站卡片 (`message_type === 3` + `ark_data`) 与传统 JSON/XML 卡片解析 (`extractArkDataContent` / `extractCardContent`)；
 * 6. 入站语音 (`voice_wav_url` + `asr_refer_text`) 与合并转发 (`message_type === 102`) 唤醒闭环。
 */

import { describe, it, expect } from 'vitest';
import {
  extractArkDataContent,
  extractCardContent,
  extractMessageRefIdx,
  extractMsgElementsText,
  extractQuotedRefIdx,
  isPermanentRefIdx,
  parseNormalizedContent,
  shouldWakeup,
} from '../../src/gateway/wakeup.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import type { QQC2CMessageCreateEvent } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = '9F8E7D6C5B4A32109F8E7D6C5B4A3210';
const EXPECTED_PEER = openidToPeer(MOCK_OPENID);

function makeEvent(overrides: Partial<QQC2CMessageCreateEvent> = {}): QQC2CMessageCreateEvent {
  return {
    id: 'ROBOT1.0_c2c_inbound_001',
    content: '你好呀',
    timestamp: '2026-11-11T18:28:47+08:00',
    author: {
      bot: false,
      id: '',
      union_openid: '',
      user_openid: MOCK_OPENID,
      username: '',
    },
    message_type: 0,
    ...overrides,
  };
}

describe('契约测试: C2C 单聊基础唤醒与三索引提取', () => {
  it('契约 1: C2C 普通文本消息直接唤醒，计算方案 A peer 并解析 ISO-8601 时间戳与 ref_idx', async () => {
    const event = makeEvent({
      id: 'ROBOT1.0_msg_direct_101',
      content: '今天深圳天气如何？',
      timestamp: '2026-11-11T18:28:47+08:00',
      message_scene: {
        ext: ['msg_idx=REFIDX_inbound_self_001'],
        source: 'c2c',
      },
    });

    const decision = await shouldWakeup(event, { senderRemark: '小李', shortId: 'msg_12' });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
    expect(decision.payload).toBeDefined();
    expect(decision.payload?.peer).toBe(EXPECTED_PEER);
    expect(decision.payload?.peer.startsWith('user_')).toBe(true);
    expect(decision.payload?.from_user).toBe(MOCK_OPENID);
    expect(decision.payload?.from_name).toBe('小李');
    expect(decision.payload?.msg_id).toBe('ROBOT1.0_msg_direct_101');
    expect(decision.payload?.short_id).toBe('msg_12');
    expect(decision.payload?.ref_idx).toBe('REFIDX_inbound_self_001');
    expect(decision.payload?.content).toBe('今天深圳天气如何？');
    expect(decision.payload?.timestamp).toBe(Date.parse('2026-11-11T18:28:47+08:00'));

    // 未传 shortId 时，不注入 short_id 键
    const noShortDecision = await shouldWakeup(event, { senderRemark: '小李' });
    expect('short_id' in noShortDecision.payload!).toBe(false);
  });

  it('契约 2: 自循环防护与非法 openid 拒绝唤醒', async () => {
    const botEvent = makeEvent({
      author: { bot: true, user_openid: MOCK_OPENID, username: 'kujira' },
    });
    expect((await shouldWakeup(botEvent)).wakeup).toBe(false);

    const invalidOpenidEvent = makeEvent({
      author: { bot: false, user_openid: 'bad openid with space', username: '' },
    });
    expect((await shouldWakeup(invalidOpenidEvent)).wakeup).toBe(false);

    const emptyOpenidEvent = makeEvent({
      author: { bot: false, user_openid: '', username: '' },
    });
    expect((await shouldWakeup(emptyOpenidEvent)).wakeup).toBe(false);
  });

  it('契约 3: 完全空内容且无附件/引用/卡片不唤醒；纯空格有效字符正常唤醒', async () => {
    const emptyEvent = makeEvent({ content: '' });
    const emptyDecision = await shouldWakeup(emptyEvent);
    expect(emptyDecision.wakeup).toBe(false);
    expect(emptyDecision.payload).toBeUndefined();

    const spaceEvent = makeEvent({ content: '   ' });
    const spaceDecision = await shouldWakeup(spaceEvent);
    expect(spaceDecision.wakeup).toBe(true);
    expect(spaceDecision.trigger).toBe('direct');
    expect(spaceDecision.payload?.content).toBe('   ');

    const faceOnlyEvent = makeEvent({ content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">' });
    const faceOnlyDecision = await shouldWakeup(faceOnlyEvent);
    expect(faceOnlyDecision.wakeup).toBe(true);
    expect(faceOnlyDecision.trigger).toBe('direct');
    expect(faceOnlyDecision.payload?.content).toBe('[表情]');
  });
});

describe('契约测试: 入站引用消息还原 (message_type=103)', () => {
  it('契约 4: ref_msg_idx=REFIDX_... 命中本地数据库 → trigger=quote 且合并引用图片', async () => {
    const event = makeEvent({
      id: 'ROBOT1.0_quote_001',
      content: '这张图真好看',
      message_type: 103,
      message_scene: {
        ext: ['ref_msg_idx=REFIDX_target_db_001', 'msg_idx=REFIDX_quote_self_001'],
      },
      msg_elements: [
        {
          content: '[图片]',
          message_type: 103,
          msg_idx: 'REFIDX_target_db_001',
        },
      ],
    });

    expect(extractMessageRefIdx(event)).toBe('REFIDX_quote_self_001');
    expect(extractQuotedRefIdx(event)).toBe('REFIDX_target_db_001');
    expect(isPermanentRefIdx('REFIDX_target_db_001')).toBe(true);
    expect(isPermanentRefIdx('TMP_1234-5678')).toBe(false);

    const decision = await shouldWakeup(event, {
      botName: 'Kujira助手',
      getMessageByRefIdx: async (refIdx) => {
        if (refIdx === 'REFIDX_target_db_001') {
          return {
            msg_id: 'ROBOT1.0_bot_out_888',
            short_id: 'msg_self_5',
            ref_idx: 'REFIDX_target_db_001',
            time: 1788045798000,
            user_id: 'bot',
            sender_name: '',
            self: 1,
            type: 'image',
            content: '[图片:/dsh/kujira/downloads/image/user_1/cat.png]',
            local_path: '/dsh/kujira/downloads/image/user_1/cat.png',
          };
        }
        return null;
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('quote');
    expect(decision.payload?.ref_idx).toBe('REFIDX_quote_self_001');
    expect(decision.payload?.quoted).toEqual({
      short_id: 'msg_self_5',
      time: 1788045798000,
      text: '[图片:/dsh/kujira/downloads/image/user_1/cat.png]',
      images: ['/dsh/kujira/downloads/image/user_1/cat.png'],
    });
    expect('msg_id' in decision.payload!.quoted!).toBe(false);
    expect('ref_idx' in decision.payload!.quoted!).toBe(false);
    expect('user_id' in decision.payload!.quoted!).toBe(false);
    expect('from_name' in decision.payload!.quoted!).toBe(false);
    expect(decision.payload?.images).toEqual(['/dsh/kujira/downloads/image/user_1/cat.png']);
  });

  it('契约 5: ref_msg_idx 为 TMP_... 或查库未命中时，直接从 msg_elements[] 提取原文兜底', async () => {
    let dbQueried = false;
    const tmpEvent = makeEvent({
      id: 'ROBOT1.0_quote_tmp_002',
      content: '继续展开说说',
      message_type: 103,
      message_scene: {
        ext: ['ref_msg_idx=TMP_8d1a9f0c-1122-3344-5566-778899aabbcc', 'msg_idx=REFIDX_self_002'],
      },
      msg_elements: [
        {
          content: '=== 消息 1 ===\n[消息内容] 复合引用前文内容\n[消息类型] 引用消息',
          message_type: 103,
        },
      ],
    });

    const decision = await shouldWakeup(tmpEvent, {
      getMessageByRefIdx: async () => {
        dbQueried = true;
        return null;
      },
    });

    // TMP_ 临时索引不查本地 SQLite，直接走 msg_elements 兜底（含嵌套 === 消息 N === 结构化清洗）
    expect(dbQueried).toBe(false);
    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('quote');
    expect(decision.payload?.quoted).toEqual({
      text: '1. 复合引用前文内容\n   [消息类型] 引用消息',
    });

    // REFIDX_ 存在但查库未命中时，同样回退 msg_elements
    const missedDbEvent = makeEvent({
      id: 'ROBOT1.0_quote_miss_003',
      content: '补充一下',
      message_type: 103,
      message_scene: {
        ext: ['ref_msg_idx=REFIDX_not_in_db_003'],
      },
      msg_elements: [{ content: '服务端下发的原始引用内容', message_type: 103 }],
    });

    const missedDecision = await shouldWakeup(missedDbEvent, {
      getMessageByRefIdx: async () => null,
    });
    expect(missedDecision.trigger).toBe('quote');
    expect(missedDecision.payload?.quoted).toEqual({ text: '服务端下发的原始引用内容' });
    expect(extractMsgElementsText(missedDbEvent)).toBe('服务端下发的原始引用内容');
  });

  it('契约 6: 引用既未命中库又无 msg_elements 时优雅降级占位，不中断唤醒', async () => {
    const emptyQuoteEvent = makeEvent({
      id: 'ROBOT1.0_quote_empty_004',
      content: '你说的是这个吗',
      message_type: 103,
      message_scene: {
        ext: ['ref_msg_idx=REFIDX_expired_004'],
      },
    });

    const decision = await shouldWakeup(emptyQuoteEvent, {
      getMessageByRefIdx: async () => null,
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('quote');
    expect(decision.payload?.quoted).toEqual({
      text: '〔历史引用消息：内容已过期或无法获取〕',
    });
  });
});

describe('契约测试: 卡片消息 (message_type=3 + ark_data) 与富媒体/转发唤醒', () => {
  it('契约 7: message_type=3 优先解析 d.ark_data（含 fields.title / source / preview / prompt）', async () => {
    const cardEvent = makeEvent({
      id: 'ROBOT1.0_card_001',
      message_type: 3,
      content: '[卡片消息] 小程序\n摘要: [QQ小程序]测试\ntitle: 测试标题',
      ark_data: {
        ark_name: '小程序',
        ark_type: 'miniapp',
        fields: {
          preview: 'https://qq.ugcimg.cn/v1/card_preview.png',
          source: '哔哩哔哩',
          source_logo: 'https://open.gtimg.cn/logo.png',
          title: '【深度学习】Transformer 从零手写实现',
          qqdocurl: 'https://b23.tv/av123456',
        },
        prompt: '[QQ小程序]哔哩哔哩',
      },
    });

    const formatted = extractArkDataContent(cardEvent.ark_data, cardEvent.content);
    expect(formatted).toContain('[卡片消息:【深度学习】Transformer 从零手写实现](https://b23.tv/av123456)');
    expect(formatted).toContain('[类型:小程序]');
    expect(formatted).toContain('[来源:哔哩哔哩]');
    expect(formatted).toContain('[封面:https://qq.ugcimg.cn/v1/card_preview.png]');

    const decision = await shouldWakeup(cardEvent);
    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('direct');
    expect(decision.payload?.content).toBe(formatted);

    // 无 ark_data 时回退 content
    expect(extractArkDataContent(undefined, '[卡片消息] fallback')).toBe('[卡片消息] fallback');

    // 保留旧版 extractCardContent 解析兼容性
    const legacyJsonCard = extractCardContent(
      {
        data: JSON.stringify({
          prompt: '[QQ小程序]B站',
          meta: { detail_1: { title: '视频标题', qqdocurl: 'b23.tv/abc', preview: '//qq.ugcimg.cn/a.png' } },
        }),
      },
      'json'
    );
    expect(legacyJsonCard.link).toBe('https://b23.tv/abc');
    expect(legacyJsonCard.cover).toBe('https://qq.ugcimg.cn/a.png');
  });

  it('契约 8: 语音附件渲染结合本地 WAV 路径与官方 asr_refer_text', async () => {
    const event = makeEvent({
      id: 'ROBOT1.0_voice_001',
      content: '',
      attachments: [
        {
          content_type: 'voice',
          filename: 'voice_01.amr',
          voice_wav_url: 'https://qqbot.ugcimg.cn/voice_01.wav',
          asr_refer_text: '明天上午十点开会',
        },
      ],
    });
    const descriptors: AttachmentDescriptor[] = [
      {
        kind: 'record',
        origin: 'inbound',
        fileName: 'voice_01.amr',
        remote: {
          contentType: 'voice',
          voiceWavUrl: 'https://qqbot.ugcimg.cn/voice_01.wav',
          asrReferText: '明天上午十点开会',
        },
        local: {
          path: '/dsh/kujira/downloads/voice/user_mock/voice_01.wav',
          format: 'wav',
        },
      },
    ];

    const decision = await shouldWakeup(event, { descriptors });
    expect(decision.wakeup).toBe(true);
    expect(decision.payload?.content).toBe(
      '[语音 已保存: /dsh/kujira/downloads/voice/user_mock/voice_01.wav (语音转文字: "明天上午十点开会")]'
    );
  });

  it('契约 9: message_type=102 未预下载合并转发经 parseNormalizedContent 重排对话流并保留选项 A 真实直链', () => {
    const rawUrl =
      'https://multimedia.nt.qq.com.cn/download?appid=1406&rkey=TOP_SECRET_FORWARD_RKEY&spec=0';
    const forwardEvent = makeEvent({
      id: 'ROBOT1.0_fwd_001',
      message_type: 102,
      content: [
        '[群聊的聊天记录]',
        '=== 消息 1 ===',
        '[消息内容] 看看这张截图',
        `[附件1] 类型:图片 文件名:shot.png 尺寸:800x600 大小:120KB URL:${rawUrl}`,
      ].join('\n'),
    });

    const formatted = parseNormalizedContent(forwardEvent, []);
    expect(formatted).toBe(
      `[群聊的聊天记录]\n1. 看看这张截图 [图片:shot.png (800x600, 120KB) 直链: ${rawUrl}]`
    );
    expect(formatted).not.toContain('[图片(链接已脱敏)]');
    expect(formatted).not.toContain('链接已脱敏');
    expect(formatted).not.toContain('=== 消息');
    expect(formatted).not.toContain('[消息内容]');
  });

  it('契约 10: QQ 商城/官方表情 ext.text 兜底展示与自定义表情包附件优先级', async () => {
    // 1. msg_13 风格无附件商城表情 -> [表情: 内有坏猫]
    const storeFaceEvent = makeEvent({
      id: 'ROBOT1.0_msg_13',
      content: '<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ==">',
    });
    const storeFaceDecision = await shouldWakeup(storeFaceEvent, { shortId: 'msg_13' });
    expect(storeFaceDecision.wakeup).toBe(true);
    expect(storeFaceDecision.trigger).toBe('direct');
    expect(storeFaceDecision.payload?.short_id).toBe('msg_13');
    expect(storeFaceDecision.payload?.content).toBe('[表情: 内有坏猫]');

    // 2. 无 ext 的纯表情仍兜底为 [表情]；空 ext 搭配文字不污染正文
    expect(parseNormalizedContent(makeEvent({ content: '<faceType=4,faceId="14">' }), [])).toBe('[表情]');
    expect(
      parseNormalizedContent(
        makeEvent({ content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0="> 笑死' }),
        []
      )
    ).toBe('笑死');

    // 3. 商城表情搭配正文 / 多商城表情
    expect(
      parseNormalizedContent(
        makeEvent({
          content: '<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ=="> 哈哈哈',
        }),
        []
      )
    ).toBe('哈哈哈 [表情: 内有坏猫]');
    expect(
      parseNormalizedContent(
        makeEvent({
          content:
            '<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ=="><faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+W8gOW/g10ifQ==">',
        }),
        []
      )
    ).toBe('[表情: 内有坏猫] [表情: 开心]');

    // 4. 带 attachments[] 图片的 <faceType=6> 自定义表情包仍产出 [表情包:<local_path>] 且不重复追加 [表情: ...]
    const stickerEvent = makeEvent({
      id: 'ROBOT1.0_sticker_001',
      content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      attachments: [
        {
          content_type: 'image/jpeg',
          filename: 'custom_sticker.jpg',
          url: 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET',
        },
      ],
    });
    const stickerDescriptors: AttachmentDescriptor[] = [
      {
        kind: 'image',
        origin: 'inbound',
        fileName: 'custom_sticker.jpg',
        local: {
          path: '/dsh/kujira/downloads/image/user_mock/custom_sticker.jpg',
          format: 'jpg',
        },
      },
    ];
    const stickerDecision = await shouldWakeup(stickerEvent, {
      descriptors: stickerDescriptors,
    });
    expect(stickerDecision.wakeup).toBe(true);
    expect(stickerDecision.payload?.content).toBe(
      '[表情包:/dsh/kujira/downloads/image/user_mock/custom_sticker.jpg]'
    );

    // 即使同时存在非空 ext.text，有渲染附件时也不重复输出 [表情: ...]
    const stickerWithTextExt = makeEvent({
      content: '<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ==">',
      attachments: stickerEvent.attachments,
    });
    expect(
      parseNormalizedContent(stickerWithTextExt, [
        {
          kind: 'image',
          origin: 'inbound',
          fileName: 'custom_sticker.jpg',
          local: {
            path: '/dsh/kujira/downloads/image/user_mock/custom_sticker.jpg',
            format: 'jpg',
          },
        },
      ])
    ).toBe('[表情包:/dsh/kujira/downloads/image/user_mock/custom_sticker.jpg]');
  });
});
