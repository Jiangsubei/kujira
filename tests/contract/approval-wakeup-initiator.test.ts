import { describe, it, expect } from 'vitest';
import { resolveWakeupInitiator } from '../../src/approval/turn-initiator.js';
import { openidToPeer } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F60708A1B2C3D4E5F60708';
const MOCK_PEER = openidToPeer(MOCK_OPENID);

describe('契约测试: 审批唤醒发起人判定（Kujira 单聊本轮登记口径）', () => {
  it('契约 1: 真实 QQ 单聊发送者唤醒（direct / quote）记录其 openid 或内部 peer 标识', () => {
    for (const trigger of ['direct', 'quote']) {
      expect(resolveWakeupInitiator(trigger, MOCK_OPENID)).toBe(MOCK_OPENID);
      expect(resolveWakeupInitiator(trigger, MOCK_PEER)).toBe(MOCK_PEER);
    }
  });

  it('契约 2: 系统触发（scheduled / proactive / idle）或已淘汰群触发一律不产生锚点', () => {
    for (const trigger of ['scheduled', 'proactive', 'idle', 'at', 'mention', 'poke']) {
      expect(resolveWakeupInitiator(trigger, MOCK_OPENID)).toBeNull();
      expect(resolveWakeupInitiator(trigger, '')).toBeNull();
    }
  });

  it('契约 3: 真实触发但身份为系统伪身份（system / agent / self）或空值时拒绝锚定', () => {
    for (const pseudo of ['system', 'agent', 'self', 'SYSTEM', 'Agent', '', '   ', undefined, null]) {
      expect(resolveWakeupInitiator('direct', pseudo as any)).toBeNull();
      expect(resolveWakeupInitiator('quote', pseudo as any)).toBeNull();
    }
  });

  it('契约 4: 触发类型与身份标识允许前后空白，未知触发类型不锚定', () => {
    expect(resolveWakeupInitiator(' direct ', ` ${MOCK_OPENID} `)).toBe(MOCK_OPENID);
    expect(resolveWakeupInitiator(' quote ', ` ${MOCK_PEER} `)).toBe(MOCK_PEER);
    expect(resolveWakeupInitiator(undefined, MOCK_OPENID)).toBeNull();
    expect(resolveWakeupInitiator('unknown', MOCK_OPENID)).toBeNull();
  });
});
