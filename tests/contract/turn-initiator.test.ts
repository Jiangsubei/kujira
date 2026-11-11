import { describe, it, expect } from 'vitest';
import { TurnInitiatorTracker, resolveWakeupInitiator } from '../../src/approval/turn-initiator.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const OPENID_A = 'A1B2C3D4E5F60708A1B2C3D4E5F60701';
const OPENID_B = 'B1C2D3E4F5061728B1C2D3E4F5061702';
const PEER_A = openidToPeer(OPENID_A);
const SESSION_1 = openidToSessionBaseId(OPENID_A);
const SESSION_2 = openidToSessionBaseId(OPENID_B);

/** 构造一条 session/event 形状的事件（tracker 只依赖 type/data）。 */
function evt(type: string, data?: any) {
  return { type, data } as any;
}

function userMessage(id: string, kind: string = 'user') {
  return evt('user/message', { id, source: { kind } });
}

describe('契约测试: 审批「本轮唤醒者」追踪器 (Turn Initiator Tracker)', () => {
  it('契约 1: 本轮首个 user/message 命中唤醒登记后绑定为审批申请人（支持 openid 与 user_<hash16>）', () => {
    const tracker = new TurnInitiatorTracker();
    expect(tracker.expect('msg-a', SESSION_1, OPENID_A)).toBe(true);

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-a'));

    expect(tracker.getInitiator(SESSION_1)).toBe(OPENID_A);

    // 也支持 user_<hash16> 内部 peer 标识
    expect(tracker.expect('msg-b', SESSION_2, PEER_A)).toBe(true);
    tracker.observe({ id: SESSION_2 }, evt('turn/start'));
    tracker.observe({ id: SESSION_2 }, userMessage('msg-b'));
    expect(tracker.getInitiator(SESSION_2)).toBe(PEER_A);
  });

  it('契约 2: 同轮 steer 插话（第二个 user/message）绝不覆盖本轮唤醒者', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', SESSION_1, OPENID_A);
    tracker.expect('msg-b', SESSION_1, OPENID_B);

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-a'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-b'));

    expect(tracker.getInitiator(SESSION_1)).toBe(OPENID_A);
  });

  it('契约 3: turn/end 立即清除本轮申请人，下一轮前审批必须 Fail-Closed', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', SESSION_1, OPENID_A);

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-a'));
    tracker.observe({ id: SESSION_1 }, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }));

    expect(tracker.getInitiator(SESSION_1)).toBeUndefined();
  });

  it('契约 4: 排队两轮唤醒各自绑定，后一轮绝不顶掉前一轮', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', SESSION_1, OPENID_A);
    tracker.expect('msg-b', SESSION_1, OPENID_B);

    // 第一轮
    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-a'));
    expect(tracker.getInitiator(SESSION_1)).toBe(OPENID_A);

    tracker.observe({ id: SESSION_1 }, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }));

    // 第二轮
    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-b'));
    expect(tracker.getInitiator(SESSION_1)).toBe(OPENID_B);
  });

  it('契约 5: 系统触发（scheduled / proactive）不登记 → 本轮首个 user/message 不产生申请人', () => {
    const tracker = new TurnInitiatorTracker();
    for (const trigger of ['scheduled', 'proactive', 'idle']) {
      expect(resolveWakeupInitiator(trigger, OPENID_A)).toBeNull();
    }

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-system'));

    expect(tracker.getInitiator(SESSION_1)).toBeUndefined();
  });

  it('契约 6: 未登记的普通消息绝不误绑，且不被后续补记覆盖', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', SESSION_1, OPENID_A);

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-noise'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-a'));

    expect(tracker.getInitiator(SESSION_1)).toBeUndefined();
  });

  it('契约 7: 跨会话的 messageId 不得绑定到另一会话', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', SESSION_1, OPENID_A);

    tracker.observe({ id: SESSION_2 }, evt('turn/start'));
    tracker.observe({ id: SESSION_2 }, userMessage('msg-a'));

    expect(tracker.getInitiator(SESSION_2)).toBeUndefined();
    expect(tracker.getInitiator(SESSION_1)).toBeUndefined();
  });

  it('契约 8: runtime-context 注入不占用本轮首个输入名额', () => {
    const tracker = new TurnInitiatorTracker();
    tracker.expect('msg-a', SESSION_1, OPENID_A);

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('ctx-1', 'runtime-context'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-a'));

    expect(tracker.getInitiator(SESSION_1)).toBe(OPENID_A);
  });

  it('契约 9: 非法登记（空 messageId / 空 sessionId / 系统伪身份 system|agent|self）一律拒绝', () => {
    const tracker = new TurnInitiatorTracker();
    expect(tracker.expect('', SESSION_1, OPENID_A)).toBe(false);
    expect(tracker.expect('msg-a', '', OPENID_A)).toBe(false);
    expect(tracker.expect('msg-a', SESSION_1, 'system')).toBe(false);
    expect(tracker.expect('msg-a', SESSION_1, 'agent')).toBe(false);
    expect(tracker.expect('msg-a', SESSION_1, 'self')).toBe(false);
    expect(tracker.expect('msg-a', SESSION_1, 'SYSTEM')).toBe(false);
    expect(tracker.expect('msg-a', SESSION_1, '')).toBe(false);
    expect(tracker.expect('msg-a', SESSION_1, '   ')).toBe(false);
    expect(tracker.pendingCount).toBe(0);
  });

  it('契约 10: 待确认登记有上限，陈旧唤醒不会无限累积', () => {
    const tracker = new TurnInitiatorTracker({ maxExpectations: 2 });
    tracker.expect('msg-1', SESSION_1, OPENID_A);
    tracker.expect('msg-2', SESSION_1, PEER_A);
    tracker.expect('msg-3', SESSION_1, OPENID_B);

    expect(tracker.pendingCount).toBe(2);

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-1'));
    expect(tracker.getInitiator(SESSION_1)).toBeUndefined();

    tracker.observe({ id: SESSION_1 }, evt('turn/start'));
    tracker.observe({ id: SESSION_1 }, userMessage('msg-3'));
    expect(tracker.getInitiator(SESSION_1)).toBe(OPENID_B);
  });
});
