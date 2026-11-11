/**
 * tests/contract/recall-self-content.test.ts
 *
 * 契约测试: 单聊撤回内容保留策略与仅短出站 ID (`msg_self_*`) 撤回语义契约
 *
 * 规范:
 * 1. 机器人自身消息撤回 → recalled=1，但原文必须保留（上下文压缩后可回溯）；
 * 2. 他人消息撤回 → 内容替换为「〔已撤回〕」占位；
 * 3. `recall_message` 仅接收出站短 ID (`msg_self_<n>`)，查库换取真实 `msg_id` (`ROBOT1.0_...`) 调 DELETE 并立即标记本地记录；
 * 4. 传入入站短 ID (`msg_<n>`) 或非短 ID（如 `ROBOT1.0_...`、`REFIDX_...`、空串）直接在本地拒绝且不发起 DELETE；
 *    遇 40064004（超 2 分钟硬时限）返回清晰可读错误。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MessageDatabase } from '../../src/storage/database.js';
import { recallMessage } from '../../src/tools/index.js';
import type { MessageRecord } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';
import { formatShortMessageId } from '../../src/utils/short-id.js';

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

/**
 * 兼容 Batch 2A 合入前后的 DB 短 ID 查询辅助：
 * - 若 DB 实例已具备 Batch 2A 的 `getMessageByShortId`，直接使用原生方法；
 * - 否则在真实 `MessageDatabase` 之上按同协议补充内存 `short_id -> msg_id` 索引。
 */
function createShortIdAwareDb(db: MessageDatabase) {
  const hasNative = typeof (db as any).getMessageByShortId === 'function';
  const fallbackMap = new Map<string, string>();
  const seqCounters = new Map<string, number>();

  const seedMessage = (rec: MessageRecord): string => {
    db.saveMessageIfNotExists(rec);
    const persisted = db.getMessage(rec.msg_id);
    if (persisted?.short_id) {
      return persisted.short_id;
    }
    if (rec.short_id) {
      fallbackMap.set(`${rec.peer}:${rec.short_id}`, rec.msg_id);
      return rec.short_id;
    }
    const dirKey = `${rec.peer}:${rec.self ? 1 : 0}`;
    const seq = (seqCounters.get(dirKey) ?? 0) + 1;
    seqCounters.set(dirKey, seq);
    const shortId = formatShortMessageId(Boolean(rec.self), seq);
    fallbackMap.set(`${rec.peer}:${shortId}`, rec.msg_id);
    return shortId;
  };

  const dbForTool: MessageDatabase = hasNative
    ? db
    : (Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
        getMessageByShortId(peer: string, shortId: string): MessageRecord | null {
          const rawId = fallbackMap.get(`${peer}:${shortId}`);
          if (!rawId) return null;
          return db.getMessage(rawId);
        },
      }) as MessageDatabase);

  return { dbForTool, seedMessage };
}

describe('契约测试: 单聊撤回内容保留策略与仅短 ID 撤回契约', () => {
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

    const stored = db.getMessage('ROBOT1.0_SELF_201')!;
    const history = db.readHistory(PEER, { self_only: true });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.msg_id).toBe(stored.short_id || stored.msg_id);
    expect(history.messages[0]!.content).toBe('需要保留的原文');
    expect(history.messages[0]!.recalled).toBe(true);
  });

  it('契约 3: recall_message 凭出站短 ID (msg_self_*) 解析真实 msg_id 调 DELETE 并立即标库', async () => {
    const outId = 'ROBOT1.0_OUTBOUND_ABC_301';
    const { dbForTool, seedMessage } = createShortIdAwareDb(db);
    const outShortId = seedMessage(record({ msg_id: outId, self: 1, content: '工具撤回的原文' }));

    const deleteSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {},
    }));
    const gateway: any = {
      deleteC2CMessage: deleteSpy,
    };

    const res = await recallMessage(
      { message_id: outShortId },
      { gateway, db: dbForTool, peer: PEER }
    );

    expect(res.success).toBe(true);
    assertNoUndefinedFields(res);
    expect(deleteSpy).toHaveBeenCalledWith(MOCK_OPENID, outId, undefined);

    const msg = db.getMessage(outId)!;
    expect(msg.recalled).toBe(1);
    expect(msg.content).toBe('工具撤回的原文');
  });

  it('契约 4: 40064004 超 2 分钟、入站短 ID (msg_*) 与非短 ID 本地拦截不打 DELETE', async () => {
    const { dbForTool, seedMessage } = createShortIdAwareDb(db);
    const oldOutShortId = seedMessage(
      record({ msg_id: 'ROBOT1.0_OUT_OLD', self: 1, content: '超时消息' })
    );
    const inboundShortId = seedMessage(
      record({ msg_id: 'ROBOT1.0_INBOUND_MSG', self: 0, content: '用户入站消息' })
    );

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
      { message_id: oldOutShortId },
      { gateway: gwExpired, db: dbForTool, peer: PEER }
    );
    expect(resExpired.success).toBe(false);
    expect(resExpired.error).toContain('40064004');
    expect(resExpired.error).toContain('2 分钟');
    assertNoUndefinedFields(resExpired);

    // 2. 入站短 ID msg_* 本地直接拒绝，不发起 DELETE 请求
    const deleteSpy = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
    const gwSpy: any = { deleteC2CMessage: deleteSpy };

    const resInbound = await recallMessage(
      { message_id: inboundShortId },
      { gateway: gwSpy, db: dbForTool, peer: PEER }
    );
    expect(resInbound.success).toBe(false);
    expect(resInbound.error).toContain('INBOUND_NOT_RECALLABLE');
    expect(resInbound.error).toContain('msg_self_*');
    expect(deleteSpy).not.toHaveBeenCalled();
    assertNoUndefinedFields(resInbound);

    // 3. 非短 ID（原始 ROBOT1.0_* / REFIDX_* / 空串）本地直接拒绝，不发起 DELETE 请求
    const resRaw = await recallMessage(
      { message_id: 'ROBOT1.0_INBOUND_MSG' },
      { gateway: gwSpy, db: dbForTool, peer: PEER }
    );
    expect(resRaw.success).toBe(false);
    expect(resRaw.error).toContain('INVALID_SHORT_ID');
    expect(deleteSpy).not.toHaveBeenCalled();
    assertNoUndefinedFields(resRaw);

    const resEmpty = await recallMessage(
      { message_id: '   ' },
      { gateway: gwSpy, db: dbForTool, peer: PEER }
    );
    expect(resEmpty.success).toBe(false);
    expect(deleteSpy).not.toHaveBeenCalled();
    assertNoUndefinedFields(resEmpty);

    // 4. 库中未命中的出站短 ID 本地拒绝，不发起 DELETE 请求
    const resMissing = await recallMessage(
      { message_id: 'msg_self_999' },
      { gateway: gwSpy, db: dbForTool, peer: PEER }
    );
    expect(resMissing.success).toBe(false);
    expect(resMissing.error).toContain('NOT_FOUND');
    expect(deleteSpy).not.toHaveBeenCalled();
    assertNoUndefinedFields(resMissing);
  });
});
