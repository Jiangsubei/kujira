/**
 * tests/contract/session-switch-clear-anchor.test.ts
 *
 * 契约测试: 切换会话清空陈旧被动锚点与缺锚点主动降级通道 (Session Switch Clear Anchor Contract)
 *
 * 覆盖核心契约:
 * 1. OutboundStreamBridge.clearInboundContext(peer) 能同时清空内存锚点 (latestInboundAnchors)
 *    与上下文 (inboundContexts)，并同步将 DB 中该 peer 的历史槽位标记失效 (invalidateInboundSlotsByPeer)；
 * 2. 清空后 resolvePassiveMsgId 返回 undefined，调用 sendTextReply 直接降级为无 msg_id/msg_seq 的主动消息；
 * 3. SessionManager.resumeSession 切换会话成功时，自动调用 outboundBridge.clearInboundContext；
 * 4. SessionManager.markSessionCleared (/新建 会话) 时，同样自动调用 outboundBridge.clearInboundContext；
 * 5. 主动通道走不通时，将腾讯返回的错误码与 message 如实透传给上层。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { openidToPeer } from '../../src/utils/peer.js';

const TEST_OPENID = '11223344556677889900AABBCCDDEEFF';
const TEST_PEER = openidToPeer(TEST_OPENID);

describe('契约测试: 切换会话清空陈旧被动锚点与缺锚点主动降级通道', () => {
  it('契约 1: clearInboundContext(peer) 同时清空内存被动锚点、上下文并使 DB 历史槽位失效', () => {
    const mockDb: any = {
      invalidateInboundSlotsByPeer: vi.fn(),
      getLatestValidInboundSlot: vi.fn(),
    };
    const bridge = new OutboundStreamBridge({} as any, { db: mockDb });

    // 先预置内存与上下文
    bridge.trackInboundContext(TEST_PEER, {
      msg_id: 'ROBOT1.0_old_inbound_1',
      openid: TEST_OPENID,
      from_user: TEST_OPENID,
    });

    expect(bridge.resolvePassiveMsgId(TEST_PEER)).toBe('ROBOT1.0_old_inbound_1');
    expect(bridge.getActiveTurnContext(TEST_PEER)?.msg_id).toBe('ROBOT1.0_old_inbound_1');

    // 执行清空
    bridge.clearInboundContext(TEST_PEER);

    // 内存中必须已被删除
    expect(bridge.resolvePassiveMsgId(TEST_PEER)).toBeUndefined();
    expect(bridge.getActiveTurnContext(TEST_PEER)).toBeUndefined();

    // 必须调用数据库使该 peer 历史槽位失效，防 resolvePassiveMsgId 回源查 DB 捞出旧槽位
    expect(mockDb.invalidateInboundSlotsByPeer).toHaveBeenCalledWith(TEST_PEER);
  });

  it('契约 2: 清空锚点后，sendTextReply 自动走到无 msg_id/msg_seq 的主动通道', async () => {
    const mockGateway: any = {
      sendC2CMessage: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { id: 'ROBOT1.0_proactive_sent_1' },
      }),
    };
    const mockDb: any = {
      invalidateInboundSlotsByPeer: vi.fn(),
      getLatestValidInboundSlot: vi.fn().mockReturnValue(null),
      getOpenidByPeer: vi.fn().mockReturnValue(TEST_OPENID),
    };
    const bridge = new OutboundStreamBridge({} as any, {
      gateway: mockGateway,
      db: mockDb,
    });
    bridge.registerPeerOpenid(TEST_PEER, TEST_OPENID);

    // 预置旧锚点然后执行清空
    bridge.trackInboundContext(TEST_PEER, {
      msg_id: 'ROBOT1.0_old_inbound_1',
      openid: TEST_OPENID,
      from_user: TEST_OPENID,
    });
    bridge.clearInboundContext(TEST_PEER);

    // 发送消息
    const res = await bridge.sendTextReply(TEST_PEER, '测试主动消息降级');
    expect(res.ok).toBe(true);
    expect(mockGateway.sendC2CMessage).toHaveBeenCalledTimes(1);

    // 关键断言：发送的 payload 中绝不含 msg_id 与 msg_seq
    const [calledOpenid, calledPayload] = mockGateway.sendC2CMessage.mock.calls[0];
    expect(calledOpenid).toBe(TEST_OPENID);
    expect(calledPayload.msg_id).toBeUndefined();
    expect(calledPayload.msg_seq).toBeUndefined();
    expect(calledPayload.msg_type).toBe(2);
    expect(calledPayload.markdown?.content).toBe('测试主动消息降级');
  });

  it('契约 3: 主动通道发送失败时，腾讯返回的错误码与 message 如实透传', async () => {
    const mockGateway: any = {
      sendC2CMessage: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        code: 40054010,
        message: '主动消息配额已耗尽或用户未开启私聊',
        body: null,
      }),
    };
    const mockDb: any = {
      invalidateInboundSlotsByPeer: vi.fn(),
      getLatestValidInboundSlot: vi.fn().mockReturnValue(null),
      getOpenidByPeer: vi.fn().mockReturnValue(TEST_OPENID),
    };
    const bridge = new OutboundStreamBridge({} as any, {
      gateway: mockGateway,
      db: mockDb,
    });
    bridge.registerPeerOpenid(TEST_PEER, TEST_OPENID);

    const res = await bridge.sendTextReply(TEST_PEER, '测试主动消息报错透传');
    expect(res.ok).toBe(false);
    expect(res.code).toBe(40054010);
    expect(res.message).toBe('主动消息配额已耗尽或用户未开启私聊');
  });

  it('契约 4: SessionManager.resumeSession 切换会话成功时，自动触发 outboundBridge.clearInboundContext', async () => {
    const mockBridge: any = {
      clearInboundContext: vi.fn(),
    };
    const mockPersistence: any = {
      isSessionPhysicallyPresent: vi.fn().mockReturnValue(true),
      isSessionArchived: vi.fn().mockReturnValue(false),
      getSessionState: vi.fn().mockReturnValue(null),
      saveSessionState: vi.fn(),
    };
    const mockAgentRunner: any = {
      getOutboundBridge: vi.fn().mockReturnValue(mockBridge),
    };

    // 构造带有 resumeSession 的 SessionManager 上下文
    const smLike: any = {
      agentRunner: mockAgentRunner,
      persistence: mockPersistence,
      peerCurrentSessionId: new Map<string, string>(),
      clearedVersions: new Map<string, any>(),
      isSessionPhysicallyPresent: (sid: string) => mockPersistence.isSessionPhysicallyPresent(sid),
      isSessionArchived: (sid: string) => mockPersistence.isSessionArchived(sid),
    };
    const sessionMod = await import('../../src/gateway/session.js');
    const resumeFn = sessionMod.SessionManager.prototype.resumeSession;
    // 满足 parseSessionId: kujira-user-<id>-r<round>-<version>-<hash4>
    const userHash = TEST_PEER.replace(/^user_/, '');
    const targetSid = `kujira-user-${userHash}-r1-2-abcd`;
    const ok = resumeFn.call(smLike, TEST_PEER, targetSid);
    expect(ok).toBe(true);
    expect(mockBridge.clearInboundContext).toHaveBeenCalledWith(TEST_PEER);
  });

  it('契约 5: SessionManager.markSessionCleared 新建会话时，自动触发 outboundBridge.clearInboundContext', async () => {
    const mockBridge: any = {
      clearInboundContext: vi.fn(),
    };
    const mockPersistence: any = {
      isSessionPhysicallyPresent: vi.fn().mockReturnValue(false),
      isSessionArchived: vi.fn().mockReturnValue(false),
      getSessionState: vi.fn().mockReturnValue(null),
      saveSessionState: vi.fn(),
    };
    const mockAgentRunner: any = {
      getOutboundBridge: vi.fn().mockReturnValue(mockBridge),
    };
    const mockModelSelector: any = {
      getModelSelection: vi.fn(),
      setModelSelection: vi.fn(),
    };

    const smLike: any = {
      agentRunner: mockAgentRunner,
      persistence: mockPersistence,
      modelSelector: mockModelSelector,
      peerCurrentSessionId: new Map<string, string>(),
      clearedVersions: new Map<string, any>(),
      pendingClearedSessionId: new Map<string, string>(),
      deletedSessionIds: new Set<string>(),
      listPeerSessionIds: vi.fn().mockReturnValue([]),
      sessionIdToPeer: (p: string) => p,
      isSessionPhysicallyPresent: () => false,
      isSessionArchived: () => false,
      getDefaultModelSelection: () => ({ provider: 'test', model: 'test' }),
    };

    const sessionMod = await import('../../src/gateway/session.js');
    const markClearedFn = sessionMod.SessionManager.prototype.markSessionCleared;
    markClearedFn.call(smLike, TEST_PEER);

    expect(mockBridge.clearInboundContext).toHaveBeenCalledWith(TEST_PEER);
  });
});
