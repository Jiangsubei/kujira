import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const OPENID_1 = '10000000000000000000000000000001';
const OPENID_2 = '10000000000000000000000000000002';
const PEER_1 = openidToPeer(OPENID_1);
const PEER_2 = openidToPeer(OPENID_2);
const SID_1 = openidToSessionBaseId(OPENID_1);
const SID_2 = openidToSessionBaseId(OPENID_2);

describe('契约测试: 入站消息串行排队与复用不取消 (Inbound Serial Queue Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh | null = null;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-serial-queue-'));
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function createForeignLiveAgent(sessionId: string) {
    if (!booted) throw new Error('booted is not ready');
    const cwd = path.join(tmpHome, 'workspace', 'kujira');
    await fsp.mkdir(cwd, { recursive: true });
    const agents = (booted.ctx as any).agents;
    const created = await agents.create({
      sessionId,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd },
    });
    expect((created.agent as any).handle).toBeUndefined();
    return { agent: created.agent as any, handle: created };
  }

  it('契约 1: 真实装配下 live agent 为 bare Agent（无 handle），Kujira 侧复用同一实例且绝不调用 cancel', async () => {
    booted = await bootDshKujira({ dshHome: tmpHome, mountPlugin: false });
    const { agent: liveAgent } = await createForeignLiveAgent(SID_1);

    expect((liveAgent as any).handle).toBeUndefined();
    expect(typeof liveAgent.cancel).toBe('function');

    const cancelSpy = vi.spyOn(liveAgent, 'cancel');
    const resumeSpy = vi.spyOn((booted.ctx as any).agents, 'resume');
    const createSpy = vi.spyOn((booted.ctx as any).agents, 'create');

    const sessionManager = new SessionManager(booted.ctx, tmpHome, undefined, {
      configGetter: () => ({ new_message_behavior: 'queue' }),
    });
    const reused = await sessionManager.getOrCreateAgent(PEER_1);

    expect(reused).toBe(liveAgent);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });

  it('契约 2: 上一条回合运行中收到第二条消息 → 仅按入站顺序 followup 排队，绝不 cancel 在途回合', async () => {
    booted = await bootDshKujira({ dshHome: tmpHome, mountPlugin: false });
    const { agent: liveAgent } = await createForeignLiveAgent(SID_2);

    const cancelSpy = vi.spyOn(liveAgent, 'cancel');
    const followupSpy = vi.spyOn(liveAgent, 'followup');
    const resumeSpy = vi.spyOn((booted.ctx as any).agents, 'resume');
    const createSpy = vi.spyOn((booted.ctx as any).agents, 'create');

    const sessionManager = new SessionManager(booted.ctx, tmpHome, undefined, {
      configGetter: () => ({ new_message_behavior: 'queue' }),
    });

    const first = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: PEER_2,
      from_user: OPENID_2,
      from_name: '甲',
      content: '第一条消息',
      timestamp: Date.now(),
    });

    expect(String(liveAgent.status)).toBe('running');

    const second = await sessionManager.dispatchWakeup({
      trigger: 'direct',
      peer: PEER_2,
      from_user: OPENID_2,
      from_name: '甲',
      content: '第二条消息',
      timestamp: Date.now(),
    });

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(followupSpy).toHaveBeenCalledTimes(2);
    expect(followupSpy.mock.calls[0]![0]).toBe(first);
    expect(followupSpy.mock.calls[1]![0]).toBe(second);

    const texts = followupSpy.mock.calls.map((call) => {
      const message: any = call[0];
      return message?.content?.[0]?.text ?? '';
    });
    expect(texts[0]).toContain('第一条消息');
    expect(texts[1]).toContain('第二条消息');

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();

    await sessionManager.dispose();
  });
});
