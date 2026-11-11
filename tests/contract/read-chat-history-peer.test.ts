/**
 * tests/contract/read-chat-history-peer.test.ts
 *
 * 契约测试: read_chat_history 单聊强隔离、短 ID 化与精简渲染契约
 *
 * 覆盖规范:
 * 1. createReadChatHistoryTool 参数 schema 彻底移除 peer、source、user_id 与 sender_name 参数，reply_to 仅认短消息 ID；
 * 2. execute 强制绑定当前单聊 session 归一化后的 user_<hash16>，忽略任何跨会话参数覆盖，禁止跨用户查库；
 * 3. 非 Kujira 单聊会话（如 web-session-* / group_*）安全拒绝；
 * 4. 仅查询 source='qq' 的真实单聊消息，输出短 msg_id（msg_<n> / msg_self_<n>）与短 reply_to，彻底剔除 ref_idx / user_id / sender_name；
 * 5. renderChatHistoryText 遵循精简格式 `[msg_id] [time][ [已撤回]][ [回复 ...]] type`，无发送者标识与 [自身发言]，且符合 Lossless JSON。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { MessageDatabase } from '../../src/storage/database.js';
import { registerAgentTools, renderChatHistoryText } from '../../src/tools/index.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const OPENID_A = '11112222333344445555666677778888';
const OPENID_B = '9999AAAABBBBCCCCDDDDEEEEFFFF0000';
const PEER_A = openidToPeer(OPENID_A);
const PEER_B = openidToPeer(OPENID_B);
const SESSION_A = openidToSessionBaseId(OPENID_A);
const BOT_ID = '1000000000';

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

describe('契约测试: read_chat_history 单聊强隔离与精简渲染契约', () => {
  let tmpDir: string;
  let db: MessageDatabase;
  let historyTool: any;

  function save(record: {
    msg_id: string;
    peer: string;
    user_id: string;
    sender_name: string;
    time: number;
    content: string;
    ref_idx?: string | null;
    reply_to?: string | null;
    self?: number;
    recalled?: number;
  }): void {
    db.saveMessage({
      msg_id: record.msg_id,
      peer: record.peer,
      user_id: record.user_id,
      sender_name: record.sender_name,
      time: record.time,
      type: record.reply_to ? 'reply' : 'text',
      content: record.content,
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: record.recalled ?? 0,
      self: record.self ?? 0,
      reply_to: record.reply_to ?? null,
      ref_idx: record.ref_idx ?? null,
      source: 'qq',
    });
  }

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-read-history-peer-'));
    db = new MessageDatabase(path.join(tmpDir, 'messages.sqlite'));
    db.init();

    // 用户 A 的单聊消息
    save({
      msg_id: 'ROBOT1.0_A_001',
      peer: PEER_A,
      user_id: OPENID_A,
      sender_name: '好友A',
      time: 1793716500000,
      content: '用户A的单聊消息',
      ref_idx: 'REFIDX_A_001',
    });

    // 用户 B 的单聊消息（同库共存，必须严格隔离）
    save({
      msg_id: 'ROBOT1.0_B_001',
      peer: PEER_B,
      user_id: OPENID_B,
      sender_name: '好友B',
      time: 1793716510000,
      content: '用户B的隐私消息',
      ref_idx: 'REFIDX_B_001',
    });

    const mockCtx = new Context();
    const registeredTools: any[] = [];
    mockCtx.provide('tools', {
      register: (tool: any) => {
        registeredTools.push(tool);
        return () => {};
      },
    });
    registerAgentTools(mockCtx, {
      db,
      mediaManager: {} as any,
      dshHome: tmpDir,
      config: {},
    });
    historyTool = registeredTools.find((t) => t.name === 'read_chat_history');
    expect(historyTool).toBeDefined();
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('契约 1: Schema 彻底移除 peer、source、user_id 与 sender_name 参数', () => {
    const props = historyTool.parameters?.properties;
    expect(props?.peer).toBeUndefined();
    expect(props?.source).toBeUndefined();
    expect(props?.user_id).toBeUndefined();
    expect(props?.sender_name).toBeUndefined();
    expect(props?.reply_to?.type).toBe('string');
    expect(props?.reply_to?.description).toContain('msg_12');
  });

  it('契约 2: execute 严格绑定当前单聊会话，返回短 msg_id 且彻底剔除 ref_idx / user_id / sender_name', async () => {
    const res = await historyTool.execute(
      {},
      { agent: { session: { id: `${SESSION_A}-r2-1-ab12cd` } } }
    );

    expect(res.total).toBe(1);
    expect(res.messages[0].msg_id).toBe('msg_1');
    expect('ref_idx' in res.messages[0]).toBe(false);
    expect('user_id' in res.messages[0]).toBe(false);
    expect('sender_name' in res.messages[0]).toBe(false);
    expect(res.messages[0].content).toBe('用户A的单聊消息');
    assertNoUndefinedFields(res);
  });

  it('契约 3: 单聊强隔离 —— 即使显式传入其他 peer 或 source 也绝不跨会话泄密', async () => {
    const res = await historyTool.execute(
      { peer: PEER_B, source: 'agent', keyword: '用户' },
      { agent: { session: { id: SESSION_A } } }
    );

    expect(res.total).toBe(1);
    expect(res.messages.map((m: any) => m.msg_id)).toEqual(['msg_1']);
    expect(res.messages.some((m: any) => m.content.includes('用户B'))).toBe(false);
    assertNoUndefinedFields(res);
  });

  it('契约 4: 非 Kujira 单聊会话（Web / 群聊）安全拒绝', async () => {
    const resWeb = await historyTool.execute(
      {},
      { agent: { session: { id: 'web-session-123' } } }
    );
    expect(resWeb.total).toBe(0);
    expect(resWeb.message).toContain('仅支持在 QQ 单聊会话中查询');
    assertNoUndefinedFields(resWeb);
  });

  it('契约 5: renderChatHistoryText 展示精简短 ID 与 [回复 ...]，不含发送者、[自身发言]、ref_idx 与长 ID', async () => {
    save({
      msg_id: 'ROBOT1.0_BOT_002',
      peer: PEER_A,
      user_id: BOT_ID,
      sender_name: 'Kujira助手',
      time: 1793716530000,
      content: '我是机器人单聊回复',
      ref_idx: 'REFIDX_BOT_002',
      reply_to: 'REFIDX_A_001',
      self: 1,
      recalled: 1,
    });

    const res = db.readHistory(PEER_A);
    const text = renderChatHistoryText(res);

    expect(text).toContain('[msg_self_1]');
    expect(text).toContain('[msg_1]');
    expect(text).toContain('[已撤回]');
    expect(text).toContain('[回复 msg_1]');
    expect(text).not.toContain(BOT_ID);
    expect(text).not.toContain('Kujira助手');
    expect(text).not.toContain('好友A');
    expect(text).not.toContain('[自身发言]');
    expect(text).not.toContain('ref_idx:');
    expect(text).not.toContain('ROBOT1.0_');
    expect(text).not.toContain('REFIDX_');

    // reply_to 参数仅按短 ID 查询
    const byShortReply = await historyTool.execute(
      { reply_to: 'msg_1' },
      { agent: { session: { id: SESSION_A } } }
    );
    expect(byShortReply.total).toBe(1);
    expect(byShortReply.messages[0].msg_id).toBe('msg_self_1');

    const byLongReply = await historyTool.execute(
      { reply_to: 'ROBOT1.0_A_001' },
      { agent: { session: { id: SESSION_A } } }
    );
    expect(byLongReply.total).toBe(0);
  });
});
