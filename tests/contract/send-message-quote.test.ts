/**
 * 契约测试: send_qq_message 单聊短 ID 引用、多段切分与参数收敛契约
 *
 * 覆盖规范清单:
 * 契约 1: 传入非短 ID（REFIDX_... / ROBOT1.0_... / msg_0）作为 reply_to 时，本地直接拦截报错，不调用网关；
 * 契约 2: 传入本地库短 ID（msg_<n> / msg_self_<n>）时，自动反查换取对应 REFIDX_... 后下发，且仅返回短出站 ID；
 * 契约 3: 未传 reply_to 时不携带 message_reference；
 * 契约 4: 码点数未超 6000 但超出 16 KiB UTF-8 字节切分多条下发时，仅第 1 段携带 message_reference，后续分段均不重复携带；
 * 契约 5: 工具 schema 不再暴露 at_user 与 markdown，且拒绝群聊 peer；
 * 契约 6: 所有输出严格符合 DSH Lossless JSON 约束（无 undefined 字段，无 ref_idx 与长 ID）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { recordOutboundSelfMessage } from '../../src/outbound/self-record.js';
import { sendQqMessage, createSendQqMessageTool } from '../../src/tools/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import { QQ_MESSAGE_MAX_BYTES, QQ_SEND_MESSAGE_MAX_CHARS } from '../../src/constants/index.js';

const MOCK_OPENID = 'AAAABBBBCCCCDDDDEEEEFFFF00001111';
const TEST_PEER = openidToPeer(MOCK_OPENID);
const TEST_SESSION = openidToSessionBaseId(MOCK_OPENID);

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

describe('契约 1 ~ 6: send_qq_message 单聊引用与分片规则契约', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-quote-contract-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
    db.upsertPeerOpenid(TEST_PEER, MOCK_OPENID);
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function setupMockGateway(recordToDb = true) {
    const sent: Array<{ openid: string; payload: any }> = [];
    let seq = 1000;
    const gateway = {
      sendC2CMessage: vi.fn(async (openid: string, payload: any, meta?: any) => {
        sent.push({ openid, payload });
        seq += 1;
        const rawId = `ROBOT1.0_OUT_${seq}`;
        const refIdx = `REFIDX_OUT_${seq}`;
        if (recordToDb) {
          recordOutboundSelfMessage(
            {
              peer: meta?.peer ?? TEST_PEER,
              openid,
              msgId: rawId,
              refIdx,
              replyTo: meta?.replyTo ?? null,
              msgType: 2,
              text: meta?.text ?? payload?.markdown?.content ?? 'outbound',
              payload,
              time: Date.now(),
            },
            { db, botId: '1000000000', senderName: 'Kujira' }
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
      sendC2CStreamMessage: vi.fn(),
      sendInputNotify: vi.fn(),
      deleteC2CMessage: vi.fn(),
      uploadC2CMedia: vi.fn(),
      emitMessageSent: vi.fn(),
    };
    return { gateway, sent };
  }

  it('契约 1: 传入非短 ID（REFIDX_... / ROBOT1.0_... / msg_0）作为 reply_to 时，本地直接拦截不打网关', async () => {
    const { gateway, sent } = setupMockGateway();

    for (const invalidReplyTo of ['REFIDX_EXPLICIT_8888', 'ROBOT1.0_HIST_777', 'msg_0', '12345']) {
      const res = await sendQqMessage(
        {
          text: '这是带非法引用的单聊消息',
          reply_to: invalidReplyTo,
        },
        {
          gateway,
          db,
          peer: TEST_PEER,
        }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('无效的 reply_to 短消息 ID');
      expect(res.error).toContain('msg_12');
      assertNoUndefinedFields(res);
    }

    expect(sent).toHaveLength(0);
    expect(gateway.sendC2CMessage).not.toHaveBeenCalled();
  });

  it('契约 2: 传入本地库短 ID（msg_1 / msg_self_1）时，自动反查并换取 ref_idx 下发且仅返回短出站 ID', async () => {
    const { gateway, sent } = setupMockGateway();

    const inboundRec = {
      msg_id: 'ROBOT1.0_HIST_777',
      peer: TEST_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: 1793800000000,
      type: 'text',
      content: '历史消息正文',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      ref_idx: 'REFIDX_FROM_DB_777',
      source: 'qq' as const,
    };
    db.saveMessage(inboundRec);

    const res = await sendQqMessage(
      {
        text: '引用历史消息回复',
        reply_to: inboundRec.short_id!,
      },
      {
        gateway,
        db,
        peer: TEST_PEER,
      }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toBe('msg_self_1');
    expect((res as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(res);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.openid).toBe(MOCK_OPENID);
    expect(sent[0]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_FROM_DB_777',
    });

    // 也支持引用机器人自己的出站短消息 ID msg_self_1
    const resSelfQuote = await sendQqMessage(
      {
        text: '引用自己上一条消息',
        reply_to: 'msg_self_1',
      },
      {
        gateway,
        db,
        peer: TEST_PEER,
      }
    );
    expect(resSelfQuote.success).toBe(true);
    expect(resSelfQuote.message_id).toBe('msg_self_2');
    expect((resSelfQuote as any).ref_idx).toBeUndefined();
    expect(sent[1]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_OUT_1001',
    });
  });

  it('契约 3: 未传 reply_to 时不携带 message_reference，且仅返回短出站 ID', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      { text: '普通单聊消息' },
      { gateway, db, peer: TEST_PEER }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toBe('msg_self_1');
    expect((res as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(res);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.message_reference).toBeUndefined();
  });

  it('契约 4: 未超 6000 字符但超出 16 KiB UTF-8 字节切分多条下发时，仅首段携带 message_reference', async () => {
    const { gateway, sent } = setupMockGateway();

    const quoteTarget = {
      msg_id: 'ROBOT1.0_HIST_FIRST_ONLY',
      peer: TEST_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: 1793800001000,
      type: 'text',
      content: '引用目标',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      ref_idx: 'REFIDX_FIRST_ONLY',
      source: 'qq' as const,
    };
    db.saveMessage(quoteTarget);

    // 4 字节 emoji：总计 5501 码点 <= 6000（放行），UTF-8 字节数 22001 > 16384（触发 16 KiB 分段）
    const part1 = '🐳'.repeat(4500);
    const part2 = '🐳'.repeat(1000);
    const longText = `${part1}\n${part2}`;
    expect([...longText].length).toBeLessThanOrEqual(QQ_SEND_MESSAGE_MAX_CHARS);
    expect(Buffer.byteLength(longText, 'utf8')).toBeGreaterThan(QQ_MESSAGE_MAX_BYTES);

    const res = await sendQqMessage(
      {
        text: longText,
        reply_to: quoteTarget.short_id!,
      },
      {
        gateway,
        db,
        peer: TEST_PEER,
      }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toMatch(/^msg_self_[1-9]\d*$/);
    expect((res as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(res);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_FIRST_ONLY',
    });
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.payload.message_reference).toBeUndefined();
    }
  });

  it('契约 5: 工具 schema 移除 at_user 与 markdown，execute 支持 kujira-user-<hash> 绑定并拦截群聊 peer', async () => {
    const { gateway, sent } = setupMockGateway();
    const bridge = new OutboundStreamBridge(new Context(), { gateway, db });

    const targetRec = {
      msg_id: 'ROBOT1.0_TOOL_1',
      peer: TEST_PEER,
      user_id: MOCK_OPENID,
      sender_name: '',
      time: 1793800002000,
      type: 'text',
      content: '工具引用目标',
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: 0,
      reply_to: null,
      ref_idx: 'REFIDX_TOOL_1',
      source: 'qq' as const,
    };
    db.saveMessage(targetRec);

    const tool = createSendQqMessageTool({
      outboundBridge: bridge,
      db,
    });
    const schemaProps = (tool.parameters as any)?.properties;
    expect(schemaProps?.at_user).toBeUndefined();
    expect(schemaProps?.markdown).toBeUndefined();
    expect(schemaProps?.reply_to?.type).toBe('string');

    const res = await tool.execute(
      { text: '通过工具执行下发', reply_to: targetRec.short_id! },
      { agent: { session: { id: `${TEST_SESSION}-r1-2` } } } as any
    );
    expect((res as any).success).toBe(true);
    expect((res as any).message_id).toBe('msg_self_1');
    expect((res as any).ref_idx).toBeUndefined();
    assertNoUndefinedFields(res);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_TOOL_1',
    });

    const denied = await sendQqMessage(
      { text: '不允许群聊' },
      { gateway, db, peer: 'group_3000000001' }
    );
    expect(denied.success).toBe(false);
    assertNoUndefinedFields(denied);
  });
});
