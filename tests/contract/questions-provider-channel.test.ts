import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  KujiraQuestionProvider,
  registerKujiraQuestionChannel,
} from '../../src/approval/question-provider.js';
import { openidToSessionBaseId } from '../../src/utils/peer.js';

const SID_1 = openidToSessionBaseId('10000000000000000000000000000001');
const SID_2 = openidToSessionBaseId('10000000000000000000000000000002');

/**
 * 契约测试: 提问 provider 级联路由接入（DSH user-questions/request waterfall 机制）
 *
 * 验证：
 * - 情况 1: Kujira 单聊会话由 Kujira 渠道拦截并由 KujiraQuestionProvider 处理；
 * - 情况 2: 非 Kujira 会话（如 Web 会话）调用 next() 委托给宿主/其他提问处理者；
 * - 情况 3: 多处理者在 waterfall 中并存，无 DUPLICATE_PROVIDER 互斥；
 * - 情况 4: 自定义 isKujiraSession 判定生效；
 * - 情况 5: unregister 注销清理监听器，后续请求不再拦截。
 */

function makeQuestionProvider(rejectsMessage: string) {
  const qp = new KujiraQuestionProvider({
    outboundBridge: {
      sendTextReply: async () => {
        throw new Error(rejectsMessage);
      },
    } as any,
  });
  const originalAsk = qp.ask.bind(qp);
  let askCount = 0;
  qp.ask = (async (request: any) => {
    askCount += 1;
    return originalAsk(request);
  }) as any;
  (qp as any)._askCount = () => askCount;
  return qp;
}

describe('契约测试: Kujira 提问 provider 组合路由 (Composite Question Provider via Waterfall)', () => {
  it('情况 1: Kujira 会话触发 user-questions/request 时由 Kujira 渠道拦截处理', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('kujira offline');

    const unregister = registerKujiraQuestionChannel(ctx, { questionProvider: qp });

    const req = {
      agent: { id: SID_1, session: { id: SID_1 } },
      questions: [{ id: 'q1', question: '请选择' }],
    };

    await expect(
      ctx.waterfall('user-questions/request', req as any, () => Promise.reject(new Error('no provider')))
    ).rejects.toThrow('kujira offline');

    unregister();
  });

  it('情况 2: 非 Kujira 会话（Web 会话）触发 user-questions/request 时，级联委托给宿主处理者', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('kujira offline');

    ctx.on('user-questions/request', async (req: any, next: any) => {
      const sid = req.agent?.session?.id || req.agent?.id || '';
      if (!sid.startsWith('kujira-')) {
        return { answers: [{ id: 'q1', selected: ['web-answer'] }] };
      }
      return next();
    });

    const unregister = registerKujiraQuestionChannel(ctx, { questionProvider: qp });

    const webReq = {
      agent: { id: 'web-session-1', session: { id: 'web-session-1' } },
      questions: [{ id: 'q1', question: '请选择' }],
    };

    const res = await ctx.waterfall(
      'user-questions/request',
      webReq as any,
      () => Promise.reject(new Error('no provider'))
    );
    expect(res).toEqual({ answers: [{ id: 'q1', selected: ['web-answer'] }] });

    unregister();
  });

  it('情况 3: 多渠道共存与时序无序性（先注宿主或先注 Kujira 均能级联共存）', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('kujira offline');

    const unregisterKujira = registerKujiraQuestionChannel(ctx, { questionProvider: qp });

    let hostCalled = false;
    const offHost = ctx.on('user-questions/request', async (_req: any, _next: any) => {
      hostCalled = true;
      return { answers: [{ id: 'q1', selected: ['host-ok'] }] };
    });

    // 1. Kujira 会话走 Kujira
    await expect(
      ctx.waterfall(
        'user-questions/request',
        { agent: { session: { id: SID_2 } }, questions: [{ id: 'q1', question: 'x' }] } as any,
        () => Promise.reject(new Error('no answerer'))
      )
    ).rejects.toThrow('kujira offline');

    // 2. 非 Kujira 会话穿透到宿主
    const webRes = await ctx.waterfall(
      'user-questions/request',
      { agent: { session: { id: 'web-session-2' } }, questions: [{ id: 'q1', question: 'x' }] } as any,
      () => Promise.reject(new Error('no answerer'))
    );
    expect(hostCalled).toBe(true);
    expect(webRes).toEqual({ answers: [{ id: 'q1', selected: ['host-ok'] }] });

    unregisterKujira();
    offHost();
  });

  it('情况 4: 路由判定支持自定义 isKujiraSession 函数', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('kujira offline');

    const unregister = registerKujiraQuestionChannel(ctx, {
      questionProvider: qp,
      isKujiraSession: (sessionId) => sessionId === 'kujira-42',
    });

    let hostCalled = false;
    const offHost = ctx.on('user-questions/request', async (_req: any, _next: any) => {
      hostCalled = true;
      return { answers: [] };
    });

    const res = await ctx.waterfall(
      'user-questions/request',
      { agent: { id: 'kujira-other' }, questions: [{ id: 'q1', question: 'x' }] } as any,
      () => Promise.reject(new Error('no answerer'))
    );
    expect(hostCalled).toBe(true);
    expect(res).toEqual({ answers: [] });

    await expect(
      ctx.waterfall(
        'user-questions/request',
        { agent: { session: { id: 'kujira-42' } }, questions: [{ id: 'q1', question: 'x' }] } as any,
        () => Promise.reject(new Error('no answerer'))
      )
    ).rejects.toThrow('kujira offline');

    unregister();
    offHost();
  });

  it('情况 5: 注销 unregister 清除监听器，后续请求全部穿透', async () => {
    const ctx = new Context();
    const qp = makeQuestionProvider('kujira offline');

    const unregister = registerKujiraQuestionChannel(ctx, { questionProvider: qp });
    unregister();

    let defaultReached = false;
    await ctx.waterfall(
      'user-questions/request',
      { agent: { session: { id: SID_1 } }, questions: [{ id: 'q1', question: 'x' }] } as any,
      () => {
        defaultReached = true;
        return Promise.resolve({ answers: [{ id: 'q1', selected: ['fallback'] }] });
      }
    );
    expect(defaultReached).toBe(true);
  });
});
