/**
 * 契约测试: send_qq_message 单聊引用、多段切分与移除 at_user 规则契约
 *
 * 覆盖规范清单:
 * 契约 1: 显式传入 REFIDX_... 引用索引时，正确下发 message_reference.message_id；
 * 契约 2: 传入本地库内 msg_id 时，自动查库换取对应 REFIDX_... 后下发；
 * 契约 3: 未传 reply_to 时不携带 message_reference；
 * 契约 4: 超出 16 KiB UTF-8 字节切分多条下发时，仅第 1 段携带 message_reference，后续分段均不重复携带；
 * 契约 5: 工具 schema 不再暴露 at_user，且拒绝群聊 peer；
 * 契约 6: 所有输出严格符合 DSH Lossless JSON 约束（无 undefined 字段）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { sendQqMessage, createSendQqMessageTool } from '../../src/tools/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import { QQ_MESSAGE_MAX_BYTES } from '../../src/constants/index.js';

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

  function setupMockGateway() {
    const sent: Array<{ openid: string; payload: any }> = [];
    let seq = 1000;
    const gateway = {
      sendC2CMessage: vi.fn(async (openid: string, payload: any) => {
        sent.push({ openid, payload });
        seq += 1;
        return {
          ok: true,
          status: 200,
          body: {
            id: `ROBOT1.0_OUT_${seq}`,
            ext_info: { ref_idx: `REFIDX_OUT_${seq}` },
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

  it('契约 1: 显式传入 REFIDX_... 时，直接下发 message_reference.message_id', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      {
        text: '这是带引用的单聊消息',
        reply_to: 'REFIDX_EXPLICIT_8888',
      },
      {
        gateway,
        db,
        peer: TEST_PEER,
      }
    );

    expect(res.success).toBe(true);
    expect(res.message_id).toBe('ROBOT1.0_OUT_1001');
    expect(res.ref_idx).toBe('REFIDX_OUT_1001');
    assertNoUndefinedFields(res);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.openid).toBe(MOCK_OPENID);
    expect(sent[0]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_EXPLICIT_8888',
    });
  });

  it('契约 2: 传入本地库 msg_id 时，自动反查并换取 ref_idx 下发', async () => {
    const { gateway, sent } = setupMockGateway();

    db.saveMessage({
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
      source: 'qq',
    });

    const res = await sendQqMessage(
      {
        text: '引用历史消息回复',
        reply_to: 'ROBOT1.0_HIST_777',
      },
      {
        gateway,
        db,
        peer: TEST_PEER,
      }
    );

    expect(res.success).toBe(true);
    assertNoUndefinedFields(res);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_FROM_DB_777',
    });
  });

  it('契约 3: 未传 reply_to 时不携带 message_reference', async () => {
    const { gateway, sent } = setupMockGateway();

    const res = await sendQqMessage(
      { text: '普通单聊消息' },
      { gateway, db, peer: TEST_PEER }
    );

    expect(res.success).toBe(true);
    assertNoUndefinedFields(res);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.message_reference).toBeUndefined();
  });

  it('契约 4: 超出 16 KiB UTF-8 字节切分多条下发时，仅首段携带 message_reference', async () => {
    const { gateway, sent } = setupMockGateway();

    const part1 = '甲'.repeat(6000); // 18000 UTF-8 bytes > 16384
    const part2 = '乙'.repeat(2000);
    const longText = `${part1}\n${part2}`;
    expect(Buffer.byteLength(longText, 'utf8')).toBeGreaterThan(QQ_MESSAGE_MAX_BYTES);

    const res = await sendQqMessage(
      {
        text: longText,
        reply_to: 'REFIDX_FIRST_ONLY',
      },
      {
        gateway,
        db,
        peer: TEST_PEER,
      }
    );

    expect(res.success).toBe(true);
    assertNoUndefinedFields(res);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.payload.message_reference).toEqual({
      message_id: 'REFIDX_FIRST_ONLY',
    });
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.payload.message_reference).toBeUndefined();
    }
  });

  it('契约 5: 工具 schema 移除 at_user，execute 支持 kujira-user-<hash> 绑定并拦截群聊 peer', async () => {
    const { gateway, sent } = setupMockGateway();
    const bridge = new OutboundStreamBridge(new Context(), { gateway, db });

    const tool = createSendQqMessageTool({
      outboundBridge: bridge,
      db,
    });
    const schemaProps = (tool.parameters as any)?.properties;
    expect(schemaProps?.at_user).toBeUndefined();
    expect(schemaProps?.reply_to?.type).toBe('string');

    const res = await tool.execute(
      { text: '通过工具执行下发', reply_to: 'REFIDX_TOOL_1' },
      { agent: { session: { id: `${TEST_SESSION}-r1-2` } } } as any
    );
    expect((res as any).success).toBe(true);
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
