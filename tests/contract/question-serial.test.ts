import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { KujiraQuestionProvider } from '../../src/approval/question-provider.js';
import { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

/**
 * 契约测试: 单聊串行多题问答状态机 + 单聊 1 档卡片展示 + 回复解析 (Ask Serial Contract)
 */

const MOCK_OPENID = '10000000000000000000000000000002';
const USER_PEER = openidToPeer(MOCK_OPENID);
const KUJIRA_USER_AGENT = {
  id: openidToSessionBaseId(MOCK_OPENID),
  session: { id: openidToSessionBaseId(MOCK_OPENID) },
} as any;

function makeGateway() {
  const sends: Array<{ peer: string; message: string; msgId: string }> = [];
  let seq = 1000;
  const gateway = {
    sends,
    sendC2CMessage: async (_openid: string, payload: any) => {
      seq += 1;
      const msgId = `out-${seq}`;
      const message = payload?.markdown?.content ?? payload?.content ?? '';
      sends.push({ peer: USER_PEER, message, msgId });
      return { ok: true, status: 200, body: { id: msgId, timestamp: '' } };
    },
  };
  return gateway;
}

function makeProvider(gateway: ReturnType<typeof makeGateway>) {
  const db = {
    getOpenidByPeer: (p: string) => (p === USER_PEER ? MOCK_OPENID : null),
  };
  const bridge = new OutboundStreamBridge(new Context(), {
    gateway: gateway as any,
    db: db as any,
  });
  return new KujiraQuestionProvider({ outboundBridge: bridge });
}

describe('契约测试: 串行多题问答状态机 (Serial Multi-Question Ask)', () => {
  it('3 道题逐题答完 → 每次只发当前题卡片，最后一次性 resolve 含 3 个 answer', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway);

    const askPromise = provider.ask({
      agent: KUJIRA_USER_AGENT,
      questions: [
        { id: 'q1', question: '问题一', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: '问题二', options: [{ label: 'C' }, { label: 'D' }] },
        { id: 'q3', question: '问题三' },
      ],
      signal: new AbortController().signal,
    } as any);

    await new Promise((r) => setTimeout(r, 15));
    expect(gateway.sends).toHaveLength(1);
    expect(gateway.sends[0]!.message).toContain('问题一');
    expect(gateway.sends[0]!.message).not.toContain('问题二');
    expect(gateway.sends[0]!.message).not.toContain('问题三');

    let settled = false;
    void askPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    expect(provider.handleInboundReply(USER_PEER, '2')).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(gateway.sends.map((s) => s.message)).toContain('已收到第 1/3 题回答');
    expect(gateway.sends.some((s) => s.message.includes('问题二'))).toBe(true);
    expect(settled).toBe(false);

    expect(provider.handleInboundReply(USER_PEER, '1')).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(gateway.sends.map((s) => s.message)).toContain('已收到第 2/3 题回答');
    expect(gateway.sends.some((s) => s.message.includes('问题三'))).toBe(true);
    expect(settled).toBe(false);

    expect(provider.handleInboundReply(USER_PEER, '自定义内容')).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(gateway.sends.map((s) => s.message)).toContain('已成功回答');

    const answer = await askPromise;
    expect(settled).toBe(true);
    expect(answer.answers).toHaveLength(3);
    expect(answer.answers[0]).toEqual({ id: 'q1', selected: ['B'] });
    expect(answer.answers[1]).toEqual({ id: 'q2', selected: ['C'] });
    expect(answer.answers[2]).toEqual({ id: 'q3', selected: [], custom: '自定义内容' });
  });

  it('单道题问答：答完直接回复“已成功回答”', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway);

    const askPromise = provider.ask({
      agent: KUJIRA_USER_AGENT,
      questions: [{ id: 'q1', question: '确认操作？', options: [{ label: '是' }, { label: '否' }] }],
      signal: new AbortController().signal,
    } as any);

    await new Promise((r) => setTimeout(r, 15));
    expect(gateway.sends).toHaveLength(1);

    expect(provider.handleInboundReply(USER_PEER, '1')).toBe(true);
    await new Promise((r) => setTimeout(r, 15));

    expect(gateway.sends.map((s) => s.message)).toContain('已成功回答');
    const res = await askPromise;
    expect(res.answers[0]!.selected).toEqual(['是']);
  });

  it('abort 串行中途生效：第 1 题答完挂起第 2 题时 abort → 清理 pending + reject', async () => {
    const gateway = makeGateway();
    const provider = makeProvider(gateway);
    const controller = new AbortController();

    const askPromise = provider.ask({
      agent: KUJIRA_USER_AGENT,
      questions: [
        { id: 'q1', question: '问题一', options: [{ label: 'A' }] },
        { id: 'q2', question: '问题二', options: [{ label: 'B' }] },
      ],
      signal: controller.signal,
    } as any);

    await new Promise((r) => setTimeout(r, 15));
    provider.handleInboundReply(USER_PEER, '1');
    controller.abort();

    await expect(askPromise).rejects.toThrow('AskUserQuestion aborted by caller signal');
    expect(provider.handleInboundReply(USER_PEER, '1')).toBe(false);
  });

  it('由 gateway + db 轻量构造提问 Provider 时同样正常下发', async () => {
    const gateway = makeGateway();
    const db = {
      getOpenidByPeer: (p: string) => (p === USER_PEER ? MOCK_OPENID : null),
    };
    const provider = new KujiraQuestionProvider({
      gateway: gateway as any,
      db: db as any,
    });

    const askPromise = provider.ask({
      agent: KUJIRA_USER_AGENT,
      questions: [{ id: 'q1', question: '确认？', options: [{ label: '确认' }] }],
      signal: new AbortController().signal,
    } as any);

    await new Promise((r) => setTimeout(r, 15));
    expect(gateway.sends).toHaveLength(1);
    expect(provider.handleInboundReply(USER_PEER, '1')).toBe(true);
    const res = await askPromise;
    expect(res.answers[0]).toEqual({ id: 'q1', selected: ['确认'] });
  });
});

describe('契约测试: 回复解析规则 (Answer Parsing)', () => {
  function parse(q: any, text: string) {
    return (async () => {
      const gateway = makeGateway();
      const provider = makeProvider(gateway);
      const askPromise = provider.ask({
        agent: KUJIRA_USER_AGENT,
        questions: [q],
        signal: new AbortController().signal,
      } as any);
      await new Promise((r) => setTimeout(r, 10));
      provider.handleInboundReply(USER_PEER, text);
      const answer = await askPromise;
      return answer.answers[0];
    })();
  }

  it('单选：序号命中 → selected=[label]；越界数字不判定直接当 custom', async () => {
    const q = { id: 'q1', question: '环境', options: [{ label: '生产' }, { label: '测试' }, { label: '开发' }, { label: '预发' }] };
    expect(await parse(q, '2')).toEqual({ id: 'q1', selected: ['测试'] });
    expect(await parse(q, '3')).toEqual({ id: 'q1', selected: ['开发'] });
    expect(await parse(q, '5')).toEqual({ id: 'q1', selected: [], custom: '5' });
    expect(await parse(q, '0')).toEqual({ id: 'q1', selected: [], custom: '0' });
    expect(await parse(q, 'x')).toEqual({ id: 'q1', selected: [], custom: 'x' });
    expect(await parse(q, ' 2 ')).toEqual({ id: 'q1', selected: ['测试'] });
  });

  it('多选：逗号分隔，数字段命中进 selected，非数字/越界段拼接为 custom', async () => {
    const q = { id: 'q1', question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    expect(await parse(q, '1,2')).toEqual({ id: 'q1', selected: ['A', 'B'] });
    expect(await parse(q, '1,5')).toEqual({ id: 'q1', selected: ['A'], custom: '5' });
    expect(await parse(q, 'abc,2')).toEqual({ id: 'q1', selected: ['B'], custom: 'abc' });
    expect(await parse(q, '5')).toEqual({ id: 'q1', selected: [], custom: '5' });
    expect(await parse(q, '3,1')).toEqual({ id: 'q1', selected: ['C', 'A'] });
  });

  it('纯自定义输入框（无 options）：恒走 custom', async () => {
    expect(await parse({ id: 'q1', question: '补充说明' }, '随便输入')).toEqual({
      id: 'q1',
      selected: [],
      custom: '随便输入',
    });
    expect(await parse({ id: 'q1', question: '补充说明' }, '42')).toEqual({
      id: 'q1',
      selected: [],
      custom: '42',
    });
  });
});

describe('契约测试: 单聊唯一档卡片展示 (Single C2C Card)', () => {
  it('单聊卡片：题文 + detail + 选项行 + 或者输入自定义答案 + 直接回复提示', () => {
    const card = KujiraQuestionProvider.formatQuestionCard({
      id: 'q1',
      question: '部署到哪个环境？',
      detail: '仅影响 staging 实例',
      options: [{ label: '生产' }, { label: '测试', description: '含 mock 数据' }],
    });
    expect(card).toContain('【请回答问题】');
    expect(card).toContain('部署到哪个环境？');
    expect(card).toContain('仅影响 staging 实例');
    expect(card).toContain('选项:');
    expect(card).toContain('1. 生产');
    expect(card).toContain('2. 测试 (含 mock 数据)');
    expect(card).toContain('或者输入自定义答案');
    expect(card).toContain('请直接回复数字序号，或者直接输入你的答案');
    expect(card).not.toContain('3. 自定义');
    expect(card).not.toContain('请引用本消息');
  });

  it('无选项卡片：跳过选项头，恒保留自定义回答标记与单聊直接回复提示', () => {
    const card = KujiraQuestionProvider.formatQuestionCard({ id: 'q1', question: '用途说明' });
    expect(card).not.toContain('选项:');
    expect(card).toContain('或者输入自定义答案');
    expect(card).toContain('请直接回复数字序号，或者直接输入你的答案');
  });
});
