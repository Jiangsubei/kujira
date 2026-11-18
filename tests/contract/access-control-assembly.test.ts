import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { CONFIG_ROUTE_PATH } from '../../src/server/routes.js';
import { PRIVACY_ISOLATED_TOOL_NAMES } from '../../src/constants/index.js';
import { openidToPeer } from '../../src/utils/peer.js';
import type { SessionManager } from '../../src/gateway/session.js';
import type { KujiraGatewayClient } from '../../src/gateway/server.js';
import type { OutboundStreamBridge } from '../../src/outbound/stream.js';

const ADMIN_OPENID = '10000000000000000000000000000011';
const GUEST_OPENID = '10000000000000000000000000000012';
const ADMIN_PEER = openidToPeer(ADMIN_OPENID);
const GUEST_PEER = openidToPeer(GUEST_OPENID);

interface CapturedRoute {
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function createFakeReq(method: string, body?: unknown): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  (emitter as any).method = method;
  (emitter as any).headers = { 'content-type': 'application/json' };
  queueMicrotask(() => {
    if (body !== undefined) {
      emitter.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    }
    emitter.emit('end');
  });
  return emitter;
}

function createFakeRes() {
  let status = 200;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      return res;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => status,
    getJson: () => (body ? JSON.parse(body) : null),
  };
}

function getVisibleToolNames(agent: any): Set<string> {
  const toolsSvc = agent?.ctx?.get?.('tools') || agent?.ctx?.tools;
  const defs = toolsSvc?.definitions?.(agent) || [];
  return new Set(defs.map((d: any) => d.name));
}

describe('契约测试: 权限分层与隐私工具热隔离生产装配端到端闭环 (Access Control Assembly)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let routes: Map<string, CapturedRoute['handler']>;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-access-asm-'));
    routes = new Map();

    booted = await bootDshKujira({
      dshHome: tmpHome,
      config: {},
      prepare: (hostCtx) => {
        (hostCtx as any).provide?.('connection', {
          requestRejection: () => undefined,
        });
        (hostCtx as any).connection = {
          requestRejection: () => undefined,
        };
        const fakeWebServer = {
          register(spec: CapturedRoute) {
            routes.set(spec.path, spec.handler);
            return () => {
              routes.delete(spec.path);
            };
          },
        };
        (hostCtx as any).provide?.('webServer', fakeWebServer);
        (hostCtx as any).webServer = fakeWebServer;
      },
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

  async function postConfig(payload: Record<string, unknown>) {
    const handler = routes.get(CONFIG_ROUTE_PATH);
    expect(handler).toBeTypeOf('function');
    const fakeRes = createFakeRes();
    await handler!(createFakeReq('POST', payload), fakeRes.res);
    expect(fakeRes.getStatus()).toBe(200);
    return fakeRes.getJson();
  }

  it('装配闭环 1: POST /plugins/kujira/config 触发 reconcile，存活会话隐私工具双向热生效且保留 send_file/read_image', async () => {
    const sm = (booted.ctx.get('kujira-session') ||
      (booted.ctx as any)['kujira-session']) as SessionManager;
    expect(sm).toBeDefined();

    // 1. 默认 1 对 1 模式下创建两个存活会话：均保有完整工具
    const adminAgent = await sm.getOrCreateAgent(ADMIN_PEER);
    const guestAgent = await sm.getOrCreateAgent(GUEST_PEER);

    const expectedShell = process.platform === 'win32' ? 'pwsh' : 'bash';
    const guestInitialTools = getVisibleToolNames(guestAgent);
    expect(guestInitialTools.has(expectedShell)).toBe(true);
    expect(guestInitialTools.has('read')).toBe(true);
    expect(guestInitialTools.has('send_file')).toBe(true);

    // 2. 通过真实配置路由切为白名单模式（仅放行 ADMIN_PEER）→ 触发 reconcile 热同步
    await postConfig({
      admins: [ADMIN_PEER],
      privacy_tools_list_mode: 'whitelist',
      privacy_tools_whitelist: [ADMIN_PEER],
    });

    const adminAfterWhitelist = getVisibleToolNames(adminAgent);
    const guestAfterWhitelist = getVisibleToolNames(guestAgent);

    // 管理员仍拥有完整工具
    expect(adminAfterWhitelist.has(expectedShell)).toBe(true);
    expect(adminAfterWhitelist.has('read')).toBe(true);
    expect(adminAfterWhitelist.has('send_file')).toBe(true);

    // 非白名单存活会话立即热收回全部 9 项隐私工具，同时保留 send_file 与聊天基础工具
    for (const toolName of PRIVACY_ISOLATED_TOOL_NAMES) {
      expect(guestAfterWhitelist.has(toolName)).toBe(false);
    }
    expect(guestAfterWhitelist.has('send_file')).toBe(true);
    expect(guestAfterWhitelist.has('send_qq_message')).toBe(true);

    // 3. 中途将 GUEST_PEER 加入白名单 → 同一个存活会话立即热恢复隐私工具（无需新建/重启）
    await postConfig({
      privacy_tools_list_mode: 'whitelist',
      privacy_tools_whitelist: [ADMIN_PEER, GUEST_PEER],
    });

    const guestAfterRestore = getVisibleToolNames(guestAgent);
    expect(guestAfterRestore.has(expectedShell)).toBe(true);
    expect(guestAfterRestore.has('read')).toBe(true);
    expect(guestAfterRestore.has('write')).toBe(true);
    expect(guestAfterRestore.has('edit')).toBe(true);
    expect(guestAfterRestore.has('working_directory')).toBe(true);
    expect(guestAfterRestore.has('skill')).toBe(true);
  });

  it('装配闭环 2: 生产 approval/request waterfall 接入热更新 admins，非管理员静默 Fail-Closed、管理员正常弹窗', async () => {
    const sm = (booted.ctx.get('kujira-session') ||
      (booted.ctx as any)['kujira-session']) as SessionManager;
    const outbound = (booted.ctx.get('kujira-outbound-bridge') ||
      (booted.ctx as any)['kujira-outbound-bridge']) as OutboundStreamBridge;

    const sent: Array<{ peer: string; text: string }> = [];
    (outbound as any).sendTextReply = async (peer: string, text: string) => {
      sent.push({ peer, text });
      return { ok: true, status: 200, body: { id: `mock-out-${sent.length}`, timestamp: '' } };
    };

    const adminAgent = await sm.getOrCreateAgent(ADMIN_PEER);
    const guestAgent = await sm.getOrCreateAgent(GUEST_PEER);
    const tracker = sm.getTurnInitiatorTracker();
    expect(tracker).toBeDefined();

    // 通过配置路由热写入管理员名单
    await postConfig({ admins: [ADMIN_PEER] });

    // 模拟真实人类发起本轮（非定时任务）
    tracker!.expect('msg-guest-1', guestAgent.session.id, GUEST_OPENID);
    tracker!.observe(guestAgent.session, { type: 'turn/start' });
    tracker!.observe(guestAgent.session, {
      type: 'user/message',
      data: { id: 'msg-guest-1', source: { kind: 'user' } },
    });

    // 非管理员走真实 approval/request waterfall：立即拒绝且绝不下发审批提示
    const guestDecision = await (booted.ctx as any).waterfall(
      guestAgent,
      'approval/request',
      {
        agent: guestAgent,
        toolName: 'write',
        callId: 'call-guest-1',
        reason: '写入文件',
      },
      () => 'unavailable'
    );
    expect(guestDecision).toBe('rejected');
    expect(sent).toHaveLength(0);

    // 管理员走真实 approval/request waterfall：下发审批提示并通过 AbortSignal 收尾
    tracker!.expect('msg-admin-1', adminAgent.session.id, ADMIN_OPENID);
    tracker!.observe(adminAgent.session, { type: 'turn/start' });
    tracker!.observe(adminAgent.session, {
      type: 'user/message',
      data: { id: 'msg-admin-1', source: { kind: 'user' } },
    });

    const ac = new AbortController();
    const adminPromise = (booted.ctx as any).waterfall(
      adminAgent,
      'approval/request',
      {
        agent: adminAgent,
        toolName: 'write',
        callId: 'call-admin-1',
        reason: '管理员写入文件',
        signal: ac.signal,
      },
      () => 'unavailable'
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(ADMIN_PEER);
    expect(sent[0]!.text).toContain('【审批请求】');

    ac.abort();
    expect(await adminPromise).toBe('cancelled');
  });

  it('装配闭环 3: 生产 C2C_MESSAGE_CREATE 入站斜杠命令按热更新 admins 分层放行与拦截', async () => {
    const gateway = (booted.ctx.get('kujira-gateway') ||
      (booted.ctx as any)['kujira-gateway']) as KujiraGatewayClient;
    const outbound = (booted.ctx.get('kujira-outbound-bridge') ||
      (booted.ctx as any)['kujira-outbound-bridge']) as OutboundStreamBridge;

    const sent: Array<{ peer: string; text: string }> = [];
    (outbound as any).sendTextReply = async (peer: string, text: string) => {
      sent.push({ peer, text });
      return { ok: true, status: 200, body: { id: `mock-cmd-${sent.length}`, timestamp: '' } };
    };

    // 通过配置路由设置管理员为 ADMIN_PEER
    await postConfig({ admins: [ADMIN_PEER] });

    const emitC2C = async (openid: string, id: string, text: string) => {
      const handlers = (gateway as any).c2cMessageHandlers as Array<(ev: any) => Promise<void> | void>;
      expect(Array.isArray(handlers) && handlers.length > 0).toBe(true);
      const event = {
        id,
        content: text,
        timestamp: new Date().toISOString(),
        author: { user_openid: openid, username: 'TestUser' },
      };
      for (const fn of handlers) {
        await fn(event);
      }
    };

    // 非管理员触发 /权限、/模型 ... -默认、/思考 ... -默认 → 拦截
    await emitC2C(GUEST_OPENID, 'in-g-1', '/权限');
    expect(sent.at(-1)?.peer).toBe(GUEST_PEER);
    expect(sent.at(-1)?.text).toContain('权限不足');

    await emitC2C(GUEST_OPENID, 'in-g-2', '/模型 deepseek-v4-flash -默认');
    expect(sent.at(-1)?.peer).toBe(GUEST_PEER);
    expect(sent.at(-1)?.text).toContain('权限不足');

    await emitC2C(GUEST_OPENID, 'in-g-3', '/思考 high -默认');
    expect(sent.at(-1)?.peer).toBe(GUEST_PEER);
    expect(sent.at(-1)?.text).toContain('权限不足');

    // 非管理员触发普通命令 /帮助 与 /思考（无 -默认）→ 正常放行
    await emitC2C(GUEST_OPENID, 'in-g-4', '/帮助');
    expect(sent.at(-1)?.peer).toBe(GUEST_PEER);
    expect(sent.at(-1)?.text).toContain('【快捷指令帮助】');

    await emitC2C(GUEST_OPENID, 'in-g-5', '/思考');
    expect(sent.at(-1)?.peer).toBe(GUEST_PEER);
    expect(sent.at(-1)?.text).not.toContain('权限不足');
    expect(sent.at(-1)?.text).not.toContain('--全局');

    // 管理员触发 /权限 → 正常放行
    await emitC2C(ADMIN_OPENID, 'in-a-1', '/权限');
    expect(sent.at(-1)?.peer).toBe(ADMIN_PEER);
    expect(sent.at(-1)?.text).toContain('当前权限模式');
  });
});
