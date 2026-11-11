/**
 * tests/contract/recall-self-content.test.ts
 *
 * 契约测试: 单聊撤回内容保留策略与官方 Bot API 撤回错误语义契约
 *
 * 规范:
 * 1. 机器人自身消息撤回 → recalled=1，但原文必须保留（上下文压缩后可回溯）；
 * 2. 他人消息撤回 → 内容替换为「〔已撤回〕」占位；
 * 3. recall_message 必须使用 string message_id（如 ROBOT1.0_...），绝不强转为数字；
 *    撤回成功后立即标记本地记录；
 * 4. 遇 40064004（超 2 分钟硬时限）或 40061002（入站 ID 不可撤回）返回清晰可读错误。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import { recallMessage } from '../../src/tools/index.js';
import type { MessageRecord } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'BBBBCCCCDDDDEEEEFFFF000011112222';
const PEER = openidToPeer(MOCK_OPENID);

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

function record(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    msg_id: 'ROBOT1.0_BASE_1',
    peer: PEER,
    user_id: MOCK_OPENID,
    sender_name: '',
    time: 1793800000000,
    type: 'text',
    content: '原文',
    raw: '{}',
    file_id: null,
    local_path: null,
    fingerprint: null,
    recalled: 0,
    self: 0,
    reply_to: null,
    ref_idx: null,
    source: 'qq',
    ...overrides,
  };
}

describe('契约测试: 单聊撤回内容保留策略与官方撤回契约', () => {
  let tmpDir: string;
  let db: MessageDatabase;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-recall-content-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();
    db.upsertPeerOpenid(PEER, MOCK_OPENID);
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: 自身消息撤回保留原文，他人消息撤回占位', () => {
    db.saveMessage(record({ msg_id: 'ROBOT1.0_SELF_101', self: 1, content: '我自己说的话' }));
    db.saveMessage(record({ msg_id: 'ROBOT1.0_OTHER_102', self: 0, content: '别人说的话' }));

    db.markRecalled('ROBOT1.0_SELF_101');
    db.markRecalled('ROBOT1.0_OTHER_102');

    const selfMsg = db.getMessage('ROBOT1.0_SELF_101')!;
    expect(selfMsg.recalled).toBe(1);
    expect(selfMsg.content).toBe('我自己说的话');

    const otherMsg = db.getMessage('ROBOT1.0_OTHER_102')!;
    expect(otherMsg.recalled).toBe(1);
    expect(otherMsg.content).toBe('〔已撤回〕');
  });

  it('契约 2: read_chat_history 仍能读到自身撤回消息的原文（recalled=true）', () => {
    db.saveMessage(record({ msg_id: 'ROBOT1.0_SELF_201', self: 1, content: '需要保留的原文' }));
    db.markRecalled('ROBOT1.0_SELF_201');

    const history = db.readHistory(PEER, { self_only: true });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.msg_id).toBe('ROBOT1.0_SELF_201');
    expect(history.messages[0]!.content).toBe('需要保留的原文');
    expect(history.messages[0]!.recalled).toBe(true);
  });

  it('契约 3: recall_message 透传 string message_id 并立即标记本地记录（不转数字）', async () => {
    const outId = 'ROBOT1.0_OUTBOUND_ABC_301';
    db.saveMessage(record({ msg_id: outId, self: 1, content: '工具撤回的原文' }));

    const deleteSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {},
    }));
    const gateway: any = {
      deleteC2CMessage: deleteSpy,
    };

    const res = await recallMessage(
      { message_id: outId },
      { gateway, db, peer: PEER }
    );

    expect(res.success).toBe(true);
    assertNoUndefinedFields(res);
    expect(deleteSpy).toHaveBeenCalledWith(MOCK_OPENID, outId, undefined);

    const msg = db.getMessage(outId)!;
    expect(msg.recalled).toBe(1);
    expect(msg.content).toBe('工具撤回的原文');
  });

  it('契约 4: 40064004 超 2 分钟与 40061002 入站 ID 错误码返回清晰说明，非法非字符串参数拒绝', async () => {
    // 1. 40064004: 超过 2 分钟硬时限
    const gwExpired: any = {
      deleteC2CMessage: async () => ({
        ok: false,
        status: 400,
        code: 40064004,
        message: '已经超出消息撤回时限',
        body: { code: 40064004, message: '已经超出消息撤回时限' },
      }),
    };
    const resExpired = await recallMessage(
      { message_id: 'ROBOT1.0_OUT_OLD' },
      { gateway: gwExpired, db, peer: PEER }
    );
    expect(resExpired.success).toBe(false);
    expect(resExpired.error).toContain('40064004');
    expect(resExpired.error).toContain('2 分钟');
    assertNoUndefinedFields(resExpired);

    // 2. 40061002: 试图撤回入站 ID
    const gwInbound: any = {
      deleteC2CMessage: async () => ({
        ok: false,
        status: 400,
        code: 40061002,
        message: '请求参数msgid无效',
        body: { code: 40061002, message: '请求参数msgid无效' },
      }),
    };
    const resInbound = await recallMessage(
      { message_id: 'ROBOT1.0_INBOUND_MSG' },
      { gateway: gwInbound, db, peer: PEER }
    );
    expect(resInbound.success).toBe(false);
    expect(resInbound.error).toContain('40061002');
    expect(resInbound.error).toContain('出站消息 ID');
    assertNoUndefinedFields(resInbound);

    // 3. 空/非字符串 message_id 拒绝
    const resEmpty = await recallMessage(
      { message_id: '   ' },
      { gateway: gwInbound, db, peer: PEER }
    );
    expect(resEmpty.success).toBe(false);
    assertNoUndefinedFields(resEmpty);
  });
});
