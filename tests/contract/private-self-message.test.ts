import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import Database from 'better-sqlite3';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import type { SessionManager } from '../../src/gateway/session.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import { openidToPeer } from '../../src/utils/peer.js';
import { recordOutboundSelfMessage } from '../../src/outbound/self-record.js';
import { MessageDatabase } from '../../src/storage/database.js';

/**
 * 契约测试: 单聊出站自记录 (onMessageSent -> recordOutboundSelfMessage) 与历史记录查询闭环
 */

const nativeFetch = globalThis.fetch;

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_APP_ID = 'app_kujira_mock';
const MOCK_APP_SECRET = 'secret_kujira_mock';
const MOCK_BOT_ID = 'bot_kujira_01';

class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<(ev: any) => void>>();
  private seq = 1;

  constructor(public readonly url: string) {
    FakeWs.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
      this.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      });
    });
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.op === 2 || frame.op === 6) {
      this.emit('message', {
        data: JSON.stringify({
          op: 0,
          s: this.seq++,
          t: 'READY',
          d: {
            version: 1,
            session_id: 'sess-self-1',
            user: { id: MOCK_BOT_ID, username: '雪梨助手', bot: true },
          },
        }),
      });
    } else if (frame.op === 1) {
      this.emit('message', { data: JSON.stringify({ op: 11 }) });
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: '' });
  }

  emitDispatch(t: string, d: unknown): void {
    this.emit('message', {
      data: JSON.stringify({ op: 0, s: this.seq++, t, d }),
    });
  }

  private emit(type: string, ev: any): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时: ${label}`);
}

describe('契约测试: 单聊出站自记录与 read_chat_history 查询闭环', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let capturedFollowups: any[];
  let outSeq: number;

  function dbPath(): string {
    return path.join(tmpHome, 'kujira', 'messages.sqlite');
  }

  beforeEach(async () => {
    FakeWs.instances = [];
    capturedFollowups = [];
    outSeq = 0;

    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-self-msg-'));
    await fsp.writeFile(
      path.join(tmpHome, '.credentials.yaml'),
      [
        'version: 1',
        'refs:',
        `  QQ_BOT_APP_ID: "${MOCK_APP_ID}"`,
        `  QQ_BOT_SECRET: "${MOCK_APP_SECRET}"`,
        '',
      ].join('\n'),
      'utf8'
    );

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url === 'https://bots.qq.com/app/getAppAccessToken') {
        return new Response(JSON.stringify({ access_token: 'mock_access_token', expires_in: 7200 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.sgroup.qq.com/gateway') {
        return new Response(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.sgroup.qq.com/')) {
        const parsed = new URL(url);
        if (method === 'POST' && parsed.pathname === `/v2/users/${MOCK_OPENID}/messages`) {
          const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : {};
          if (body.msg_type === 6) {
            return new Response(JSON.stringify({ id: 'ROBOT1.0_INPUT_NOTIFY_1' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          outSeq += 1;
          return new Response(
            JSON.stringify({
              id: `ROBOT1.0_OUT_SELF_${outSeq}`,
              timestamp: '2026-11-11T12:00:10+08:00',
              ext_info: { ref_idx: `REFIDX_OUT_SELF_${outSeq}` },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      return nativeFetch(input, init);
    };

    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    vi.stubGlobal('fetch', mockFetch);

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
    });

    const gateway = booted.ctx.get('kujira-gateway') as KujiraGatewayClient;
    const presetsSvc: any = (booted.ctx as any).agentPresets || booted.ctx.get?.('agentPresets');
    await waitUntil(async () => {
      if (!gateway.getStatus().ready || FakeWs.instances.length === 0) return false;
      if (presetsSvc?.list) {
        const list = await presetsSvc.list();
        return Array.isArray(list) && list.some((p: any) => p.id === 'kujira-session');
      }
      return true;
    }, 5000, 'gateway ready and kujira-session registered');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function preparePeerAgent() {
    const sm = booted.ctx.get('kujira-session') as SessionManager;
    const agent = await sm.getOrCreateAgent(MOCK_PEER);
    (agent as any).followup = (msg: any) => {
      capturedFollowups.push(msg);
    };
    (agent as any).steer = (msg: any) => {
      capturedFollowups.push(msg);
    };
    return agent;
  }

  it('契约 1: 真实装配发送拿到 ROBOT1.0_... 与 ref_idx 后，onMessageSent -> recordOutboundSelfMessage 写入 messages(self=1) 且绝不写入 inbound_reply_slots', async () => {
    const agent = await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_SELF_1',
      content: '看看最近一小时聊了啥',
      timestamp: '2026-11-11T12:00:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户B' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IN_SELF_1'] },
    });

    await waitUntil(() => capturedFollowups.length === 1, 5000, 'inbound wakeup');

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    expect(sendTool).toBeDefined();

    const sendRes = await sendTool.execute({ text: '最近一小时聊了代码和工具' }, { agent });
    expect(sendRes.success).toBe(true);
    expect(sendRes.message_id).toBe('ROBOT1.0_OUT_SELF_1');
    expect(sendRes.ref_idx).toBe('REFIDX_OUT_SELF_1');

    await waitUntil(() => {
      const sqlite = new Database(dbPath(), { readonly: true });
      try {
        return Boolean(sqlite.prepare('SELECT msg_id FROM messages WHERE msg_id = ?').get('ROBOT1.0_OUT_SELF_1'));
      } finally {
        sqlite.close();
      }
    }, 3000, 'outbound self record saved');

    const sqlite = new Database(dbPath(), { readonly: true });
    try {
      const rows = sqlite
        .prepare('SELECT msg_id, peer, user_id, sender_name, self, ref_idx, content FROM messages ORDER BY time ASC, rowid ASC')
        .all() as any[];
      expect(rows).toHaveLength(2);

      // 用户入站消息
      expect(rows[0].msg_id).toBe('ROBOT1.0_IN_SELF_1');
      expect(rows[0].peer).toBe(MOCK_PEER);
      expect(rows[0].self).toBe(0);
      expect(rows[0].ref_idx).toBe('REFIDX_IN_SELF_1');

      // 机器人出站自记录: self=1, msg_id=ROBOT1.0_..., ref_idx=REFIDX_..., peer=MOCK_PEER
      expect(rows[1].msg_id).toBe('ROBOT1.0_OUT_SELF_1');
      expect(rows[1].peer).toBe(MOCK_PEER);
      expect(rows[1].user_id).toBe(MOCK_BOT_ID);
      expect(rows[1].sender_name).toBe('雪梨助手');
      expect(rows[1].self).toBe(1);
      expect(rows[1].ref_idx).toBe('REFIDX_OUT_SELF_1');
      expect(rows[1].content).toBe('最近一小时聊了代码和工具');

      // msg_type=6 输入中状态提示绝不落入 messages
      expect(
        sqlite.prepare('SELECT * FROM messages WHERE msg_id = ?').get('ROBOT1.0_INPUT_NOTIFY_1')
      ).toBeUndefined();

      // 核心红线：出站 ROBOT1.0_... 绝不写入 inbound_reply_slots
      const slots = sqlite.prepare('SELECT msg_id FROM inbound_reply_slots').all() as any[];
      expect(slots.map((s) => s.msg_id)).toEqual(['ROBOT1.0_IN_SELF_1']);
      expect(
        sqlite.prepare('SELECT * FROM inbound_reply_slots WHERE msg_id = ?').get('ROBOT1.0_OUT_SELF_1')
      ).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('契约 2: 真实装配下通过 read_chat_history 查询完整单聊对话（含 self=1、msg_id 与 ref_idx）', async () => {
    const agent = await preparePeerAgent();
    const ws = FakeWs.instances[FakeWs.instances.length - 1]!;

    ws.emitDispatch('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_IN_SELF_2',
      content: '你好呀',
      timestamp: '2026-11-11T12:01:00+08:00',
      author: { user_openid: MOCK_OPENID, username: '测试用户B' },
      message_type: 0,
      message_scene: { ext: ['msg_idx=REFIDX_IN_SELF_2'] },
    });
    await waitUntil(() => capturedFollowups.length === 1, 5000, 'inbound 2 wakeup');

    const toolsSvc: any = booted.ctx.get('tools') || (booted.ctx as any).tools;
    const sendTool = toolsSvc.get('send_qq_message', agent);
    const historyTool = toolsSvc.get('read_chat_history', agent);
    expect(historyTool).toBeDefined();

    await sendTool.execute({ text: '我在呢喵' }, { agent });

    const allHistory = await historyTool.execute({ order: 'asc' }, { agent });
    expect(allHistory.total).toBe(2);
    expect(allHistory.messages).toHaveLength(2);
    expect(allHistory.messages.map((m: any) => m.content)).toEqual(['你好呀', '我在呢喵']);

    const selfMsg = allHistory.messages.find((m: any) => m.msg_id === 'ROBOT1.0_OUT_SELF_1');
    expect(selfMsg).toBeDefined();
    expect(selfMsg.self).toBe(true);
    expect(selfMsg.ref_idx).toBe('REFIDX_OUT_SELF_1');

    const selfOnly = await historyTool.execute({ self_only: true }, { agent });
    expect(selfOnly.total).toBe(1);
    expect(selfOnly.messages[0].msg_id).toBe('ROBOT1.0_OUT_SELF_1');

    const excludeSelf = await historyTool.execute({ exclude_self: true }, { agent });
    expect(excludeSelf.total).toBe(1);
    expect(excludeSelf.messages[0].msg_id).toBe('ROBOT1.0_IN_SELF_2');
  });

  it('契约 3: recordOutboundSelfMessage 缺 msgId 或空内容时不落库，绝不写入 inbound_reply_slots', () => {
    const db = new MessageDatabase(path.join(tmpHome, 'unit-self.sqlite'));
    db.init();
    try {
      const skippedNoId = recordOutboundSelfMessage(
        {
          peer: MOCK_PEER,
          openid: MOCK_OPENID,
          msgId: '',
          msgType: 2,
          text: '无 ID 文本',
          time: Date.now(),
        },
        { db, botId: MOCK_BOT_ID, senderName: '雪梨助手' }
      );
      expect(skippedNoId).toBeNull();

      const skippedEmpty = recordOutboundSelfMessage(
        {
          peer: MOCK_PEER,
          openid: MOCK_OPENID,
          msgId: 'ROBOT1.0_OUT_EMPTY',
          msgType: 0,
          text: '   ',
          time: Date.now(),
        },
        { db, botId: MOCK_BOT_ID, senderName: '雪梨助手' }
      );
      expect(skippedEmpty).toBeNull();

      const saved = recordOutboundSelfMessage(
        {
          peer: MOCK_PEER,
          openid: MOCK_OPENID,
          msgId: 'ROBOT1.0_OUT_UNIT_1',
          refIdx: 'REFIDX_OUT_UNIT_1',
          msgType: 2,
          text: '有效自记录',
          time: Date.now(),
        },
        { db, botId: MOCK_BOT_ID, senderName: '雪梨助手' }
      );
      expect(saved).not.toBeNull();
      expect(db.getMessage('ROBOT1.0_OUT_UNIT_1')?.self).toBe(1);
      expect(db.getMessageByRefIdx('REFIDX_OUT_UNIT_1')?.msg_id).toBe('ROBOT1.0_OUT_UNIT_1');
      expect(db.getLatestValidInboundSlot(MOCK_PEER)).toBeNull();
    } finally {
      db.close();
    }
  });
});
