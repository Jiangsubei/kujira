import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { PLUGIN_NAME } from '../../src/constants/index.js';
import { QQ_PRESET_ID } from '../../src/constants/preset.js';
import * as KujiraPlugin from '../../src/index.js';
import { openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_SESSION_BASE = openidToSessionBaseId(MOCK_OPENID);

describe('契约测试: DSH 真实服务装配与 Kujira 插件挂载 (Assembly Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-assembly-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      config: {},
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

  it('断言 1: 真实 DSH 基础服务栈必须全部装配就绪', () => {
    const ctx = booted.ctx;

    // Agent 与 Session 服务
    expect(ctx.agents).toBeDefined();
    expect(typeof ctx.agents.create).toBe('function');
    expect(typeof ctx.agents.resume).toBe('function');

    expect(ctx.sessions).toBeDefined();
    expect(typeof ctx.sessions.get).toBe('function');
    expect(typeof ctx.sessions.create).toBe('function');

    // 存储服务
    expect(ctx.storageDomain).toBeDefined();
    expect(typeof ctx.storageDomain.open).toBe('function');

    // LLM 与 SystemPrompt
    expect(ctx.llm).toBeDefined();
    expect(ctx.systemPrompt).toBeDefined();
    expect(typeof ctx.systemPrompt.context).toBe('function');
    expect(typeof ctx.systemPrompt.section).toBe('function');

    // 提问、审批与权限预设
    expect(ctx.userQuestions).toBeDefined();
    expect(typeof ctx.userQuestions.ask).toBe('function');

    expect(ctx.approval).toBeDefined();
    expect(typeof ctx.approval.request).toBe('function');

    expect(ctx.permissionPresets).toBeDefined();
    expect(typeof ctx.permissionPresets.set).toBe('function');
  });

  it('断言 2: kujira 插件已成功注册并在 Context 上生效', () => {
    expect(booted.ctx).toBeDefined();
    expect(KujiraPlugin.name).toBe(PLUGIN_NAME);
    expect(booted.ctx.get('kujiraBridgeTools') || (booted.ctx as any).kujiraBridgeTools).toBeDefined();
    expect(booted.ctx.get('kujira-session') || (booted.ctx as any)['kujira-session']).toBeDefined();
    expect(booted.ctx.get('kujira-gateway') || (booted.ctx as any)['kujira-gateway']).toBeDefined();
    expect(
      booted.ctx.get('kujira-outbound-bridge') || (booted.ctx as any)['kujira-outbound-bridge']
    ).toBeDefined();
  });

  it('B2-契约 3: 插件通过 user-questions/request waterfall 接入 Kujira 单聊提问渠道', async () => {
    const uq = booted.ctx.userQuestions;
    expect(uq).toBeDefined();

    const handle = await booted.ctx.agents.create({
      sessionId: MOCK_SESSION_BASE,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'kujira-ws') },
    });
    const qqAgent = handle.agent || handle;

    // 无 openid 映射或未连接 gateway 时向 Kujira 会话提问，由 KujiraQuestionProvider 拦截并按真实出站错误拒绝
    await expect(
      uq.ask({
        agent: qqAgent,
        questions: [{ id: 'q1', question: 'x' }],
      })
    ).rejects.toThrow(/\[KujiraQuestionProvider\].*(?:发送提问消息.*失败|QQ Gateway 不可用|outboundBridge\/gateway 不可用)/);
  });

  it('TD001-契约 4: 插件通过 user-questions/request waterfall 级联共存，Kujira 会话由插件处理，Web 会话委托宿主', async () => {
    const tmpHome2 = path.join(tmpHome, 'booted2');
    await fsp.mkdir(tmpHome2, { recursive: true });
    const booted2 = await bootDshKujira({
      dshHome: tmpHome2,
      mountPlugin: false,
    });
    try {
      let webCalled = false;
      booted2.ctx.on('user-questions/request', async (req: any, next: any) => {
        const sid = req.agent?.session?.id || req.agent?.id || '';
        if (!sid.startsWith('kujira-')) {
          webCalled = true;
          return { answers: [{ id: 'q1', selected: ['web'] }] };
        }
        return next();
      });
      await booted2.ctx.plugin(KujiraPlugin, {});

      const webHandle = await booted2.ctx.agents.create({
        sessionId: 'web-session-1',
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        meta: { cwd: path.join(tmpHome2, 'web-ws-2') },
      });
      const webAgent = webHandle.agent || webHandle;

      // Web 会话 → 委托宿主 provider
      const webAnswer = await booted2.ctx.userQuestions.ask({
        agent: webAgent,
        questions: [{ id: 'q1', question: 'x' }],
      });
      expect(webCalled).toBe(true);
      expect(webAnswer).toEqual({ answers: [{ id: 'q1', selected: ['web'] }] });
    } finally {
      await booted2.dispose().catch(() => {});
    }
  });

  it('B3-契约 5: 预设体系工具隔离 — 非 Kujira 会话不含 Kujira 专属工具，Kujira 会话挂载预设正常放行', async () => {
    const tools: any = booted.ctx.get('tools');

    await fsp.mkdir(path.join(tmpHome, 'web-ws'), { recursive: true });
    await fsp.mkdir(path.join(tmpHome, 'kujira-ws'), { recursive: true });

    // 非 Kujira (Web) 会话 agent (未挂载 kujira-session 预设)
    const webHandle = await booted.ctx.agents.create({
      sessionId: 'web-session-1',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'web-ws') },
    });
    const webAgent = webHandle.agent || webHandle;
    const denied = await tools.execute({
      calls: [{ type: 'tool-call', id: 'call-web-denied', name: 'read_chat_history', arguments: '{}' }],
      agent: webAgent,
      signal: new AbortController().signal,
    });
    expect(denied.results[0]?.result.isError).toBe(true);

    // Kujira 会话 agent (挂载 kujira-session 预设)
    const qqHandle = await booted.ctx.agents.create({
      sessionId: `${MOCK_SESSION_BASE}-1`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'kujira-ws') },
      setup: async (agentCtx: any) => {
        await (booted.ctx as any).agentPresets.mount(agentCtx, QQ_PRESET_ID);
      },
    });
    const qqAgent = qqHandle.agent || qqHandle;
    const allowed = await tools.execute({
      calls: [{ type: 'tool-call', id: 'call-qq-allowed', name: 'read_chat_history', arguments: '{}' }],
      agent: qqAgent,
      signal: new AbortController().signal,
    });
    expect(allowed.results[0]?.result.isError).toBe(false);
  });

  it('B3-契约 6: system-prompt/assemble 呈现侧预设隔离 — Web 装配不含 Kujira 工具，Kujira 装配含全量', async () => {
    const KUJIRA_TOOLS = new Set([
      'read_chat_history',
      'send_file',
    ]);
    const REMOVED_TOOLS = ['fetch_chat_resource', 'expand_forward_message'];

    await fsp.mkdir(path.join(tmpHome, 'web-ws-2'), { recursive: true });
    await fsp.mkdir(path.join(tmpHome, 'kujira-ws-2'), { recursive: true });

    const webHandle = await booted.ctx.agents.create({
      sessionId: 'web-session-2',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'web-ws-2') },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await booted.ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webKujira = (asmWeb.tools as any[]).filter((t) => KUJIRA_TOOLS.has(t.name));
    expect(webKujira).toHaveLength(0);

    const qqHandle = await booted.ctx.agents.create({
      sessionId: `${MOCK_SESSION_BASE}-2`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'kujira-ws-2') },
      setup: async (agentCtx: any) => {
        await (booted.ctx as any).agentPresets.mount(agentCtx, QQ_PRESET_ID);
      },
    });
    const qqAgent = qqHandle.agent || qqHandle;
    const asmQq = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const qqKujira = (asmQq.tools as any[]).filter((t) => KUJIRA_TOOLS.has(t.name));
    expect(qqKujira.map((t) => t.name).sort()).toEqual([...KUJIRA_TOOLS].sort());

    const qqToolNames = new Set((asmQq.tools as any[]).map((t) => t.name));
    for (const removed of REMOVED_TOOLS) {
      expect(qqToolNames.has(removed)).toBe(false);
    }
  });

  it('断言 7: 审批本轮唤醒者追踪器真实装配，并经 session/event 严格绑定与清理', async () => {
    const sessionManager: any = (booted.ctx as any)['kujira-session'];
    expect(sessionManager).toBeDefined();

    const tracker = sessionManager.getTurnInitiatorTracker?.();
    expect(tracker).toBeDefined();

    const handle = await booted.ctx.agents.create({
      sessionId: `${MOCK_SESSION_BASE}-3`,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: path.join(tmpHome, 'kujira-ws-3') },
    });
    const agent = handle.agent || handle;
    const session = agent.session;

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '审批装配探针' }],
      source: { kind: 'user' },
    });

    expect(tracker.expect(userMsg.id, session.id, MOCK_OPENID)).toBe(true);
    session.append('turn/start', { turn: 1 });
    session.append('user/message', userMsg, { surfaceOp: 'append' });
    expect(tracker.getInitiator(session.id)).toBe(MOCK_OPENID);

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(tracker.getInitiator(session.id)).toBeUndefined();
  });
});
