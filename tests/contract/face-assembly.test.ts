/**
 * tests/contract/face-assembly.test.ts
 * 契约测试: 表情包模块真实装配闭环 (Real Assembly via bootDshKujira)
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import * as KujiraPlugin from '../../src/index.js';
import * as KujiraToolsPlugin from '../../src/tools/plugin.js';
import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_FACE_STORE_DIR,
} from '../../src/constants/index.js';
import { resolveDshPath } from '../../src/utils/path.js';
import {
  computeOpenidHash16,
  openidToPeer,
  openidToSessionBaseId,
} from '../../src/utils/peer.js';
import { MessageDatabase } from '../../src/storage/database.js';

const MOCK_OPENID = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_HASH = computeOpenidHash16(MOCK_OPENID);
const MOCK_PEER = openidToPeer(MOCK_OPENID);
const MOCK_SESSION_ID = openidToSessionBaseId(MOCK_OPENID);

const FACE_TOOL_NAMES = ['list_faces', 'send_face', 'collect_face', 'manage_faces'] as const;

function expectLosslessJson(value: unknown, trail = 'root'): void {
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => expectLosslessJson(item, `${trail}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      expect(v, `${trail}.${k} must not be undefined`).not.toBeUndefined();
      expectLosslessJson(v, `${trail}.${k}`);
    }
  }
}

async function waitForPreset(ctx: any, presetId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const presetsSvc = ctx.get?.('agentPresets') || ctx.agentPresets;
  while (Date.now() < deadline) {
    const list = await presetsSvc?.list?.();
    if (Array.isArray(list) && list.some((p: any) => p.id === presetId)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`预设 ${presetId} 注册超时`);
}

describe('契约测试: 表情包系统真实装配闭环 (Face Assembly Contract)', () => {
  let booted: BootedDsh | null = null;
  let tmpHome: string | null = null;

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = null;
    }
    if (tmpHome && fs.existsSync(tmpHome)) {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {}
      tmpHome = null;
    }
  });

  it('装配 1: 默认状态 (face_enabled=false) 真实装配下绝不暴露 4 个表情工具，kujira:face_summary 保持静默', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-face-off-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
    });

    const provider = (booted.ctx.get('kujiraBridgeTools') || (booted.ctx as any).kujiraBridgeTools) as any;
    expect(provider).toBeDefined();

    // 挂载 kujira-tools 插件（即使配置默认 face_enabled=false，常规单聊工具应注册，4 个表情工具绝不挂载）
    await booted.ctx.plugin(KujiraToolsPlugin);

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(toolsService).toBeDefined();
    expect(toolsService.get('send_qq_message')).toBeDefined();

    for (const name of FACE_TOOL_NAMES) {
      expect(toolsService.get(name)).toBeUndefined();
    }

    const snapshotManager = (booted.ctx as any).snapshotManager;
    expect(snapshotManager).toBeDefined();
    const faceProvider = snapshotManager.getProvider('kujira:face_summary');
    expect(faceProvider).toBeDefined();
    expect(
      faceProvider.provide(
        { peer: MOCK_PEER, userId: MOCK_HASH },
        { agent: { session: { id: MOCK_SESSION_ID } } }
      )
    ).toBe('');
  });

  it('装配 2: 开启总开关 (face_enabled=true) 真实装配下完整挂载 4 个表情工具并可执行与遵循 Lossless JSON', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-face-on-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        face_enabled: true,
        face_store_max: 50,
      },
    });

    const provider = (booted.ctx.get('kujiraBridgeTools') || (booted.ctx as any).kujiraBridgeTools) as any;
    expect(provider).toBeDefined();
    await booted.ctx.plugin(KujiraToolsPlugin);

    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    expect(toolsService).toBeDefined();

    const listFacesTool = toolsService.get('list_faces');
    const sendFaceTool = toolsService.get('send_face');
    const collectFaceTool = toolsService.get('collect_face');
    const manageFacesTool = toolsService.get('manage_faces');

    expect(listFacesTool).toBeDefined();
    expect(sendFaceTool).toBeDefined();
    expect(collectFaceTool).toBeDefined();
    expect(manageFacesTool).toBeDefined();

    const res = await listFacesTool.execute({}, { agent: { session: { id: MOCK_SESSION_ID } } });
    expectLosslessJson(res);
    expect(res.faces).toEqual([]);
    expect(res.total).toBe(0);

    // 验证插入未打标表情后执行 list_faces 与 manage_faces 返回严格满足 Lossless JSON
    const dbPath = resolveDshPath(tmpHome, undefined, DEFAULT_DATABASE_PATH);
    const db = new MessageDatabase(dbPath);
    db.init();
    db.insertFace({
      id: 'face_test_lossless',
      file_path: path.join(resolveDshPath(tmpHome, undefined, DEFAULT_FACE_STORE_DIR), 'lossless.png'),
      md5: 'md5_lossless_test',
      source: 'manual',
      tags: [],
      size: 100,
      format: 'png',
    });
    db.close();

    const res2 = await listFacesTool.execute({}, { agent: { session: { id: MOCK_SESSION_ID } } });
    expectLosslessJson(res2);
    expect(res2.faces).toHaveLength(1);
    expect(res2.faces[0].id).toBe('face_test_lossless');
    expect(Object.hasOwn(res2.faces[0], 'mood')).toBe(false);
    expect(Object.hasOwn(res2, 'next_cursor')).toBe(false);

    const quotaRes = await manageFacesTool.execute(
      { action: 'query_quota' },
      { agent: { session: { id: MOCK_SESSION_ID } } }
    );
    expectLosslessJson(quotaRes);
    expect(quotaRes.success).toBe(true);
    expect(quotaRes.total).toBe(1);
    expect(quotaRes.max_quota).toBe(50);
    expect(quotaRes.available).toBe(49);
  });

  it('装配 3: 表情工具仅限 Kujira 单聊会话呈现与执行 — WebUI 隔离剔除，kujira-user-<hash16> 挂载 kujira-session 放行', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-face-guard-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });

    await booted.ctx.plugin(KujiraPlugin, {
      face_enabled: true,
    });
    await waitForPreset(booted.ctx, 'kujira-session');

    const faceNameSet = new Set<string>(FACE_TOOL_NAMES);
    const webWs = path.join(tmpHome, 'web-ws');
    const qqWs = path.join(tmpHome, 'kujira-ws');
    fs.mkdirSync(webWs, { recursive: true });
    fs.mkdirSync(qqWs, { recursive: true });

    // 1. Web 会话 Agent: assemble 中不包含表情工具，调用被 DSH 拦截拒绝
    const webHandle = await booted.ctx.agents.create({
      sessionId: 'web-session-face',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: webWs },
    });
    const webAgent = webHandle.agent || webHandle;
    const asmWeb = await booted.ctx.systemPrompt.assemble({ scope: webAgent, agent: webAgent } as any);
    const webFaces = (asmWeb.tools as any[]).filter((t) => faceNameSet.has(t.name));
    expect(webFaces).toHaveLength(0);

    const tools: any = booted.ctx.get('tools');
    const denied = await tools.execute({
      calls: [{ type: 'tool-call', id: 'call-face-web-denied', name: 'list_faces', arguments: '{}' }],
      agent: webAgent,
      signal: new AbortController().signal,
    });
    expect(denied.results[0]?.result.isError).toBe(true);

    // 2. Kujira 单聊会话 Agent: 挂载 kujira-session 预设 (含 kujira/tools)，assemble 包含全量 4 个表情工具，调用放行
    const qqHandle = await booted.ctx.agents.create({
      sessionId: MOCK_SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await (booted!.ctx as any).agentPresets.mount(agentCtx, 'kujira-session');
      },
    });
    const qqAgent = qqHandle.agent || qqHandle;
    const asmQq = await booted.ctx.systemPrompt.assemble({ scope: qqAgent, agent: qqAgent } as any);
    const qqFaces = (asmQq.tools as any[]).filter((t) => faceNameSet.has(t.name));
    expect(qqFaces.map((t) => t.name).sort()).toEqual([...FACE_TOOL_NAMES].sort());

    const allowed = await tools.execute({
      calls: [{ type: 'tool-call', id: 'call-face-qq-allowed', name: 'list_faces', arguments: '{}' }],
      agent: qqAgent,
      signal: new AbortController().signal,
    });
    expect(allowed.results[0]?.result.isError).toBe(false);
  });

  it('装配 4: collect_face 默认落盘目录为 .dsh/kujira/faces（规范绝对路径），绝不受 cwd 漂移影响', async () => {
    expect(DEFAULT_FACE_STORE_DIR).toBe('.dsh/kujira/faces');

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-face-path-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        face_enabled: true,
      },
    });

    await booted.ctx.plugin(KujiraToolsPlugin);
    const toolsService = (booted.ctx.get('tools') || (booted.ctx as any).tools) as any;
    const collectFaceTool = toolsService.get('collect_face');

    const dbPath = resolveDshPath(tmpHome, undefined, DEFAULT_DATABASE_PATH);
    const db = new MessageDatabase(dbPath);
    db.init();

    const sampleImgPath = path.join(tmpHome, 'sample_meme.png');
    fs.writeFileSync(sampleImgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]));

    db.saveMessage({
      msg_id: 'ROBOT1.0_IN_FACE_1',
      peer: MOCK_PEER,
      user_id: MOCK_OPENID,
      sender_name: 'TestUser',
      time: Date.now(),
      type: 'image',
      content: '[图片]',
      local_path: sampleImgPath,
      raw: '{}',
    });

    const savedMsg = db.getMessage('ROBOT1.0_IN_FACE_1');
    expect(savedMsg?.short_id).toBe('msg_1');

    // 传入原始长 ID 必须被校验拦截（不做长 ID 兼容）
    const rejectedRes = await collectFaceTool.execute(
      {
        message_id: 'ROBOT1.0_IN_FACE_1',
        tags: ['测试猫猫'],
        mood: '搞笑',
      },
      {
        agent: { session: { id: MOCK_SESSION_ID } },
      }
    );
    expectLosslessJson(rejectedRes);
    expect(rejectedRes.success).toBe(false);
    expect(rejectedRes.error).toContain('无效的 message_id');

    // 传入短 ID ('msg_1') 正常收藏落盘至 .dsh/kujira/faces
    const res = await collectFaceTool.execute(
      {
        message_id: savedMsg!.short_id!,
        tags: ['测试猫猫'],
        mood: '搞笑',
      },
      {
        agent: { session: { id: MOCK_SESSION_ID } },
      }
    );

    expectLosslessJson(res);
    expect(res.success).toBe(true);
    expect(res.face_id).toBeDefined();

    // 不传 message_id 时自动读取当前会话最近媒体消息并命中去重
    const autoRes = await collectFaceTool.execute(
      {
        tags: ['测试猫猫'],
        mood: '搞笑',
      },
      {
        agent: { session: { id: MOCK_SESSION_ID } },
      }
    );
    expectLosslessJson(autoRes);
    expect(autoRes.success).toBe(true);
    expect(autoRes.duplicated).toBe(true);
    expect(autoRes.face_id).toBe(res.face_id);

    const faceRecord = db.getFaceById(res.face_id);
    expect(faceRecord).toBeDefined();
    expect(path.isAbsolute(faceRecord!.file_path)).toBe(true);
    const expectedDir = resolveDshPath(tmpHome, undefined, DEFAULT_FACE_STORE_DIR);
    expect(expectedDir).toBe(path.resolve(tmpHome, 'kujira', 'faces'));
    expect(faceRecord!.file_path.startsWith(expectedDir)).toBe(true);
    expect(fs.existsSync(faceRecord!.file_path)).toBe(true);
    db.close();
  });

  it('装配 5: 真实装配下 kujira:face_summary 严格遵循 face_store_max 配置且对非 Kujira 会话 Fail-Closed', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kujira-face-quota-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: true,
      config: {
        face_enabled: true,
        face_store_max: 3,
      },
    });
    await waitForPreset(booted.ctx, 'kujira-session');

    const dbPath = resolveDshPath(tmpHome, undefined, DEFAULT_DATABASE_PATH);
    const faceDir = resolveDshPath(tmpHome, undefined, DEFAULT_FACE_STORE_DIR);
    const db = new MessageDatabase(dbPath);
    db.init();

    for (let i = 1; i <= 5; i++) {
      db.insertFace({
        id: `face_quota_${i}`,
        file_path: path.join(faceDir, `quota_${i}.png`),
        md5: `md5_quota_${i}`,
        source: 'manual',
        tags: [`配额${i}`],
        mood: '测试',
        size: 100,
        format: 'png',
      });
    }
    db.close();

    const qqWs = path.join(tmpHome, 'kujira-ws');
    fs.mkdirSync(qqWs, { recursive: true });
    const qqHandle = await booted.ctx.agents.create({
      sessionId: MOCK_SESSION_ID,
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      meta: { cwd: qqWs },
      setup: async (agentCtx: any) => {
        await (booted!.ctx as any).agentPresets.mount(agentCtx, 'kujira-session');
      },
    });
    const qqAgent = qqHandle.agent || qqHandle;

    const snapshotManager = (booted.ctx as any).snapshotManager;
    expect(snapshotManager).toBeDefined();
    const faceProvider = snapshotManager.getProvider('kujira:face_summary');
    expect(faceProvider).toBeDefined();
    expect(faceProvider.order).toBe(48);

    const faceText = faceProvider.provide(
      { peer: MOCK_PEER, userId: MOCK_HASH },
      { scope: qqAgent, agent: qqAgent }
    );
    expect(faceText).toContain('当前本地库共 5 张可用表情包（当前已列出前 3 张');
    expect(faceText).toContain('face_quota_5');
    expect(faceText).toContain('face_quota_4');
    expect(faceText).toContain('face_quota_3');
    expect(faceText).not.toContain('face_quota_1');

    // Web 会话下 Fail-Closed 绝不返回或注入表情库摘要
    expect(faceProvider.text({ agent: { session: { id: 'web-session-face' } } })).toBe('');
    const webPre = await snapshotManager.handlePreStep({
      agent: { session: { id: 'web-session-face' } },
      messages: [],
    });
    expect(webPre.messages).toHaveLength(0);
  });
});
