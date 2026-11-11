/**
 * tests/contract/outbound-self-record.test.ts
 *
 * 契约测试: QQ 官方 Bot 出站消息自身落库 (Outbound Self Record) 与短消息 ID (`short_id`) 同步回填
 *
 * 覆盖规范:
 * 1. 纯函数构造: 字符串 `msg_id` (`ROBOT1.0_...`)、`ref_idx` (`REFIDX_...`)、`reply_to`、`self = 1`，不含 `undefined`；
 * 2. REST 发送返回 200 并拿到字符串 `id` 与可选 `ext_info.ref_idx` 后立即写入 `messages`，并获取分配好的 `short_id` (`msg_self_<n>`)；
 * 3. `recordOutboundSelfMessage` 返回带 `short_id` 的 `record`（无论库层直接写回还是通过 `getMessage` 回查），并在 debug 日志输出 `short_id`；
 * 4. 发送失败、缺有效字符串 `msgId`、空正文或 `msg_type=6` 输入状态绝不落库；
 * 5. 幂等入库（`saveMessageIfNotExists` 不重复、不覆盖）与三 ID 严格隔离（出站 `body.id` 绝不写入 `inbound_reply_slots`）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { KujiraGatewayClient, type OutboundSentEvent } from '../../src/gateway/server.js';
import {
  buildSelfMessageRecord,
  recordOutboundSelfMessage,
  type SelfRecordDb,
} from '../../src/outbound/self-record.js';
import type { MessageRecord } from '../../src/types/index.js';
import { openidToPeer } from '../../src/utils/peer.js';
import { formatShortMessageId } from '../../src/utils/short-id.js';

const BOT_ID = '1000000000';
const TEST_OPENID = '00112233445566778899AABBCCDDEEFF';
const TEST_PEER = openidToPeer(TEST_OPENID);
const SENDER_NAME = '测试助手';

function createV2TestDb(dbPath: string): {
  raw: Database.Database;
  adapter: SelfRecordDb;
  getMessage: (msgId: string) => any;
  listInboundSlots: () => any[];
} {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY,
      short_id TEXT,
      peer TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      time INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      raw TEXT NOT NULL,
      file_id TEXT,
      local_path TEXT,
      fingerprint TEXT,
      recalled INTEGER NOT NULL DEFAULT 0,
      self INTEGER NOT NULL DEFAULT 0,
      reply_to TEXT,
      ref_idx TEXT,
      source TEXT NOT NULL DEFAULT 'qq',
      attachments TEXT
    );

    CREATE TABLE IF NOT EXISTS inbound_reply_slots (
      msg_id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      openid TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  const insertStmt = raw.prepare(`
    INSERT OR IGNORE INTO messages (
      msg_id, short_id, peer, user_id, sender_name, time, type, content, raw,
      file_id, local_path, fingerprint, recalled, self, reply_to, ref_idx, source, attachments
    ) VALUES (
      @msg_id, @short_id, @peer, @user_id, @sender_name, @time, @type, @content, @raw,
      @file_id, @local_path, @fingerprint, @recalled, @self, @reply_to, @ref_idx, @source, @attachments
    )
  `);

  const peerCounters = new Map<string, number>();

  const getMessage = (msgId: string): MessageRecord | null => {
    const row = raw.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId) as any;
    return row ?? null;
  };

  const adapter: SelfRecordDb = {
    getMessage,
    saveMessageIfNotExists(record: MessageRecord): boolean {
      const existing = getMessage(record.msg_id);
      if (existing) {
        return false;
      }
      const dirKey = `${record.peer}:${record.self ? 1 : 0}`;
      const nextSeq = (peerCounters.get(dirKey) ?? 0) + 1;
      const assignedShortId = record.short_id || formatShortMessageId(Boolean(record.self), nextSeq);

      const result = insertStmt.run({
        msg_id: record.msg_id,
        short_id: assignedShortId,
        peer: record.peer,
        user_id: record.user_id,
        sender_name: record.sender_name || '',
        time: record.time,
        type: record.type,
        content: record.content,
        raw: record.raw,
        file_id: record.file_id ?? null,
        local_path: record.local_path ?? null,
        fingerprint: record.fingerprint ?? null,
        recalled: record.recalled ? 1 : 0,
        self: record.self ? 1 : 0,
        reply_to: record.reply_to ?? null,
        ref_idx: record.ref_idx ?? null,
        source: record.source ?? 'qq',
        attachments: record.attachments ?? null,
      });
      if (result.changes > 0) {
        peerCounters.set(dirKey, nextSeq);
        record.short_id = assignedShortId;
        return true;
      }
      return false;
    },
  };

  return {
    raw,
    adapter,
    getMessage,
    listInboundSlots: () => raw.prepare('SELECT * FROM inbound_reply_slots').all(),
  };
}

describe('契约测试: 出站消息自身记录 (纯函数 buildSelfMessageRecord)', () => {
  const base = { botId: BOT_ID, senderName: SENDER_NAME };

  it('契约 1: 纯文本/Markdown 出站 -> self=1、string msg_id、ref_idx、reply_to 正确且无 undefined', () => {
    const record = buildSelfMessageRecord(
      {
        peer: TEST_PEER,
        openid: TEST_OPENID,
        msgId: 'ROBOT1.0_OUT_TEXT_001',
        refIdx: 'REFIDX_OUT_TEXT_001',
        replyTo: 'ROBOT1.0_IN_001',
        msgType: 2,
        text: '# 你好呀\n这是单聊 Markdown 回复',
        payload: { msg_type: 2, markdown: { content: '# 你好呀\n这是单聊 Markdown 回复' } },
        time: 1793800000000,
      },
      base
    );

    expect(record).not.toBeNull();
    expect(record!.msg_id).toBe('ROBOT1.0_OUT_TEXT_001');
    expect(record!.ref_idx).toBe('REFIDX_OUT_TEXT_001');
    expect(record!.reply_to).toBe('ROBOT1.0_IN_001');
    expect(record!.peer).toBe(TEST_PEER);
    expect(record!.user_id).toBe(BOT_ID);
    expect(record!.sender_name).toBe(SENDER_NAME);
    expect(record!.self).toBe(1);
    expect(record!.recalled).toBe(0);
    expect(record!.type).toBe('reply');
    expect(record!.source).toBe('qq');
    expect(record!.content).toBe('# 你好呀\n这是单聊 Markdown 回复');
    expect((record as any).busid).toBeUndefined();

    for (const [key, value] of Object.entries(record!)) {
      expect(value, `字段 ${key} 不应为 undefined`).not.toBeUndefined();
    }
  });

  it('契约 2: 无 replyTo 时 type=text，refIdx 缺失时 ref_idx=null', () => {
    const record = buildSelfMessageRecord(
      {
        peer: TEST_PEER,
        openid: TEST_OPENID,
        msgId: 'ROBOT1.0_OUT_TEXT_002',
        msgType: 2,
        text: '纯文本消息',
        time: 1793800001000,
      },
      base
    )!;

    expect(record.type).toBe('text');
    expect(record.ref_idx).toBeNull();
    expect(record.reply_to).toBeNull();
  });

  it('契约 3: 图片与文件附件描述符 -> 类型与本地路径准确落库', () => {
    const imgRecord = buildSelfMessageRecord(
      {
        peer: TEST_PEER,
        openid: TEST_OPENID,
        msgId: 'ROBOT1.0_OUT_IMG_001',
        msgType: 7,
        time: 1793800002000,
        attachments: [
          {
            kind: 'image',
            origin: 'outbound',
            local: { path: '/tmp/out.png', format: 'png', fingerprint: 'fp_1' },
            remote: { fileId: 'uuid_img_1' },
          },
        ],
      },
      base
    )!;

    expect(imgRecord.type).toBe('image');
    expect(imgRecord.content).toBe('[图片:/tmp/out.png]');
    expect(imgRecord.local_path).toBe('/tmp/out.png');
    expect(imgRecord.file_id).toBe('uuid_img_1');
    expect(imgRecord.fingerprint).toBe('fp_1');

    const fileRecord = buildSelfMessageRecord(
      {
        peer: TEST_PEER,
        openid: TEST_OPENID,
        msgId: 'ROBOT1.0_OUT_FILE_001',
        msgType: 7,
        time: 1793800003000,
        attachments: [
          {
            kind: 'file',
            origin: 'outbound',
            fileName: 'report.pdf',
            local: { path: '/tmp/report.pdf' },
          },
        ],
      },
      base
    )!;
    expect(fileRecord.type).toBe('file');
    expect(fileRecord.content).toBe('[文件:report.pdf 已保存: /tmp/report.pdf]');
  });

  it('契约 4: 空 msgId 或空正文不产生记录', () => {
    expect(
      buildSelfMessageRecord(
        { peer: TEST_PEER, openid: TEST_OPENID, msgId: '', msgType: 2, text: 'hello', time: 1793800004000 },
        base
      )
    ).toBeNull();
    expect(
      buildSelfMessageRecord(
        { peer: TEST_PEER, openid: TEST_OPENID, msgId: 'ROBOT1.0_EMPTY', msgType: 2, text: '   ', time: 1793800005000 },
        base
      )
    ).toBeNull();
  });
});

describe('契约测试: KujiraGatewayClient + SQLite 出站自记录、short_id 回填与三 ID 隔离闭环', () => {
  let tmpDir: string;
  let dbBundle: ReturnType<typeof createV2TestDb>;
  let sentEvents: OutboundSentEvent[];
  let recordedRecords: MessageRecord[];
  let debugLogs: string[];

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-self-record-'));
    dbBundle = createV2TestDb(path.join(tmpDir, 'messages.sqlite'));
    sentEvents = [];
    recordedRecords = [];
    debugLogs = [];
  });

  afterEach(async () => {
    dbBundle.raw.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function createMockClient(responder: (url: string, init?: RequestInit) => Promise<Response>) {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('getAppAccessToken')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 7200 }), { status: 200 });
      }
      return responder(url, init);
    };

    return new KujiraGatewayClient({
      credentials: { appId: 'mock_app_id', appSecret: 'mock_app_secret' },
      fetchFn: fetchMock,
      onMessageSent: (event) => {
        sentEvents.push(event);
        const rec = recordOutboundSelfMessage(event, {
          db: dbBundle.adapter,
          botId: BOT_ID,
          senderName: SENDER_NAME,
          logger: {
            debug: (msg: string) => debugLogs.push(msg),
          },
        });
        if (rec) recordedRecords.push(rec);
      },
    });
  }

  it('端到端 1: REST 发送成功拿到 body.id 与 ext_info.ref_idx -> 立即写入 messages 并回填 short_id，debug 日志含 short_id，绝不写入 inbound_reply_slots', async () => {
    const client = createMockClient(async () =>
      new Response(
        JSON.stringify({
          id: 'ROBOT1.0_OUT_LIVE_001',
          timestamp: '2026-11-11T18:30:00+08:00',
          ext_info: { ref_idx: 'REFIDX_OUT_LIVE_001' },
        }),
        { status: 200 }
      )
    );

    const res = await client.sendC2CMessage(
      TEST_OPENID,
      {
        msg_type: 2,
        markdown: { content: '你好单聊' },
        message_reference: { message_id: 'REFIDX_IN_PREV' },
        msg_id: 'ROBOT1.0_INBOUND_001',
        msg_seq: 1,
      },
      {
        peer: TEST_PEER,
        replyTo: 'ROBOT1.0_IN_PREV',
      }
    );

    expect(res.ok).toBe(true);
    expect(sentEvents).toHaveLength(1);
    expect(recordedRecords).toHaveLength(1);
    expect(recordedRecords[0]!.short_id).toBe('msg_self_1');

    const row = dbBundle.getMessage('ROBOT1.0_OUT_LIVE_001');
    expect(row).toBeDefined();
    expect(row.short_id).toBe('msg_self_1');
    expect(row.self).toBe(1);
    expect(row.peer).toBe(TEST_PEER);
    expect(row.user_id).toBe(BOT_ID);
    expect(row.sender_name).toBe(SENDER_NAME);
    expect(row.content).toBe('你好单聊');
    expect(row.ref_idx).toBe('REFIDX_OUT_LIVE_001');
    expect(row.reply_to).toBe('ROBOT1.0_IN_PREV');

    expect(debugLogs.some((line) => line.includes('short_id: msg_self_1'))).toBe(true);

    // 严禁把出站 body.id 写入入站槽位表
    expect(dbBundle.listInboundSlots()).toHaveLength(0);
  });

  it('端到端 1b: 若 saveMessageIfNotExists 未原地赋值 short_id（或幂等重复），通过 db.getMessage 回查补全并返回带 short_id 的 record', () => {
    const getMessageMock = vi.fn().mockReturnValue({
      msg_id: 'ROBOT1.0_OUT_BACKFILL_1',
      short_id: 'msg_self_7',
    });
    const dbNoMutate: SelfRecordDb = {
      saveMessageIfNotExists: () => true,
      getMessage: getMessageMock,
    };
    const logs: string[] = [];

    const rec = recordOutboundSelfMessage(
      {
        peer: TEST_PEER,
        openid: TEST_OPENID,
        msgId: 'ROBOT1.0_OUT_BACKFILL_1',
        msgType: 2,
        text: '回查补全短 ID',
        time: 1793800009000,
      },
      {
        db: dbNoMutate,
        botId: BOT_ID,
        senderName: SENDER_NAME,
        logger: { debug: (m: string) => logs.push(m) },
      }
    );

    expect(rec?.short_id).toBe('msg_self_7');
    expect(getMessageMock).toHaveBeenCalledWith('ROBOT1.0_OUT_BACKFILL_1');
    expect(logs[0]).toContain('short_id: msg_self_7');
  });

  it('端到端 2: 发送失败 (HTTP 400) 或 msg_type=6 输入状态 -> 绝不触发落库', async () => {
    const failingClient = createMockClient(async () =>
      new Response(JSON.stringify({ code: 40034024, message: '请求参数msg_id无效或越权' }), { status: 400 })
    );
    const failRes = await failingClient.sendC2CMessage(TEST_OPENID, { msg_type: 2, markdown: { content: '失败消息' } });
    expect(failRes.ok).toBe(false);
    expect(sentEvents).toHaveLength(0);

    const notifyClient = createMockClient(async () =>
      new Response(JSON.stringify({ id: 'ROBOT1.0_INPUT_NOTIFY_TEMP' }), { status: 200 })
    );
    const notifyRes = await notifyClient.sendInputNotify(TEST_OPENID, 'ROBOT1.0_INBOUND_001', 1);
    expect(notifyRes.ok).toBe(true);
    expect(sentEvents).toHaveLength(0);
    expect(dbBundle.getMessage('ROBOT1.0_INPUT_NOTIFY_TEMP')).toBeNull();
  });

  it('端到端 3: 幂等入库 -> 相同 msg_id 重复触发不覆盖原内容与原 short_id', async () => {
    const client = createMockClient(async () =>
      new Response(JSON.stringify({ id: 'ROBOT1.0_OUT_DUP' }), { status: 200 })
    );

    await client.sendC2CMessage(TEST_OPENID, { msg_type: 2, markdown: { content: '原始消息' } });
    const insertedAgain = dbBundle.adapter.saveMessageIfNotExists({
      ...buildSelfMessageRecord(
        { peer: TEST_PEER, openid: TEST_OPENID, msgId: 'ROBOT1.0_OUT_DUP', msgType: 2, text: '被覆盖文本', time: Date.now() },
        { botId: BOT_ID, senderName: SENDER_NAME }
      )!,
    });
    expect(insertedAgain).toBe(false);
    expect(dbBundle.getMessage('ROBOT1.0_OUT_DUP').content).toBe('原始消息');
    expect(dbBundle.getMessage('ROBOT1.0_OUT_DUP').short_id).toBe('msg_self_1');
  });
});
