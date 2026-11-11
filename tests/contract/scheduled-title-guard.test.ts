/**
 * tests/contract/scheduled-title-guard.test.ts
 *
 * 契约测试:
 * 1. scheduled / is_system 系统触发器绝不改写单聊标题/昵称缓存；
 * 2. scheduled 系统唤醒绝不擦除 OutboundStreamBridge 上已存在的真实入站被动 msg_id 锚点；
 * 3. 真实单聊消息（direct / quote）仍能用 from_name 正常更新昵称；
 * 4. 历史污染数据（plugin_kv:kujira_peer_names 中的伪系统名与已污染标题）会被清理/自愈。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { SessionManager } from '../../src/gateway/session.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { openidToPeer, openidToSessionBaseId, extractPeerHash } from '../../src/utils/peer.js';

const OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(OPENID);
const HASH = extractPeerHash(PEER)!;
const SESSION_ID = openidToSessionBaseId(OPENID);
const NEUTRAL_TITLE = `私聊: ${HASH} #1`;

describe('契约测试: 系统触发器不得污染单聊会话标题且不清除被动 msg_id 锚点', () => {
  let tmpHome: string;
  let db: MessageDatabase | undefined;
  let sessionManager: SessionManager;
  let currentTitle: string;
  let rename: any;
  let followup: any;
  let mockAgent: any;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-title-guard-'));
    currentTitle = NEUTRAL_TITLE;
    rename = vi.fn((_session: any, title: string) => {
      currentTitle = title;
    });
    followup = vi.fn();
    mockAgent = {
      status: 'idle',
      followup,
      steer: vi.fn(),
      session: { id: SESSION_ID },
    };
  });

  afterEach(async () => {
    await sessionManager?.dispose().catch(() => {});
    db?.close();
    db = undefined;
    await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  function createManager(extraGet?: (key: string) => any): SessionManager {
    const mockCtx: any = {
      get: vi.fn((key: string) => {
        const extra = extraGet?.(key);
        if (extra !== undefined) return extra;
        if (key === 'agents') {
          return { get: () => mockAgent };
        }
        if (key === 'sessionTitle') {
          return {
            get: () => ({ title: currentTitle }),
            rename,
          };
        }
        return undefined;
      }),
      logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    };
    return new SessionManager(mockCtx, tmpHome, db);
  }

  it('契约 1: 定时任务唤醒 (trigger=scheduled) 绝不改写私聊标题，也不写入昵称缓存', async () => {
    sessionManager = createManager();

    await sessionManager.dispatchWakeup({
      trigger: 'scheduled',
      peer: PEER,
      from_user: '',
      from_name: '系统定时任务',
      is_system: true,
      content: '提醒用户喝水',
      task_id: 'task-1',
      timestamp: Date.now(),
    });

    expect(rename).not.toHaveBeenCalled();
    expect(currentTitle).toBe(NEUTRAL_TITLE);
    expect(sessionManager.getPeerName(PEER)).toBeUndefined();
  });

  it('契约 2: 系统唤醒 (is_system / scheduled) 绝不擦除 OutboundStreamBridge 中保留的历史有效入站被动 msg_id 锚点', async () => {
    sessionManager = createManager();
    const outboundBridge = new OutboundStreamBridge(new Context(), {
      sessionManager,
    });
    sessionManager.setOutboundBridge(outboundBridge);

    // 1. 先通过真实入站消息建立被动回复锚点
    outboundBridge.trackInboundContext(PEER, {
      msg_id: 'ROBOT1.0_real_anchor_001',
      from_user: OPENID,
      openid: OPENID,
      trigger: 'direct',
    });
    expect(outboundBridge.resolvePassiveMsgId(PEER)).toBe('ROBOT1.0_real_anchor_001');

    // 2. 随后触发定时任务唤醒
    await sessionManager.dispatchWakeup({
      trigger: 'scheduled',
      peer: PEER,
      from_user: '',
      from_name: '',
      is_system: true,
      content: '定时任务检查',
      task_id: 'task-2',
      timestamp: Date.now(),
    });

    // 3. 验证历史有效入站被动 msg_id 锚点完好保留，且当前上下文带有 is_synthetic: true
    expect(outboundBridge.resolvePassiveMsgId(PEER)).toBe('ROBOT1.0_real_anchor_001');
    const activeCtx = outboundBridge.getActiveTurnContext(PEER);
    expect((activeCtx as any)?.is_synthetic).toBe(true);
    expect(activeCtx?.msg_id).toBe('ROBOT1.0_real_anchor_001');

    outboundBridge.dispose();
  });

  it('契约 3: 真实单聊消息 (direct / quote) 仍能用 from_name 正常更新私聊标题', async () => {
    sessionManager = createManager();

    await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: PEER,
      from_user: OPENID,
      from_name: '小明',
      content: '你好',
      msg_id: 'ROBOT1.0_inbound_1',
      timestamp: Date.now(),
    });

    expect(rename).toHaveBeenCalledWith(mockAgent.session, `私聊: 小明 ${HASH} #1`);
    expect(currentTitle).toBe(`私聊: 小明 ${HASH} #1`);
    expect(sessionManager.getPeerName(PEER)).toBe('小明');
  });

  it('契约 4: 历史污染清理 —— plugin_kv:kujira_peer_names 中的「系统定时任务」加载时丢弃，已污染标题自愈为中性标题', async () => {
    const dbPath = path.join(tmpHome, 'kujira/messages.sqlite');
    await fsp.mkdir(path.dirname(dbPath), { recursive: true });
    db = new MessageDatabase(dbPath);
    db.init();
    db.setPluginConfig(
      'kujira_peer_names',
      JSON.stringify({ [PEER]: '系统定时任务' })
    );

    currentTitle = `私聊: 系统定时任务 ${HASH} #1`;
    sessionManager = createManager();

    expect(sessionManager.getPeerName(PEER)).toBeUndefined();

    const persisted = JSON.parse(db.getPluginConfig('kujira_peer_names')!);
    expect(persisted[PEER]).toBeUndefined();

    sessionManager.updateSessionTitle(mockAgent.session, PEER, SESSION_ID);
    expect(currentTitle).toBe(NEUTRAL_TITLE);
  });
});
