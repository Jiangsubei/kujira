import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import * as KujiraPlugin from '../../src/index.js';
import { KujiraApprovalResponder } from '../../src/approval/tool-approval.js';
import { TurnInitiatorTracker } from '../../src/approval/turn-initiator.js';
import { SessionManager } from '../../src/gateway/session.js';
import { PRIVACY_ISOLATED_TOOL_NAMES } from '../../src/constants/index.js';
import { QQ_PRESET_ID } from '../../src/constants/preset.js';
import type { BridgePluginConfig } from '../../src/types/index.js';
import type { OutboundStreamBridge } from '../../src/outbound/stream.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const ADMIN_OPENID_1 = '10000000000000000000000000000001';
const ADMIN_OPENID_2 = '10000000000000000000000000000002';
const GUEST_OPENID = '10000000000000000000000000000003';

const ADMIN_PEER_1 = openidToPeer(ADMIN_OPENID_1);
const ADMIN_PEER_2 = openidToPeer(ADMIN_OPENID_2);
const GUEST_PEER = openidToPeer(GUEST_OPENID);
const ADMIN_SESSION_1 = openidToSessionBaseId(ADMIN_OPENID_1);

function createMockOutbound(sent: Array<{ peer: string; text: string }> = []) {
  return {
    sendTextReply: async (peer: string, text: string) => {
      sent.push({ peer, text });
      return { ok: true, status: 200, body: { id: `out-${sent.length}`, timestamp: '' } };
    },
  } as unknown as OutboundStreamBridge;
}

function makeDummyToolDefinition(name: string) {
  return {
    name,
    description: `contract dummy tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      render: () => 'ok',
    },
    execute: async () => ({ ok: true }),
  };
}

function getVisibleToolNames(agent: any): Set<string> {
  const toolsSvc = agent?.ctx?.get?.('tools') || agent?.ctx?.tools;
  const defs = toolsSvc?.definitions?.(agent) || [];
  return new Set(defs.map((d: any) => d.name));
}

describe('契约测试: 审批管理员权限回归与竞态防线 (Approval Admin Contract)', () => {
  it('契约 1: 默认 admins 为空（1 对 1 模式）时，真实单聊好友触发审批可下发提示并回复 y 放行', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(sent),
      getConfig: () => ({ admins: [] }),
    });

    const p = responder.handleApprovalRequest({
      peer: GUEST_PEER,
      applicantId: GUEST_OPENID,
      toolName: 'write',
      reason: '1 对 1 模式单聊操作',
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(GUEST_PEER);
    expect(sent[0]!.text).toContain('【审批请求】');

    expect(responder.handleInboundReply(GUEST_PEER, 'y')).toBe(true);
    expect(await p).toBe('allowed-once');
  });

  it('契约 2: 无人值守定时任务（applicantId 为 null 或 turnInitiatorTracker 无发起人）即使 admins 为空也严格 Fail-Closed 且不下发提示', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    const tracker = new TurnInitiatorTracker();
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(sent),
      turnInitiatorTracker: tracker,
      getConfig: () => ({ admins: [] }),
    });

    expect(
      await responder.handleApprovalRequest({
        peer: ADMIN_PEER_1,
        applicantId: null,
        toolName: 'pwsh',
        reason: '无人值守定时任务',
      })
    ).toBe('rejected');

    expect(
      await responder.handleApprovalRequest({
        peer: ADMIN_PEER_1,
        applicantId: 'system',
        toolName: 'pwsh',
        reason: '系统伪身份',
      })
    ).toBe('rejected');

    tracker.observe({ id: ADMIN_SESSION_1 }, { type: 'turn/start' });
    tracker.observe({ id: ADMIN_SESSION_1 }, {
      type: 'user/message',
      data: { id: 'msg-unattended-1', source: { kind: 'user' } },
    });
    expect(tracker.getInitiator(ADMIN_SESSION_1)).toBeUndefined();

    expect(
      await responder.handleApprovalRequest({
        peer: ADMIN_PEER_1,
        sessionId: ADMIN_SESSION_1,
        toolName: 'pwsh',
        reason: 'tracker 无本轮真实发起人',
      })
    ).toBe('rejected');

    expect(sent).toHaveLength(0);
  });

  it('契约 3: 配置 admins（含多管理员）后，仅管理员可弹窗审批放行，非管理员或非管理员 applicantId 直接 Fail-Closed 且不下发提示', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(sent),
      admins: [ADMIN_PEER_1, ADMIN_PEER_2],
    });

    // 非管理员 peer 直接拒绝且不下发任何消息
    expect(
      await responder.handleApprovalRequest({
        peer: GUEST_PEER,
        applicantId: GUEST_OPENID,
        toolName: 'pwsh',
        reason: '非管理员尝试执行命令',
      })
    ).toBe('rejected');
    expect(sent).toHaveLength(0);

    // peer 为管理员但 applicantId 为非管理员 → 同样直接拒绝且不下发
    expect(
      await responder.handleApprovalRequest({
        peer: ADMIN_PEER_1,
        applicantId: GUEST_OPENID,
        toolName: 'pwsh',
        reason: '非管理员冒充发起人',
      })
    ).toBe('rejected');
    expect(sent).toHaveLength(0);

    // 管理员 1 与管理员 2 均可正常弹窗审批并放行
    const p1 = responder.handleApprovalRequest({
      peer: ADMIN_PEER_1,
      applicantId: ADMIN_OPENID_1,
      toolName: 'pwsh',
      reason: '管理员 1 审批',
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sent).toHaveLength(1);
    expect(responder.handleInboundReply(ADMIN_PEER_1, 'y')).toBe(true);
    expect(await p1).toBe('allowed-once');

    const p2 = responder.handleApprovalRequest({
      peer: ADMIN_PEER_2,
      applicantId: ADMIN_OPENID_2,
      toolName: 'write',
      reason: '管理员 2 审批',
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sent).toHaveLength(2);
    expect(responder.handleInboundReply(ADMIN_PEER_2, '同意')).toBe(true);
    expect(await p2).toBe('allowed-once');
  });

  it('契约 4: admins 通过 getConfig 热更新即时生效，且审批挂起期间被移出 admins 后回复 y 必须转为 rejected', async () => {
    const sent: Array<{ peer: string; text: string }> = [];
    let currentConfig: Pick<BridgePluginConfig, 'admins'> = {
      admins: [ADMIN_PEER_1],
    };

    const responder = new KujiraApprovalResponder({
      outboundBridge: createMockOutbound(sent),
      getConfig: () => currentConfig,
      admins: [GUEST_PEER], // 验证 getConfig 优先于静态 admins
    });

    // 初始时 GUEST_PEER 不在 getConfig().admins 中，直接拒绝
    expect(
      await responder.handleApprovalRequest({
        peer: GUEST_PEER,
        applicantId: GUEST_OPENID,
        toolName: 'edit',
        reason: '未授权',
      })
    ).toBe('rejected');
    expect(sent).toHaveLength(0);

    // 热更新把 GUEST_PEER 加入 admins 后，新审批请求立即放行下发
    currentConfig = { admins: [ADMIN_PEER_1, GUEST_PEER] };
    const pendingPromise = responder.handleApprovalRequest({
      peer: GUEST_PEER,
      applicantId: GUEST_OPENID,
      toolName: 'edit',
      reason: '热更新后发起审批',
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sent).toHaveLength(1);
    expect(responder.isWaiting(GUEST_PEER)).toBe(true);

    // 审批挂起期间，管理员在后台将 GUEST_PEER 移出 admins
    currentConfig = { admins: [ADMIN_PEER_1] };

    // 即使 GUEST_PEER 随后回复 y，也绝不允许 allowed-once，必须立即转为 rejected 并消费该回复
    expect(responder.handleInboundReply(GUEST_PEER, 'y')).toBe(true);
    expect(await pendingPromise).toBe('rejected');
    expect(responder.isWaiting(GUEST_PEER)).toBe(false);
  });
});

describe('契约测试: 真实 DSH SessionManager 会话隐私工具热隔离 (Privacy Tools Hot Isolation Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;
  let liveConfig: BridgePluginConfig;
  let sessionManager: SessionManager;

  const expectedPlatformIsolated = PRIVACY_ISOLATED_TOOL_NAMES.filter((name) => {
    if (process.platform === 'win32' && name === 'bash') return false;
    if (process.platform !== 'win32' && name === 'pwsh') return false;
    return true;
  });

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-privacy-'));
    liveConfig = {
      privacy_tools_list_mode: 'blacklist',
      privacy_tools_blacklist: [],
      privacy_tools_whitelist: [],
    };

    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
      extraPatches: [
        {
          id: 'agent-preset-registry',
          config: { default: QQ_PRESET_ID },
        },
      ],
    });

    await booted.ctx.plugin(KujiraPlugin, {});

    // 补齐默认 preset 中未在测试环境开启的隐私工具（apply_patch / load_workspace_dependencies），
    // 以在真实 DSH ToolsService 上完整验证全部平台隐私工具的隔离与恢复行为
    const toolsSvc: any = (booted.ctx as any).get?.('tools') || (booted.ctx as any).tools;
    for (const extraName of ['apply_patch', 'load_workspace_dependencies']) {
      if (!toolsSvc.get(extraName)) {
        toolsSvc.register(makeDummyToolDefinition(extraName));
      }
    }

    sessionManager = new SessionManager(booted.ctx, tmpHome, undefined, {
      configGetter: () => liveConfig,
    });
  });

  afterEach(async () => {
    if (sessionManager) {
      await sessionManager.dispose().catch(() => {});
    }
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 默认配置（blacklist + []）下，会话不限制隐私工具，所有平台隐私工具与 send_file/read_image 均可见', async () => {
    const agent = await sessionManager.getOrCreateAgent(GUEST_PEER);
    const visible = getVisibleToolNames(agent);

    for (const name of expectedPlatformIsolated) {
      expect(visible.has(name)).toBe(true);
    }
    expect(visible.has('send_file')).toBe(true);
    expect(visible.has('read_image')).toBe(true);
    expect(visible.has('send_qq_message')).toBe(true);
  });

  it('契约 2: 黑名单模式下，命中 peer 隔离全部隐私工具，未命中 peer 完整保留，且 send_file 与 read_image 始终不被隔离', async () => {
    liveConfig = {
      privacy_tools_list_mode: 'blacklist',
      privacy_tools_blacklist: [GUEST_PEER],
      privacy_tools_whitelist: [],
    };

    const guestAgent = await sessionManager.getOrCreateAgent(GUEST_PEER);
    const adminAgent = await sessionManager.getOrCreateAgent(ADMIN_PEER_1);

    const guestVisible = getVisibleToolNames(guestAgent);
    const adminVisible = getVisibleToolNames(adminAgent);

    // 命中黑名单的用户：所有平台隐私工具均不可见
    for (const name of expectedPlatformIsolated) {
      expect(guestVisible.has(name)).toBe(false);
    }
    // send_file / read_image 与常规单聊工具必须始终保留
    expect(guestVisible.has('send_file')).toBe(true);
    expect(guestVisible.has('read_image')).toBe(true);
    expect(guestVisible.has('send_qq_message')).toBe(true);

    // 未命中黑名单的用户：所有隐私工具完整保留
    for (const name of expectedPlatformIsolated) {
      expect(adminVisible.has(name)).toBe(true);
    }
    expect(adminVisible.has('send_file')).toBe(true);
    expect(adminVisible.has('read_image')).toBe(true);
  });

  it('契约 3: 白名单模式下，空白名单全员隔离；加入白名单的 peer 放行，其余 peer 隔离', async () => {
    // 空白名单 → 全员隔离
    liveConfig = {
      privacy_tools_list_mode: 'whitelist',
      privacy_tools_blacklist: [],
      privacy_tools_whitelist: [],
    };

    const guestAgent = await sessionManager.getOrCreateAgent(GUEST_PEER);
    const guestVisibleInitially = getVisibleToolNames(guestAgent);
    for (const name of expectedPlatformIsolated) {
      expect(guestVisibleInitially.has(name)).toBe(false);
    }
    expect(guestVisibleInitially.has('send_file')).toBe(true);
    expect(guestVisibleInitially.has('read_image')).toBe(true);

    // 将 ADMIN_PEER_1 加入白名单：ADMIN_PEER_1 放行，GUEST_PEER 仍被隔离
    liveConfig = {
      privacy_tools_list_mode: 'whitelist',
      privacy_tools_blacklist: [],
      privacy_tools_whitelist: [ADMIN_PEER_1],
    };

    const adminAgent = await sessionManager.getOrCreateAgent(ADMIN_PEER_1);
    const adminVisible = getVisibleToolNames(adminAgent);
    for (const name of expectedPlatformIsolated) {
      expect(adminVisible.has(name)).toBe(true);
    }

    sessionManager.syncPrivacyToolsForActiveSessions();
    const guestVisibleStill = getVisibleToolNames(guestAgent);
    for (const name of expectedPlatformIsolated) {
      expect(guestVisibleStill.has(name)).toBe(false);
    }
    expect(guestVisibleStill.has('send_file')).toBe(true);
    expect(guestVisibleStill.has('read_image')).toBe(true);
  });

  it('契约 4 (核心热切换): 存活会话无需重建，配置拉黑/切白名单与放行后调用 syncPrivacyToolsForActiveSessions 立即双向热生效', async () => {
    // 1. 初始默认（未隔离）创建存活会话
    const agent = await sessionManager.getOrCreateAgent(GUEST_PEER);
    const initialSessionId = (agent as any).session?.id;
    let visible = getVisibleToolNames(agent);
    for (const name of expectedPlatformIsolated) {
      expect(visible.has(name)).toBe(true);
    }

    // 2. 会话存活中途拉黑并热同步 → 隐私工具立即从 agent.ctx.tools.definitions(agent) 消失
    liveConfig = {
      privacy_tools_list_mode: 'blacklist',
      privacy_tools_blacklist: [GUEST_PEER],
      privacy_tools_whitelist: [],
    };
    sessionManager.syncPrivacyToolsForActiveSessions();
    // 重复调用保持幂等不报错
    sessionManager.syncPrivacyToolsForActiveSessions();

    expect(sessionManager.getAgent(GUEST_PEER)).toBe(agent);
    expect((agent as any).session?.id).toBe(initialSessionId);

    visible = getVisibleToolNames(agent);
    for (const name of expectedPlatformIsolated) {
      expect(visible.has(name)).toBe(false);
    }
    expect(visible.has('send_file')).toBe(true);
    expect(visible.has('read_image')).toBe(true);

    // 3. 修改配置移出黑名单并热同步 → 隐私工具立即热恢复可见
    liveConfig = {
      privacy_tools_list_mode: 'blacklist',
      privacy_tools_blacklist: [],
      privacy_tools_whitelist: [],
    };
    sessionManager.syncPrivacyToolsForActiveSessions();

    visible = getVisibleToolNames(agent);
    for (const name of expectedPlatformIsolated) {
      expect(visible.has(name)).toBe(true);
    }

    // 4. 切换至空白名单并热同步 → 再次立即隔离
    liveConfig = {
      privacy_tools_list_mode: 'whitelist',
      privacy_tools_blacklist: [],
      privacy_tools_whitelist: [],
    };
    sessionManager.syncPrivacyToolsForActiveSessions();

    visible = getVisibleToolNames(agent);
    for (const name of expectedPlatformIsolated) {
      expect(visible.has(name)).toBe(false);
    }
    expect(visible.has('send_file')).toBe(true);
    expect(visible.has('read_image')).toBe(true);

    // 5. 加入白名单并热同步 → 再次热恢复可见，且始终是同一个存活 Agent 实例
    liveConfig = {
      privacy_tools_list_mode: 'whitelist',
      privacy_tools_blacklist: [],
      privacy_tools_whitelist: [GUEST_PEER],
    };
    sessionManager.syncPrivacyToolsForActiveSessions();

    expect(sessionManager.getAgent(GUEST_PEER)).toBe(agent);
    visible = getVisibleToolNames(agent);
    for (const name of expectedPlatformIsolated) {
      expect(visible.has(name)).toBe(true);
    }
  });

  it('契约 5 (容错降级): 当个别隐私工具挂在 own layer 导致批量 tools.restrict 抛错时，优雅降级隔离其余工具且不炸毁会话创建与热同步', async () => {
    const restricted = new Set<string>();
    const ownLayerTool = 'read';
    const toolsSvc = {
      definitions: () => [
        { name: 'read' },
        { name: 'write' },
        { name: 'edit' },
        { name: 'send_file' },
        { name: 'read_image' },
      ],
      restrict: ({ deny }: { deny?: string[] }) => {
        const list = deny || [];
        if (list.includes(ownLayerTool)) {
          throw new Error(`tools.restrict() names unknown global tool "${ownLayerTool}"`);
        }
        for (const name of list) restricted.add(name);
        return () => {
          for (const name of list) restricted.delete(name);
        };
      },
    };
    const scopedCtx = { get: (k: string) => (k === 'tools' ? toolsSvc : undefined) };
    const fakeAgent: any = { session: { id: 'kujira-user-fallbacktest' }, ctx: scopedCtx };
    let cfg: BridgePluginConfig = {
      privacy_tools_list_mode: 'blacklist',
      privacy_tools_blacklist: [GUEST_PEER],
      privacy_tools_whitelist: [],
    };
    const mockHostCtx: any = {
      get: (key: string) => {
        if (key === 'agents') {
          return {
            get: () => undefined,
            create: async ({ setup }: any) => {
              await setup?.(scopedCtx, fakeAgent);
              return { agent: fakeAgent, dispose: async () => {} };
            },
          };
        }
        return undefined;
      },
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      config: {},
    };

    const isolatedMgr = new SessionManager(mockHostCtx, tmpHome, undefined, {
      configGetter: () => cfg,
    });
    try {
      await isolatedMgr.getOrCreateAgent(GUEST_PEER);
      // read 抛错被忽略，但 write/edit 成功降级隔离，send_file/read_image 绝不被加入
      expect(restricted.has('write')).toBe(true);
      expect(restricted.has('edit')).toBe(true);
      expect(restricted.has('send_file')).toBe(false);
      expect(restricted.has('read_image')).toBe(false);

      // 移出黑名单并热同步 → 降级组合 disposer 正确释放全部已隔离项
      cfg = {
        privacy_tools_list_mode: 'blacklist',
        privacy_tools_blacklist: [],
        privacy_tools_whitelist: [],
      };
      isolatedMgr.syncPrivacyToolsForActiveSessions();
      expect(restricted.size).toBe(0);
    } finally {
      await isolatedMgr.dispose();
    }
  });
});
