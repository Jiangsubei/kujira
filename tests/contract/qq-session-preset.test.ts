import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { SessionManager } from '../../src/gateway/session.js';
import * as KujiraPlugin from '../../src/index.js';
import {
  QQ_PRESET_ID,
  QQ_PRESET_NAME,
  QQ_PRESET_PERSONA_PREFIX,
} from '../../src/constants/preset.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

describe('契约测试: Kujira 单聊会话专属预设装配与工具隔离 (QQ Session Preset Contract)', () => {
  let tmpHome: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-preset-contract-'));
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

    await booted.ctx.plugin(KujiraPlugin, {
      face_enabled: true,
      slang_enabled: true,
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

  it('契约 1: 运行时 agentPresets 存在时，kujira-session 预设必须成功注册', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    expect(presetsSvc).toBeDefined();

    // 等待异步注册完成
    const list = await presetsSvc.list();
    const qqPreset = list.find((p: any) => p.id === QQ_PRESET_ID);
    expect(qqPreset).toBeDefined();
    expect(qqPreset.name).toBe(QQ_PRESET_NAME);
  });

  it('契约 2: 挂载 kujira-session 预设的 Agent，Prompt 必须被 complete: true 完全覆盖为单聊专属轻量提示词', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws');
    fs.mkdirSync(qqWs, { recursive: true });

    const qqHandle = await booted.ctx.agents.create({
      sessionId: MOCK_SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await presetsSvc.mount(agentCtx, QQ_PRESET_ID);
      },
    });

    const qqAgent = qqHandle.agent || qqHandle;
    const asm = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);

    const fullPrompt = ((asm as any).sections as any[]).map((s) => s.text).join('\n');

    // 专属 Prompt 验证：包含目标指令且完全不包含默认 coding 提示词
    expect(fullPrompt).toContain(QQ_PRESET_PERSONA_PREFIX);
    expect(fullPrompt).toContain('当前会话是 QQ 官方 Bot 单聊（C2C）会话');
    expect(fullPrompt).toContain('收到用户消息时，你需要先分析对方的情绪和意图');
    expect(fullPrompt).toContain('即使是简短闲聊，也不可跳过这个流程。');
    expect(fullPrompt).toContain('当用户提出一个具体的请求时，你需要是一个有帮助的助手。');
    expect(fullPrompt).not.toContain('You are a coding agent');
    expect(fullPrompt).not.toContain('git commit');
  });

  it('契约 3: 挂载 kujira-session 预设的 Agent，工具集合必须包含基础文件/Shell/Web及全量 Kujira 单聊专属工具', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const qqWs = path.join(tmpHome, 'qq-ws-tools');
    fs.mkdirSync(qqWs, { recursive: true });

    const qqHandle = await booted.ctx.agents.create({
      sessionId: MOCK_SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await presetsSvc.mount(agentCtx, QQ_PRESET_ID);
      },
    });

    const qqAgent = qqHandle.agent || qqHandle;
    const asm = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const toolNames = new Set((asm.tools as any[]).map((t) => t.name));

    // 1. 基础工作区与文件工具
    expect(toolNames.has('read')).toBe(true);
    expect(toolNames.has('write')).toBe(true);
    expect(toolNames.has('edit')).toBe(true);
    expect(toolNames.has('read_image')).toBe(true);
    expect(toolNames.has('working_directory')).toBe(true);

    // 2. 跨平台 Shell (Windows 下为 pwsh，Unix 下为 bash)
    if (process.platform === 'win32') {
      expect(toolNames.has('pwsh')).toBe(true);
      expect(toolNames.has('bash')).toBe(false);
    } else {
      expect(toolNames.has('bash')).toBe(true);
      expect(toolNames.has('pwsh')).toBe(false);
    }

    // 3. 官方 Web 搜索
    expect(toolNames.has('web_search')).toBe(true);
    expect(toolNames.has('web_fetch')).toBe(true);

    // 4. 技能与提问工具
    expect(toolNames.has('skill')).toBe(true);
    expect(toolNames.has('ask_user_question')).toBe(true);

    // 5. 保留的 Kujira 单聊专属工具
    expect(toolNames.has('send_qq_message')).toBe(true);
    expect(toolNames.has('recall_message')).toBe(true);
    expect(toolNames.has('read_chat_history')).toBe(true);
    expect(toolNames.has('send_file')).toBe(true);
    expect(toolNames.has('wait_for_user_messages')).toBe(true);
    expect(toolNames.has('send_face')).toBe(true);
    expect(toolNames.has('list_faces')).toBe(true);
    expect(toolNames.has('collect_face')).toBe(true);
    expect(toolNames.has('manage_faces')).toBe(true);
    expect(toolNames.has('read_memory')).toBe(true);
    expect(toolNames.has('create_memory')).toBe(true);
    expect(toolNames.has('edit_memory')).toBe(true);
    expect(toolNames.has('query_slang')).toBe(true);
    expect(toolNames.has('record_slang')).toBe(true);
    expect(toolNames.has('manage_slang')).toBe(true);
    expect(toolNames.has('schedule_task')).toBe(true);
    expect(toolNames.has('manage_scheduled_tasks')).toBe(true);

    // 6. 已移除的旧群聊/空间/多代理/资源拉取与转发展开工具绝不能在预设中注册
    for (const removed of [
      'fetch_chat_resource',
      'expand_forward_message',
      'read_qzone_feeds',
      'publish_qzone_feed',
      'comment_qzone_feed',
      'delete_qzone_feed',
      'get_friend_list',
      'get_user_profile',
      'get_group_list',
      'get_group_info',
      'get_group_notice',
      'get_group_member_info',
      'list_group_files',
      'poke_user',
      'react_message',
      'list_active_agents',
      'create_target_agent',
      'send_agent_message',
    ]) {
      expect(toolNames.has(removed)).toBe(false);
    }
  });

  it('契约 4: 通过 SessionManager 创建的 Kujira 单聊 Agent 会话自动挂载 kujira-session 预设', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const agent = await sessionManager.getOrCreateAgent(MOCK_PEER);
    expect(agent).toBeDefined();

    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const composedPreset = presetsSvc.composedPreset(agent.ctx);
    expect(composedPreset).toBe(QQ_PRESET_ID);

    // 验证其 assemble 结果
    const asm = await booted.ctx.systemPrompt.assemble({ scope: agent, agent } as any);
    const fullPrompt = ((asm as any).sections as any[]).map((s) => s.text).join('\n');
    expect(fullPrompt).toContain(QQ_PRESET_PERSONA_PREFIX);
    expect(fullPrompt).not.toContain('You are a coding agent');
  });

  it('契约 5: 挂载 kujira-session 预设的 Agent，运行时上下文未被抑制并正常注入', async () => {
    const sessionManager = new SessionManager(booted.ctx, tmpHome);
    const agent = await sessionManager.getOrCreateAgent(MOCK_PEER);

    const asm = await booted.ctx.systemPrompt.assemble({ scope: agent, agent } as any);
    const contextNames = (asm.contexts as any[]).map((c) => c.name);

    // 验证运行时上下文未被抑制
    expect(contextNames.some((n: string) => n.startsWith('working-directory'))).toBe(true);
  });

  it('契约 6: kujira-session 预设配置必须完整包含 agent-instructions、skill-filesystem、tool-skill 与 kujira-tools 插件定义', async () => {
    const presetsSvc: any = (booted.ctx as any).agentPresets || (booted.ctx as any).get?.('agentPresets');
    const qqDef = presetsSvc.definitions?.get?.(QQ_PRESET_ID);
    expect(qqDef).toBeDefined();

    const plugins = qqDef.config.plugins;
    const pluginIds = plugins.map((p: any) => p.id);
    expect(pluginIds).toContain('agent-instructions');
    expect(pluginIds).toContain('skill-filesystem');
    expect(pluginIds).toContain('tool-skill');
    expect(pluginIds).toContain('tool-ask-user');
    expect(pluginIds).toContain('kujira-tools');

    const toolsPlugin = plugins.find((p: any) => p.id === 'kujira-tools');
    expect(toolsPlugin?.name).toBe('kujira/tools');

    const instructionsPlugin = plugins.find((p: any) => p.id === 'agent-instructions');
    expect(instructionsPlugin.config?.maxBytes).toBe(65536);
  });

  it('契约 7: 动态挂载/注册 kujira-session 预设时，必须向 Cordis 上下文广播 settings/document-updated(agent-preset-registry) 事件，确保 DSH 前端 UI 免重启即时刷新', async () => {
    const freshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-preset-refresh-'));
    const freshBoot = await bootDshKujira({
      dshHome: freshHome,
      mountPlugin: false,
      extraPatches: [
        {
          id: 'agent-preset-registry',
          config: { default: QQ_PRESET_ID },
        },
      ],
    });

    try {
      let eventFired = false;
      freshBoot.ctx.on('settings/document-updated', (ns: string) => {
        if (ns === 'agent-preset-registry') {
          eventFired = true;
        }
      });

      await freshBoot.ctx.plugin(KujiraPlugin, {
        face_enabled: false,
        slang_enabled: false,
      });

      // 等待异步 inject 与事件循环
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(eventFired).toBe(true);
    } finally {
      await freshBoot.dispose().catch(() => {});
      await fsp.rm(freshHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
