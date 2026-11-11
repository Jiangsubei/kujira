/**
 * tests/contract/read-chat-history-peer.test.ts
 *
 * 契约测试: read_chat_history 单聊强隔离与真实工具装配闭环
 *
 * 覆盖规范:
 * 1. createReadChatHistoryTool 参数 schema 彻底移除 peer、source 与 user_id 参数；
 * 2. execute 强制绑定当前单聊 session 归一化后的 user_<hash16>，忽略任何跨会话参数覆盖，禁止跨用户查库；
 * 3. 非 Kujira 单聊会话（如 web-session-* / group_*）安全拒绝；
 * 4. 仅查询 source='qq' 的真实单聊消息，输出包含 string msg_id 与可选 ref_idx；
 * 5. renderChatHistoryText 遵循单聊展示格式（无 QQ: 前缀）与 [自身发言] 标记，且符合 Lossless JSON。
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

describe('契约测试: read_chat_history 单聊强隔离与渲染契约', () => {
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
    self?: number;
  }): void {
    db.saveMessage({
      msg_id: record.msg_id,
      peer: record.peer,
      user_id: record.user_id,
      sender_name: record.sender_name,
      time: record.time,
      type: 'text',
      content: record.content,
      raw: '{}',
      file_id: null,
      local_path: null,
      fingerprint: null,
      recalled: 0,
      self: record.self ?? 0,
      reply_to: null,
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

  it('契约 1: Schema 彻底移除 peer、source 与 user_id 参数', () => {
    const props = historyTool.parameters?.properties;
    expect(props?.peer).toBeUndefined();
    expect(props?.source).toBeUndefined();
    expect(props?.user_id).toBeUndefined();
    expect(props?.reply_to?.type).toBe('string');
  });

  it('契约 2: execute 严格绑定当前单聊会话（支持 kujira-user-<hash> 归一化与多轮归档后缀）', async () => {
    const res = await historyTool.execute(
      {},
      { agent: { session: { id: `${SESSION_A}-r2-1-ab12cd` } } }
    );

    expect(res.total).toBe(1);
    expect(res.messages[0].msg_id).toBe('ROBOT1.0_A_001');
    expect(res.messages[0].ref_idx).toBe('REFIDX_A_001');
    expect(res.messages[0].content).toBe('用户A的单聊消息');
    assertNoUndefinedFields(res);
  });

  it('契约 3: 单聊强隔离 —— 即使显式传入其他 peer 或 source 也绝不跨会话泄密', async () => {
    const res = await historyTool.execute(
      { peer: PEER_B, source: 'agent', keyword: '用户' },
      { agent: { session: { id: SESSION_A } } }
    );

    expect(res.total).toBe(1);
    expect(res.messages.map((m: any) => m.msg_id)).toEqual(['ROBOT1.0_A_001']);
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

  it('契约 5: renderChatHistoryText 展示 string msg_id、ref_idx、[自身发言]，不含 QQ: 前缀', () => {
    save({
      msg_id: 'ROBOT1.0_BOT_002',
      peer: PEER_A,
      user_id: BOT_ID,
      sender_name: 'Kujira助手',
      time: 1793716530000,
      content: '我是机器人单聊回复',
      ref_idx: 'REFIDX_BOT_002',
      self: 1,
    });

    const res = db.readHistory(PEER_A);
    const text = renderChatHistoryText(res);

    expect(text).toContain(`[Kujira助手 (${BOT_ID})]`);
    expect(text).not.toContain(`QQ: ${BOT_ID}`);
    expect(text).toContain('msg_id: ROBOT1.0_BOT_002');
    expect(text).toContain('ref_idx: REFIDX_BOT_002');
    expect(text).toContain('[自身发言]');
    expect(text).not.toContain('[机器人自身]');
  });
});
