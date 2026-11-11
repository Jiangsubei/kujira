/**
 * tests/contract/negative-msg-id.test.ts
 *
 * 契约测试: 入站/出站字符串 ID 隔离与三 ID 模型契约（替代旧版 32 位整数负数 message_id 契约）
 *
 * QQ 官方 Bot API v2 三 ID 严格隔离模型：
 * 1. 入站被动回复锚点 `msg_id`: 来自 `C2C_MESSAGE_CREATE` 的 `d.id`（`ROBOT1.0_...` 字符串，不得被 Number() 强转）；
 * 2. 出站消息撤回 ID `id`: 来自发送响应 `body.id`（仅用于 120s 内 DELETE 撤回，绝不混用为被动锚点）；
 * 3. 引用索引 `ref_idx`: 来自 `message_scene.ext` (`msg_idx=REFIDX_...` / `ref_msg_idx=REFIDX_...`) 或出站 `ext_info.ref_idx`。
 */

import { describe, it, expect } from 'vitest';
import {
  extractMessageRefIdx,
  extractQuotedRefIdx,
  isPermanentRefIdx,
  shouldWakeup,
} from '../../src/gateway/wakeup.js';
import { buildOutboundMediaAttachment } from '../../src/attachment/outbound.js';
import { deserializeAttachments, serializeAttachments } from '../../src/attachment/store.js';
import type {
  InboundReplyContext,
  QQC2CMessageCreateEvent,
  QQSendMessagePayload,
  QQSendMessageResponse,
} from '../../src/types/index.js';

const MOCK_OPENID = 'A1B2C3D4E5F60123456789ABCDEF0007';

describe('契约测试: 官方字符串 ID 保真与三 ID 严格隔离', () => {
  it('契约 1: 入站 ROBOT1.0_... 字符串 msg_id 在 shouldWakeup 中原样保真（严禁数值化为 NaN）', async () => {
    const inboundId = 'ROBOT1.0_aBcDeF0123456789_xyz-99887766554433221100';
    const event: QQC2CMessageCreateEvent = {
      id: inboundId,
      content: '测试入站字符串消息 ID 保真',
      timestamp: '2026-11-11T18:28:47+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 0,
    };

    const decision = await shouldWakeup(event);
    expect(decision.wakeup).toBe(true);
    expect(typeof decision.payload?.msg_id).toBe('string');
    expect(decision.payload?.msg_id).toBe(inboundId);
  });

  it('契约 2: 负数样式/纯数字字符串 ID 同样保持精确字符串形态，不被 Number() 截断精度', async () => {
    const bigDigitId = '9007199254740993123456';
    const negativeStyleId = '-837578626';

    for (const id of [bigDigitId, negativeStyleId]) {
      const event: QQC2CMessageCreateEvent = {
        id,
        content: '字符串 ID 精度保真',
        timestamp: '2026-11-11T18:28:47+08:00',
        author: { user_openid: MOCK_OPENID, username: '' },
        message_type: 0,
      };
      const decision = await shouldWakeup(event);
      expect(decision.payload?.msg_id).toBe(id);
      expect(typeof decision.payload?.msg_id).toBe('string');
    }
  });

  it('契约 3: 三 ID 隔离 — 入站 msg_id、自身 ref_idx、被引用 ref_msg_idx 互不串用', async () => {
    const inboundId = 'ROBOT1.0_inbound_anchor_001';
    const selfRefIdx = 'REFIDX_inbound_self_991';
    const quotedRefIdx = 'REFIDX_quoted_outbound_881';
    const outboundRecallId = 'ROBOT1.0_outbound_recall_only_771';

    const event: QQC2CMessageCreateEvent = {
      id: inboundId,
      content: '引用这条消息',
      timestamp: '2026-11-11T18:29:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '' },
      message_type: 103,
      message_scene: {
        ext: [`msg_idx=${selfRefIdx}`, `ref_msg_idx=${quotedRefIdx}`],
      },
    };

    expect(extractMessageRefIdx(event)).toBe(selfRefIdx);
    expect(extractQuotedRefIdx(event)).toBe(quotedRefIdx);
    expect(isPermanentRefIdx(selfRefIdx)).toBe(true);
    expect(isPermanentRefIdx(inboundId)).toBe(false);

    const decision = await shouldWakeup(event, {
      getMessageByRefIdx: async (refIdx) => {
        expect(refIdx).toBe(quotedRefIdx);
        return {
          msg_id: outboundRecallId,
          ref_idx: quotedRefIdx,
          user_id: 'bot',
          sender_name: 'Kujira',
          self: 1,
          content: '机器人历史回复',
        };
      },
    });

    expect(decision.wakeup).toBe(true);
    expect(decision.trigger).toBe('quote');
    // 入站被动锚点仍为 event.id，绝不被出站撤回 ID 覆盖
    expect(decision.payload?.msg_id).toBe(inboundId);
    expect(decision.payload?.ref_idx).toBe(selfRefIdx);
    expect(decision.payload?.quoted?.msg_id).toBe(outboundRecallId);
    expect(decision.payload?.quoted?.ref_idx).toBe(quotedRefIdx);

    // 校验运行态上下文与发信载荷结构中的三 ID 语义边界
    const replyCtx: InboundReplyContext = {
      msg_id: decision.payload!.msg_id,
      ref_idx: decision.payload!.ref_idx,
      from_user: decision.payload!.from_user,
    };
    const sendPayload: QQSendMessagePayload = {
      msg_type: 0,
      content: '收到',
      msg_id: replyCtx.msg_id,
      msg_seq: 1,
      message_reference: { message_id: replyCtx.ref_idx! },
    };
    const mockSendRes: QQSendMessageResponse = {
      id: outboundRecallId,
      ext_info: { ref_idx: quotedRefIdx },
    };

    expect(sendPayload.msg_id).toBe(inboundId);
    expect(sendPayload.message_reference?.message_id).toBe(selfRefIdx);
    expect(mockSendRes.id).not.toBe(sendPayload.msg_id);
  });

  it('契约 4: 附件描述符中的字符串 fileUuid / fileInfo 经序列化/反序列化往返保持原样', () => {
    const desc = buildOutboundMediaAttachment({
      kind: 'image',
      localPath: '/tmp/out.png',
      fileUuid: '00001234-abcd-5678-ef90',
      fileInfo: 'CgYK...base64_file_info...',
    });

    const serialized = serializeAttachments([desc]);
    const restored = deserializeAttachments(serialized);

    expect(restored).toHaveLength(1);
    expect(restored[0]!.remote?.fileUuid).toBe('00001234-abcd-5678-ef90');
    expect(restored[0]!.remote?.fileInfo).toBe('CgYK...base64_file_info...');
  });
});
