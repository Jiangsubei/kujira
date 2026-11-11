import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import {
  KujiraQuestionProvider,
  registerKujiraQuestionChannel,
} from '../../src/approval/question-provider.js';
import { KujiraApprovalResponder } from '../../src/approval/tool-approval.js';
import { TurnInitiatorTracker } from '../../src/approval/turn-initiator.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = '10000000000000000000000000000001';
const PEER = openidToPeer(MOCK_OPENID);
const SESSION_ID = openidToSessionBaseId(MOCK_OPENID);
const QQ_AGENT = { session: { id: SESSION_ID } } as any;

function createMockOutbound(sent: Array<{ peer: string; text: string }> = []) {
  return {
    sendTextReply: async (peer: string, text: string) => {
      sent.push({ peer, text });
      return { ok: true, status: 200, body: { id: `out-${sent.length}`, timestamp: '' } };
    },
  } as unknown as OutboundStreamBridge;
}

describe('契约测试: 提问与审批官方 Provider 状态机协同 (Kujira 单聊 Questions & Approval Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-qa-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('A2-契约 1: 无 peer/出站通道时提问必须抛错，绝不自动作答替 agent 决策', async () => {
    const provider = new KujiraQuestionProvider();
    await expect(
      provider.ask({
        agent: QQ_AGENT,
        questions: [{ id: 'q1', question: '请选择部署环境' }],
      } as any)
    ).rejects.toThrow(/QQ Gateway 未连接|未解析到 QQ 会话/);
  });

  it('A2-契约 2: 提问发送失败必须 reject，不进入无限挂起', async () => {
    const provider = new KujiraQuestionProvider({
      outboundBridge: {
        sendTextReply: async () => ({
          ok: false,
          status: 503,
          message: 'QQ Gateway socket closed',
        }),
      } as any,
    });

    await expect(
      provider.ask({
        questions: [{ id: 'q1', question: '请选择' }],
        agent: QQ_AGENT,
      } as any)
    ).rejects.toThrow(/发送提问消息到 .* 失败.*closed/);
  });

  it('A2-契约 3: 审批无 peer/出站通道直接拒绝，不替用户放行也不挂起', async () => {
    const responder = new KujiraApprovalResponder();
    const decision = await responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_bash',
      reason: '测试',
    });
    expect(decision).toBe('rejected');

    const decision2 = await responder.handleApprovalRequest({
      peer: '',
      toolName: 'execute_bash',
      reason: '测试',
    });
    expect(decision2).toBe('rejected');
  });

  it('B2-契约 1: 官方 user-questions/request waterfall 接入与注销契约', async () => {
    const p1 = new KujiraQuestionProvider();
    const unregister1 = registerKujiraQuestionChannel(booted.ctx, { questionProvider: p1 });
    expect(typeof unregister1).toBe('function');

    const p2 = new KujiraQuestionProvider();
    const unregister2 = registerKujiraQuestionChannel(booted.ctx, { questionProvider: p2 });
    expect(typeof unregister2).toBe('function');

    unregister1();
    unregister2();
  });

  it('B4/A3-契约 4: 单聊提问经 OutboundStreamBridge 投递后，直接回复即可完成闭环', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    const gateway = {
      sendC2CMessage: async (_openid: string, payload: any) => {
        const text = payload?.markdown?.content ?? payload?.content ?? '';
        sent.push({ peer: PEER, text });
        return { ok: true, status: 200, body: { id: `out-${sent.length}`, timestamp: '' } };
      },
    };
    const db = {
      getOpenidByPeer: (p: string) => (p === PEER ? MOCK_OPENID : null),
    };
    const bridge = new OutboundStreamBridge(new Context(), {
      gateway: gateway as any,
      db: db as any,
    });

    const provider = new KujiraQuestionProvider({ outboundBridge: bridge });

    const askPromise = provider.ask({
      questions: [{ id: 'q1', prompt: '请选择部署环境' }],
      agent: QQ_AGENT,
      signal: new AbortController().signal,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const handled = provider.handleInboundReply(PEER, '自定义方案');
    expect(handled).toBe(true);

    const answer = await askPromise;
    expect(answer.answers[0]).toEqual({ id: 'q1', selected: [], custom: '自定义方案' });
    expect(sent.some((m) => m.text.includes('【请回答问题】'))).toBe(true);
    expect(sent.some((m) => m.text.includes('请直接回复数字序号，或者直接输入你的答案'))).toBe(true);
  });

  it('契约 6: 单聊好友无需 admins 白名单即可审批，并支持 y/yes/同意/允许 与 n/no/拒绝/不同意', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(sent),
    });

    const approvePromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_dangerous_bash',
      reason: '清理构建缓存',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('【审批请求】');
    expect(responder.handleInboundReply(PEER, '无效文本')).toBe(false);
    expect(responder.handleInboundReply(PEER, '同意')).toBe(true);
    expect(await approvePromise).toBe('allowed-once');

    const rejectPromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_dangerous_bash',
      reason: '删除文件',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(responder.handleInboundReply(PEER, '拒绝')).toBe(true);
    expect(await rejectPromise).toBe('rejected');
  });

  it('契约 7: 审批请求在 signal aborted 时返回 cancelled 语义', async () => {
    const ac = new AbortController();
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(),
    });

    const approvalPromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_dangerous_bash',
      reason: '已取消任务',
      signal: ac.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();

    const decision = await approvalPromise;
    expect(decision).toBe('cancelled');
  });

  it('契约 8: 审批请求超时 fail-closed 返回 rejected', async () => {
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(),
      timeoutMs: 50,
    });

    const approvalPromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_dangerous_bash',
      reason: '超时测试',
    });

    const decision = await approvalPromise;
    expect(decision).toBe('rejected');
  });

  it('契约 9: 同一 peer 重复发起审批时，前序挂起请求被顶替收敛为 cancelled', async () => {
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(),
    });

    const firstPromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_first',
      reason: '首次操作',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondPromise = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'execute_second',
      reason: '顶替操作',
    });

    expect(await firstPromise).toBe('cancelled');

    expect(responder.handleInboundReply(PEER, 'y')).toBe(true);
    expect(await secondPromise).toBe('allowed-once');
  });

  it('契约 10: 无人值守定时任务（applicantId 为 null/空串 或 turnInitiatorTracker 无发起人）严格 Fail-Closed，绝不下发审批提示', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    const tracker = new TurnInitiatorTracker();

    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(sent),
      turnInitiatorTracker: tracker,
    });

    // 1. 显式传入 applicantId: null 或 '' → 立即拒绝且不下发
    expect(
      await responder.handleApprovalRequest({
        peer: PEER,
        toolName: 'execute_bash',
        reason: '定时任务无授权',
        applicantId: null,
      })
    ).toBe('rejected');

    expect(
      await responder.handleApprovalRequest({
        peer: PEER,
        toolName: 'execute_bash',
        reason: '定时任务空发起人',
        applicantId: '',
      })
    ).toBe('rejected');

    // 2. 注入 sessionId + turnInitiatorTracker，当前轮次为无人值守 (scheduled_task → initiator === undefined)
    tracker.observe({ id: SESSION_ID }, { type: 'turn/start' });
    tracker.observe({ id: SESSION_ID }, { type: 'user/message', data: { id: 'msg-sched-1', source: { kind: 'user' } } });
    expect(tracker.getInitiator(SESSION_ID)).toBeUndefined();

    expect(
      await responder.handleApprovalRequest({
        peer: PEER,
        sessionId: SESSION_ID,
        toolName: 'execute_bash',
        reason: 'scheduled_task 越权',
      })
    ).toBe('rejected');

    expect(sent).toHaveLength(0);

    // 3. 当由真实单聊用户唤醒并登记 initiator 后，审批正常下发并等待回应
    tracker.observe({ id: SESSION_ID }, { type: 'turn/end', data: { turn: 1 } });
    tracker.expect('msg-real-1', SESSION_ID, MOCK_OPENID);
    tracker.observe({ id: SESSION_ID }, { type: 'turn/start' });
    tracker.observe({ id: SESSION_ID }, { type: 'user/message', data: { id: 'msg-real-1', source: { kind: 'user' } } });

    const realPromise = responder.handleApprovalRequest({
      peer: PEER,
      sessionId: SESSION_ID,
      toolName: 'execute_bash',
      reason: '真实单聊操作',
      applicantId: tracker.getInitiator(SESSION_ID),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(responder.handleInboundReply(PEER, 'yes')).toBe(true);
    expect(await realPromise).toBe('allowed-once');
  });

  it('契约 11: 仅提供简化 gateway + db 时，委托共享 OutboundStreamBridge 发送审批提示', async () => {
    const sentPayloads: any[] = [];
    const gateway = {
      sendC2CMessage: async (_openid: string, payload: any) => {
        sentPayloads.push(payload);
        return { ok: true, status: 200, body: { id: 'out-delegated-1', timestamp: '' } };
      },
    };
    const db = {
      getOpenidByPeer: (p: string) => (p === PEER ? MOCK_OPENID : null),
    };

    const responder = new KujiraApprovalResponder({
      gateway: gateway as any,
      db: db as any,
    });

    const p = responder.handleApprovalRequest({
      peer: PEER,
      toolName: 'write',
      reason: '写入配置文件',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.markdown?.content ?? sentPayloads[0]?.content).toContain('【审批请求】');
    expect(responder.handleInboundReply(PEER, '允许')).toBe(true);
    expect(await p).toBe('allowed-once');
  });
});
