/**
 * tests/contract/attachment-descriptor.test.ts
 *
 * 契约测试: QQ 官方 Bot v2 单聊统一附件描述符 (Attachment Descriptor)
 *
 * 覆盖契约：
 * 1. `classifyAttachment` / `describeInboundAttachments` 基于官方 `content_type` 分类，去除 `group_file` 与 `busid`；
 * 2. `.png` 文件以 `content_type === 'file'` 下发时保留 `'file'` 分类与安全文件名；
 * 3. `voice` 附件提取 `voice_wav_url` 与 `asr_refer_text`；
 * 4. `buildOutboundMediaAttachment` 与 `buildOutboundFaceAttachment(face, localPath)` 无 `subType`，Lossless JSON；
 * 5. `renderAttachment` 唯一渲染入口：遵循选项 A（已落盘仅展示本地路径，未落盘/失败保留真实直链），支持语音转写、视频元信息与 `.png` 文件路径展示；
 * 6. `serializeAttachments` / `deserializeAttachments` / `descriptorsFromRaw` 无损往返与官方事件解析。
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAttachment,
  describeAttachment,
  describeInboundAttachments,
  extractFaceXmlTexts,
  hasFaceXmlTag,
  inferInboundMessageType,
  resolveLocalMediaPath,
  sanitizeAttachmentFileName,
  stripFaceXmlTags,
  toMessageMediaFields,
} from '../../src/attachment/classify.js';
import {
  buildOutboundFaceAttachment,
  buildOutboundMediaAttachment,
} from '../../src/attachment/outbound.js';
import { renderAttachment } from '../../src/attachment/render.js';
import {
  compact,
  deserializeAttachments,
  descriptorsFromRaw,
  isAttachmentKind,
  serializeAttachments,
} from '../../src/attachment/store.js';
import type { AttachmentDescriptor } from '../../src/attachment/types.js';
import type { FaceRecord, QQC2CMessageCreateEvent } from '../../src/types/index.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0001';

function makeEvent(overrides: Partial<QQC2CMessageCreateEvent> = {}): QQC2CMessageCreateEvent {
  return {
    id: 'ROBOT1.0_inbound_msg_001',
    content: '',
    timestamp: '2026-11-11T18:28:47+08:00',
    author: { user_openid: MOCK_OPENID, username: '' },
    message_type: 0,
    ...overrides,
  };
}

describe('契约测试: 官方附件分类与去 OneBot/群文件化', () => {
  it('契约 1: image / voice / video / file 官方 content_type 判定准确，且已剔除 group_file', () => {
    expect(isAttachmentKind('image')).toBe(true);
    expect(isAttachmentKind('sticker')).toBe(true);
    expect(isAttachmentKind('file')).toBe(true);
    expect(isAttachmentKind('record')).toBe(true);
    expect(isAttachmentKind('video')).toBe(true);
    expect(isAttachmentKind('forward')).toBe(true);
    expect(isAttachmentKind('group_file')).toBe(false);

    expect(classifyAttachment({ content_type: 'image/png' })).toBe('image');
    expect(classifyAttachment({ content_type: 'image/gif' })).toBe('image');
    expect(classifyAttachment({ content_type: 'voice' })).toBe('record');
    expect(classifyAttachment({ content_type: 'video/mp4' })).toBe('video');
    expect(classifyAttachment({ content_type: 'file', filename: 'photo.png' })).toBe('file');
  });

  it('契约 2: 语音附件提取 voice_wav_url 与 asr_refer_text，文件名执行路径穿越净化', () => {
    const desc = describeAttachment({
      content_type: 'voice',
      filename: '../../dir\\95C5A03B7A.amr',
      url: 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET_AMR',
      voice_wav_url: 'https://qqbot.ugcimg.cn/v1/voice.wav?sig=SECRET_WAV',
      asr_refer_text: '晚上一起吃火锅吗',
    });

    expect(desc.kind).toBe('record');
    expect(desc.origin).toBe('inbound');
    expect(desc.fileName).toBe('95C5A03B7A.amr');
    expect(desc.remote?.contentType).toBe('voice');
    expect(desc.remote?.voiceWavUrl).toBe('https://qqbot.ugcimg.cn/v1/voice.wav?sig=SECRET_WAV');
    expect(desc.remote?.asrReferText).toBe('晚上一起吃火锅吗');
    expect(sanitizeAttachmentFileName('..\\..\\evil:name?.png')).toBe('evil_name_.png');
  });

  it('契约 3: describeInboundAttachments 与 toMessageMediaFields 不包含 busid 字段', () => {
    const event = makeEvent({
      attachments: [
        {
          content_type: 'file',
          filename: 'screenshot.png',
          size: 457027,
          url: 'https://grouptalk.c2c.qq.com/download?rkey=SECRET',
        },
      ],
    });
    const resolved: AttachmentDescriptor[] = [
      {
        kind: 'file',
        origin: 'inbound',
        fileName: 'screenshot.png',
        remote: {
          fileUuid: 'uuid_file_001',
          contentType: 'file',
          url: 'https://grouptalk.c2c.qq.com/download?rkey=SECRET',
        },
        local: {
          path: '/dsh/kujira/downloads/files/user_abc/screenshot.png',
          format: 'png',
          fingerprint: 'fp-png-001',
        },
      },
    ];

    const summary = describeInboundAttachments(event, resolved);
    expect(summary.type).toBe('file');
    expect(summary.attachments).toHaveLength(1);

    const fields = toMessageMediaFields(summary);
    expect(fields).toEqual({
      type: 'file',
      file_id: 'uuid_file_001',
      local_path: '/dsh/kujira/downloads/files/user_abc/screenshot.png',
      fingerprint: 'fp-png-001',
    });
    expect('busid' in fields).toBe(false);
  });

  it('契约 4: resolveLocalMediaPath 将 file:/// URI 转为 OS 路径，HTTP/相对路径返回 null', () => {
    const winOrPosix = resolveLocalMediaPath('file:///C:/tmp/outbound-image.png');
    expect(winOrPosix?.endsWith('outbound-image.png')).toBe(true);
    expect(winOrPosix?.startsWith('file:///')).toBe(false);
    expect(resolveLocalMediaPath('https://example.com/a.png')).toBeNull();
    expect(resolveLocalMediaPath('relative/a.png')).toBeNull();
  });
});

describe('契约测试: 出站附件描述符构造（无 subType 与 Lossless JSON）', () => {
  it('契约 5: buildOutboundFaceAttachment 直接标注 kind=sticker + face，无需 subType', () => {
    const face: FaceRecord = {
      id: 'face_x',
      file_path: '/faces/face_x.png',
      md5: '0123456789abcdef0123456789abcdef',
      added_at: 1700000000000,
      source: 'collect',
      tags: ['猫猫'],
      mood: '嘲讽',
      enabled: true,
      size: 1234,
      format: 'png',
      use_count: 1,
    };

    const desc = buildOutboundFaceAttachment(face, 'file:///C:/faces/face_x.png');
    expect(desc.kind).toBe('sticker');
    expect(desc.origin).toBe('outbound');
    expect(desc.local?.path.startsWith('file:///')).toBe(false);
    expect(desc.face).toEqual({ id: 'face_x', mood: '嘲讽', tags: ['猫猫'] });
    expect(JSON.stringify(desc)).not.toContain('undefined');
  });

  it('契约 6: buildOutboundMediaAttachment 规范化 voice/file/image 并剥离 undefined 键', () => {
    const voiceDesc = buildOutboundMediaAttachment({
      kind: 'voice',
      localPath: '/tmp/voice_reply.wav',
      fileUuid: 'uuid_v1',
      fileInfo: 'file_info_v1',
    });
    expect(voiceDesc.kind).toBe('record');
    expect(voiceDesc.origin).toBe('outbound');
    expect(voiceDesc.fileName).toBe('voice_reply.wav');
    expect(voiceDesc.remote).toEqual({ fileUuid: 'uuid_v1', fileInfo: 'file_info_v1' });
    expect(Object.keys(voiceDesc.local!).every((k) => (voiceDesc.local as any)[k] !== undefined)).toBe(true);
  });
});

describe('契约测试: 唯一安全渲染入口 (renderAttachment)', () => {
  function render(d: AttachmentDescriptor): string {
    const text = renderAttachment(d);
    expect(text).not.toBeNull();
    return text as string;
  }

  it('契约 7: 命中表情库时入站/出站文案完全一致，不暴露 file:///', () => {
    const base = {
      kind: 'sticker' as const,
      local: { path: '/faces/face_x.png', format: 'png' },
      face: { id: 'face_x', mood: '嘲讽' },
    };
    const inbound = render({ ...base, origin: 'inbound' });
    const outbound = render({ ...base, origin: 'outbound' });

    expect(inbound).toBe('[表情包: face_x (情绪: 嘲讽) 路径: /faces/face_x.png]');
    expect(outbound).toBe(inbound);
  });

  it('契约 8: renderImage 遵循选项 A（已落盘只展示本地路径；未落盘/失败保留真实直链；无 URL 失败呈入站落盘失败）', () => {
    const secretUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1406&rkey=TOP_SECRET_KEY';

    // 1. 已落盘：仅展示本地路径，不拼接 remote.url
    const renderedWithLocal = render({
      kind: 'image',
      origin: 'inbound',
      fileName: '95C5A03B7A.png',
      remote: { url: secretUrl },
      local: { path: '/dsh/kujira/downloads/image/user_1/95C5A03B7A.png', format: 'png' },
    });
    expect(renderedWithLocal).toBe('[图片:/dsh/kujira/downloads/image/user_1/95C5A03B7A.png]');
    expect(renderedWithLocal).not.toContain('TOP_SECRET_KEY');
    expect(renderedWithLocal).not.toContain('直链:');

    // 2. 无 local.path 且有 unavailable 与 remote.url：输出下载失败原因与真实直链
    const renderedFailedWithUrl = render({
      kind: 'image',
      origin: 'inbound',
      fileName: '95C5A03B7A.png',
      remote: { url: secretUrl },
      unavailable: 'download_failed',
    });
    expect(renderedFailedWithUrl).toBe(
      `[图片:95C5A03B7A.png (下载失败: download_failed) 直链: ${secretUrl}]`
    );

    // 3. 无 local.path 但有 remote.url（无 unavailable）：输出真实直链
    const renderedNamedWithUrl = render({
      kind: 'image',
      origin: 'inbound',
      fileName: '95C5A03B7A.png',
      remote: { url: secretUrl },
    });
    expect(renderedNamedWithUrl).toBe(`[图片:95C5A03B7A.png 直链: ${secretUrl}]`);

    const renderedBare = render({
      kind: 'image',
      origin: 'inbound',
      remote: { url: secretUrl },
    });
    expect(renderedBare).toBe(`[图片 直链: ${secretUrl}]`);

    // 4. 无 remote.url 落盘失败才输出入站落盘失败占位
    const renderedFailedNoUrl = render({
      kind: 'image',
      origin: 'inbound',
      fileName: '95C5A03B7A.png',
      unavailable: 'download_failed',
    });
    expect(renderedFailedNoUrl).toBe('[图片:95C5A03B7A.png (入站落盘失败)]');
    expect(renderedFailedNoUrl).not.toContain('TOP_SECRET_KEY');

    // 5. 纯空图片占位
    expect(render({ kind: 'image', origin: 'inbound' })).toBe('[图片]');
  });

  it('契约 9: content_type=file 的 .png 文件明确展示路径；语音结合 local.path 与 asrReferText 渲染', () => {
    expect(
      render({
        kind: 'file',
        origin: 'inbound',
        fileName: 'ABCD.png',
        local: { path: '/dsh/kujira/downloads/files/user_1/ABCD.png', format: 'png' },
      })
    ).toBe('[文件:ABCD.png 已保存: /dsh/kujira/downloads/files/user_1/ABCD.png]');

    expect(
      render({
        kind: 'record',
        origin: 'inbound',
        local: { path: '/dsh/kujira/downloads/voice/user_1/v1.wav', format: 'wav' },
        remote: { asrReferText: '帮我查一下明天的天气' },
      })
    ).toBe('[语音 已保存: /dsh/kujira/downloads/voice/user_1/v1.wav (语音转文字: "帮我查一下明天的天气")]');

    expect(
      render({
        kind: 'record',
        origin: 'inbound',
        remote: { asrReferText: '语音转写文本' },
        unavailable: 'timeout',
      })
    ).toBe('[语音 (语音转文字: "语音转写文本") (入站落盘失败)]');

    expect(
      render({
        kind: 'record',
        origin: 'inbound',
        remote: { asrReferText: '仅转写文本' },
      })
    ).toBe('[语音 (语音转文字: "仅转写文本")]');

    expect(render({ kind: 'record', origin: 'inbound' })).toBe('[语音]');
  });

  it('契约 10: 合并转发与视频元信息渲染适配官方结构，空 content_type 按扩展名分类，未知 group_file 返回 null', () => {
    expect(render({ kind: 'forward', origin: 'inbound' })).toBe('[合并转发]');
    expect(render({ kind: 'forward', origin: 'inbound', summary: '群聊的聊天记录' })).toBe(
      '[合并转发: 群聊的聊天记录]'
    );
    expect(
      render({
        kind: 'video',
        origin: 'inbound',
        fileName: 'clip.mp4',
        local: { path: '/dsh/kujira/downloads/video/user_1/clip.mp4' },
      })
    ).toBe('[视频:clip.mp4 已保存: /dsh/kujira/downloads/video/user_1/clip.mp4]');

    expect(
      render({
        kind: 'video',
        origin: 'inbound',
        fileName: 'clip.mp4',
        local: {
          path: '/dsh/kujira/downloads/video/user_1/clip.mp4',
          dimensions: '720x1280',
          size: 849510,
          durationSec: 8.776,
        },
      })
    ).toBe(
      '[视频:clip.mp4 (720x1280, 829.6KB, 8.8s) 已保存: /dsh/kujira/downloads/video/user_1/clip.mp4]'
    );

    expect(
      render({
        kind: 'video',
        origin: 'inbound',
        local: {
          path: '/dsh/kujira/downloads/video/user_1/long.mp4',
          dimensions: '1080x1920',
          size: 2 * 1024 * 1024,
          durationSec: 65,
        },
      })
    ).toBe('[视频 (1080x1920, 2.0MB, 1m5s) 已保存: /dsh/kujira/downloads/video/user_1/long.mp4]');

    // content_type 为空或 application/octet-stream 时按扩展名分类
    expect(classifyAttachment({ content_type: '', filename: 'clip.mp4' })).toBe('video');
    expect(classifyAttachment({ filename: 'clip.mp4' })).toBe('video');
    expect(classifyAttachment({ content_type: 'application/octet-stream', filename: 'clip.mp4' })).toBe('video');
    expect(classifyAttachment({ content_type: '', filename: 'voice.wav' })).toBe('record');
    expect(classifyAttachment({ content_type: 'application/octet-stream', filename: 'voice.wav' })).toBe('record');
    expect(classifyAttachment({ content_type: '', filename: 'photo.png' })).toBe('image');
    expect(classifyAttachment({ content_type: 'application/octet-stream', filename: 'photo.png' })).toBe('image');
    // content_type='file' 的 .png 严格保持 'file'
    expect(classifyAttachment({ content_type: 'file', filename: 'photo.png' })).toBe('file');

    expect(renderAttachment({ kind: 'group_file' as any, origin: 'inbound' })).toBeNull();
  });
});

describe('契约测试: 序列化与官方 raw 事件解析 (store.ts)', () => {
  it('契约 11: serializeAttachments / deserializeAttachments 无损往返，compact 剥离 undefined', () => {
    const input = [
      {
        kind: 'record' as const,
        origin: 'inbound' as const,
        fileName: 'voice.amr',
        remote: {
          contentType: 'voice',
          asrReferText: '你好',
          fileUuid: undefined,
        },
        local: {
          path: '/downloads/voice/user_1/voice.wav',
          format: 'wav',
        },
      },
    ];

    const compacted = compact(input);
    expect('fileUuid' in compacted[0]!.remote!).toBe(false);

    const json = serializeAttachments(input);
    expect(typeof json).toBe('string');
    expect(json).not.toContain('undefined');

    const restored = deserializeAttachments(json);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.remote?.asrReferText).toBe('你好');

    // 旧版 group_file 记录反序列化时直接过滤剔除
    expect(
      deserializeAttachments(JSON.stringify([{ kind: 'group_file', origin: 'inbound' }]))
    ).toEqual([]);
    expect(deserializeAttachments('{invalid')).toEqual([]);
  });

  it('契约 12: descriptorsFromRaw 解析持久化 QQC2CMessageCreateEvent JSON，拒绝旧版段数组', () => {
    const officialEvent = makeEvent({
      attachments: [
        {
          content_type: 'image/png',
          filename: '95C5A03B7A.png',
          url: 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET',
        },
        {
          content_type: 'voice',
          filename: 'A1B2.amr',
          voice_wav_url: 'https://qqbot.ugcimg.cn/voice.wav',
          asr_refer_text: '收到',
        },
      ],
    });

    const parsed = descriptorsFromRaw(JSON.stringify(officialEvent));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.kind).toBe('image');
    expect(parsed[0]!.fileName).toBe('95C5A03B7A.png');
    expect(parsed[1]!.kind).toBe('record');
    expect(parsed[1]!.remote?.asrReferText).toBe('收到');

    // 旧版 OneBot 段数组 JSON 不兼容，返回空数组
    expect(descriptorsFromRaw(JSON.stringify([{ type: 'image', data: { file: 'a.png' } }]))).toEqual([]);
  });
});

describe('契约测试: <faceType=...> 标签剥离与表情包渲染', () => {
  it('契约 13: hasFaceXmlTag / stripFaceXmlTags 精准匹配并剥离入站表情 XML 壳', () => {
    const tag = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">';
    expect(hasFaceXmlTag(tag)).toBe(true);
    expect(hasFaceXmlTag('<faceType=6>')).toBe(true);
    expect(hasFaceXmlTag('<faceType= 12, faceId="1">')).toBe(true);
    expect(hasFaceXmlTag('<emoji:4>')).toBe(false);
    expect(hasFaceXmlTag('<div>hello</div>')).toBe(false);
    expect(hasFaceXmlTag('')).toBe(false);
    expect(hasFaceXmlTag(undefined)).toBe(false);

    expect(stripFaceXmlTags(tag)).toEqual({ text: '', hadFaceTag: true });
    expect(stripFaceXmlTags(`  ${tag} 笑死  `)).toEqual({ text: '笑死', hadFaceTag: true });
    expect(stripFaceXmlTags(`看看 ${tag} 这个`)).toEqual({ text: '看看 这个', hadFaceTag: true });
    expect(stripFaceXmlTags('   ')).toEqual({ text: '   ', hadFaceTag: false });
    expect(stripFaceXmlTags('普通文本')).toEqual({ text: '普通文本', hadFaceTag: false });
  });

  it('契约 14: <faceType=...> 仅将入站 image 描述符提升为 sticker，不影响 file/video/record', () => {
    const faceTag = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">';

    const stickerEvent = makeEvent({
      content: faceTag,
      attachments: [
        {
          content_type: 'image/jpeg',
          filename: 'diy.jpg',
          url: 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET',
        },
      ],
    });

    const rawDesc = describeInboundAttachments(stickerEvent);
    expect(rawDesc.type).toBe('sticker');
    expect(rawDesc.attachments[0]?.kind).toBe('sticker');

    const preResolved: AttachmentDescriptor[] = [
      {
        kind: 'image',
        origin: 'inbound',
        local: { path: '/dsh/kujira/downloads/image/user_1/diy.jpg', format: 'jpg' },
      },
    ];
    const resolvedDesc = describeInboundAttachments(stickerEvent, preResolved);
    expect(resolvedDesc.type).toBe('sticker');
    expect(resolvedDesc.attachments[0]?.kind).toBe('sticker');
    expect(inferInboundMessageType(stickerEvent, preResolved)).toBe('sticker');

    // file / video / record 不受 <faceType=...> 影响
    const fileEvent = makeEvent({
      content: faceTag,
      attachments: [{ content_type: 'file', filename: 'doc.pdf' }],
    });
    const fileDesc = describeInboundAttachments(fileEvent);
    expect(fileDesc.type).toBe('file');
    expect(fileDesc.attachments[0]?.kind).toBe('file');

    const videoEvent = makeEvent({
      content: faceTag,
      attachments: [{ content_type: 'video/mp4', filename: 'v.mp4' }],
    });
    const videoDesc = describeInboundAttachments(videoEvent);
    expect(videoDesc.type).toBe('video');
    expect(videoDesc.attachments[0]?.kind).toBe('video');

    const voiceEvent = makeEvent({
      content: faceTag,
      attachments: [{ content_type: 'voice', filename: 'v.amr' }],
    });
    const voiceDesc = describeInboundAttachments(voiceEvent);
    expect(voiceDesc.type).toBe('record');
    expect(voiceDesc.attachments[0]?.kind).toBe('record');
  });

  it('契约 15: renderSticker 严格遵循已收藏 / 未收藏本地路径 / 落盘失败 / 无路径四种格式', () => {
    expect(
      renderAttachment({
        kind: 'sticker',
        origin: 'inbound',
        face: { id: 'face_cat', mood: '嘲讽' },
        local: { path: '/faces/cat.png' },
      })
    ).toBe('[表情包: face_cat (情绪: 嘲讽) 路径: /faces/cat.png]');

    expect(
      renderAttachment({
        kind: 'sticker',
        origin: 'inbound',
        summary: '[动画表情]',
        local: { path: '/dsh/kujira/downloads/image/user_1/diy.jpg' },
      })
    ).toBe('[表情包:/dsh/kujira/downloads/image/user_1/diy.jpg]');

    expect(
      renderAttachment({
        kind: 'sticker',
        origin: 'inbound',
        unavailable: 'download_failed',
      })
    ).toBe('[表情包 (入站落盘失败)]');

    expect(
      renderAttachment({
        kind: 'sticker',
        origin: 'inbound',
        summary: '动画表情',
      })
    ).toBe('[表情包]');
  });

  it('契约 16: extractFaceXmlTexts 提取并解码 ext.text，忽略空值与非法输入', () => {
    expect(
      extractFaceXmlTexts('<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ==">')
    ).toEqual(['内有坏猫']);

    // 空 ext 或无 ext
    expect(extractFaceXmlTexts('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=6,faceId="0",ext="">')).toEqual([]);
    expect(extractFaceXmlTexts("<faceType=6,faceId='0',ext=''>")).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=6>')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="eyJ0ZXh0IjoiICAgIn0=">')).toEqual([]);

    // 非法 Base64 / 非法 JSON / 非字符串 text
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="!!!not-base64!!!">')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="YWJj=">')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="YWJj">')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="e30=">')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="eyJ0ZXh0IjoxMjN9">')).toEqual([]);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="bnVsbA==">')).toEqual([]);
    expect(extractFaceXmlTexts(undefined)).toEqual([]);
    expect(extractFaceXmlTexts('')).toEqual([]);
    expect(extractFaceXmlTexts('普通文本')).toEqual([]);

    // 单引号、不带方括号、带空格方括号及多组方括号
    expect(extractFaceXmlTexts("<faceType=4, ext='eyJ0ZXh0Ijoi5aSn56yRIn0='>")).toEqual(['大笑']);
    expect(
      extractFaceXmlTexts('<faceType=4,faceId="",ext="eyJ0ZXh0IjoiICBbIOWdj+eskSBdICAifQ==">')
    ).toEqual(['坏笑']);
    expect(extractFaceXmlTexts('<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW2FdW2JdIn0=">')).toEqual([
      '[a][b]',
    ]);

    // 多标签混排（跳过空 ext，保留出现顺序）
    expect(
      extractFaceXmlTexts(
        '<faceType=4,faceId="",ext="eyJ0ZXh0IjoiW+WGheacieWdj+eMq10ifQ=="> 哈哈 <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0="><faceType=4, ext=\'eyJ0ZXh0IjoiW+W8gOW/g10ifQ==\'>'
      )
    ).toEqual(['内有坏猫', '开心']);
  });
});
