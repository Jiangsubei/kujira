/**
 * tests/contract/scheduled-title-guard.test.ts
 *
 * 契约测试:
 * 1. scheduled / is_system 系统触发器绝不改写会话标题，也不调用 sessionTitle.rename；
 * 2. scheduled 系统唤醒绝不擦除 OutboundStreamBridge 上已存在的真实入站被动 msg_id 锚点；
 * 3. 真实单聊消息（direct / quote）同样彻底放行 DSH 原生 AI 总结（不调用 sessionTitle.rename 锁定标题）；
 * 4. `getSessionTitle` / `getSessionDisplayName` 只读透传 DSH 原生会话标题，无标题时返回 undefined。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { SessionManager } from '../../src/gateway/session.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(OPENID);
const SESSION_ID = openidToSessionBaseId(OPENID);

describe('契约测试: 原生 AI 会话标题放行与系统唤醒不清除被动 msg_id 锚点', () => {
  let tmpHome: string;
  let sessionManager: SessionManager;
  let currentTitle: string | undefined;
  let rename: any;
  let followup: any;
  let mockAgent: any;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-title-guard-'));
    currentTitle = '今天的工作计划';
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
            get: () => (currentTitle ? { title: currentTitle } : undefined),
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
    return new SessionManager(mockCtx, tmpHome);
  }

  it('契约 1: 定时任务唤醒 (trigger=scheduled) 绝不调用 sessionTitle.rename 改写已有 AI 会话标题', async () => {
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
    expect(currentTitle).toBe('今天的工作计划');
    expect(sessionManager.getSessionTitle(SESSION_ID)).toBe('今天的工作计划');
  });

  it('契约 2: 系统唤醒 (is_system / scheduled) 绝不擦除 OutboundStreamBridge 中保留的历史有效入站被动 msg_id 锚点', async () => {
    sessionManager = createManager();
    const outboundBridge = new OutboundStreamBridge(new Context(), {
      sessionManager,
    });
    sessionManager.setOutboundBridge(outboundBridge);

    outboundBridge.trackInboundContext(PEER, {
      msg_id: 'ROBOT1.0_real_anchor_001',
      from_user: OPENID,
      openid: OPENID,
      trigger: 'direct',
    });
    expect(outboundBridge.resolvePassiveMsgId(PEER)).toBe('ROBOT1.0_real_anchor_001');

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

    expect(outboundBridge.resolvePassiveMsgId(PEER)).toBe('ROBOT1.0_real_anchor_001');
    const activeCtx = outboundBridge.getActiveTurnContext(PEER);
    expect((activeCtx as any)?.is_synthetic).toBe(true);
    expect(activeCtx?.msg_id).toBe('ROBOT1.0_real_anchor_001');

    outboundBridge.dispose();
  });

  it('契约 3: 真实单聊消息 (direct / quote) 也不再调用 sessionTitle.rename 锁定标题，交由 DSH 原生 AI 总结', async () => {
    currentTitle = undefined;
    sessionManager = createManager();

    await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: PEER,
      from_user: OPENID,
      from_name: '小明',
      content: '你好，帮我排查构建报错',
      msg_id: 'ROBOT1.0_inbound_1',
      timestamp: Date.now(),
    });

    expect(rename).not.toHaveBeenCalled();
    expect(sessionManager.getSessionTitle(SESSION_ID)).toBeUndefined();
    expect(sessionManager.getSessionDisplayName(SESSION_ID)).toBeUndefined();

    // 当 DSH 原生 sessionTitle 产出 AI 总结标题后，只读方法应能立即读取
    currentTitle = '排查构建报错问题';
    expect(sessionManager.getSessionTitle(SESSION_ID)).toBe('排查构建报错问题');
    expect(sessionManager.getSessionDisplayName(SESSION_ID)).toBe('排查构建报错问题');
  });

  it('契约 4: 已彻底移除 updateSessionTitle / getPeerName / setPeerName 覆盖锁定接口', () => {
    sessionManager = createManager();
    expect((sessionManager as any).updateSessionTitle).toBeUndefined();
    expect((sessionManager as any).getPeerName).toBeUndefined();
    expect((sessionManager as any).setPeerName).toBeUndefined();
    expect((sessionManager as any).ensurePeerName).toBeUndefined();
  });
});
