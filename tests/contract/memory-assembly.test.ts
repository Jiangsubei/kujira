/**
 * tests/contract/memory-assembly.test.ts
 *
 * 契约测试: EN-003 Memory 单聊双层记忆体系真实装配与动态 Prompt 注入闭环
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { setupMemoryService } from '../../src/memory/index.js';
import { MessageDatabase } from '../../src/storage/database.js';
import { setupSnapshotHub } from '../../src/prompt/snapshot.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID_1 = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_OPENID_2 = 'B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6A1';
const MOCK_PEER_1 = openidToPeer(MOCK_OPENID_1);
const MOCK_PEER_2 = openidToPeer(MOCK_OPENID_2);
const MOCK_SESSION_1 = openidToSessionBaseId(MOCK_OPENID_1);
const MOCK_SESSION_2 = openidToSessionBaseId(MOCK_OPENID_2);

describe('契约测试: EN-003 Memory 单聊双层记忆体系真实装配与 Prompt 注入', () => {
  let tmpDir: string;
  let booted: BootedDsh;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-kujira-mem-assembly-'));
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: setupMemoryService 正确装配 tools 与单聊双层快照生成', async () => {
    booted = await bootDshKujira({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {},
    });

    const ctx = booted.ctx;
    const memDir = path.join(tmpDir, 'memory');
    const memoryService = setupMemoryService(ctx, {
      storageDir: memDir,
      dshHome: tmpDir,
      userProfileBudgetChars: 2200,
      sessionMemoryBudgetChars: 2200,
    });

    // 1. 验证 3 个 Memory 工具注册在 tools 运行时
    const toolsService = ctx.get('tools') || (ctx as any).tools;
    expect(toolsService.get('read_memory')).toBeDefined();
    expect(toolsService.get('create_memory')).toBeDefined();
    expect(toolsService.get('edit_memory')).toBeDefined();

    // 2. 写入单聊双层记忆
    await memoryService.storage.writeSessionMemory(MOCK_PEER_1, '单聊约定：技术交流');
    await memoryService.storage.writeUserProfile(MOCK_PEER_1, '项目架构师');

    // 3. 验证 Session 规则与用户画像独立动态快照生成
    const rulesText = memoryService.storage.getSessionRulesSnapshotSync(MOCK_PEER_1);
    expect(rulesText).toContain(`### Session 记忆（${MOCK_PEER_1}）`);
    expect(rulesText).toContain('单聊约定：技术交流');

    const profileText = memoryService.storage.getUserProfilesSnapshotSync(MOCK_PEER_1);
    expect(profileText).toContain('### 用户画像\n项目架构师');

    memoryService.dispose();
  });

  it('契约 2: Agent 工具调用写入后，下一轮单聊双层快照动态重算立即生效且跨会话强隔离', async () => {
    booted = await bootDshKujira({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {},
    });

    const ctx = booted.ctx;
    const memDir = path.join(tmpDir, 'memory2');
    const memoryService = setupMemoryService(ctx, {
      storageDir: memDir,
      dshHome: tmpDir,
      userProfileBudgetChars: 2200,
      sessionMemoryBudgetChars: 2200,
    });

    const toolsService = ctx.get('tools') || (ctx as any).tools;
    const createTool = toolsService.get('create_memory');

    // 第一轮：初始无记忆
    expect(memoryService.storage.getSessionRulesSnapshotSync(MOCK_PEER_1)).toBe('');
    expect(memoryService.storage.getUserProfilesSnapshotSync(MOCK_PEER_1)).toBe('');

    // 模拟 Agent 在第 1 轮中通过 create_memory 写入当前单聊的会话规则与用户画像
    await createTool.execute(
      { type: 'session', content: '私聊约定：只发代码不废话' },
      { agent: { session: { id: `${MOCK_SESSION_1}-1` } } }
    );
    await createTool.execute(
      { type: 'user', content: '偏好：喜欢直接给结论' },
      { agent: { session: { id: `${MOCK_SESSION_1}-1` } } }
    );

    // 第二轮：当前单聊动态重算立即包含新记忆
    const rules2 = memoryService.storage.getSessionRulesSnapshotSync(MOCK_PEER_1);
    expect(rules2).toContain(`### Session 记忆（${MOCK_PEER_1}）`);
    expect(rules2).toContain('私聊约定：只发代码不废话');

    const profile2 = memoryService.storage.getUserProfilesSnapshotSync(MOCK_PEER_1);
    expect(profile2).toContain('### 用户画像\n偏好：喜欢直接给结论');

    // 跨会话强隔离：另一单聊 peer 读取为空
    expect(memoryService.storage.getSessionRulesSnapshotSync(MOCK_PEER_2)).toBe('');
    expect(memoryService.storage.getUserProfilesSnapshotSync(MOCK_PEER_2)).toBe('');

    // 非法 / default 上下文必须被 Fail-Closed 拦截
    const invalidRes = await createTool.execute(
      { type: 'session', content: '非法跨界写入' },
      { agent: { session: { id: 'default' } } }
    );
    expect(invalidRes.success).toBe(false);

    memoryService.dispose();
  });

  it('契约 5: SnapshotHub 单聊双层记忆通道 (kujira:session_rules / kujira:user_profiles) 按当前 peer 注入且无 default.md 兜底', async () => {
    booted = await bootDshKujira({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {},
    });

    const ctx = booted.ctx;
    const db = new MessageDatabase(path.join(tmpDir, 'test-msg-hub.db'));
    db.init();

    const memDir = path.join(tmpDir, 'memory-hub');
    const memoryService = setupMemoryService(ctx, {
      storageDir: memDir,
      dshHome: tmpDir,
      registerGlobalTools: false,
      registerPromptContext: false,
    });

    // 即使磁盘上人为写入了 default.md，也绝不允许跨会话兜底读取
    const sessionDir = path.join(memDir, 'session');
    const userDir = path.join(memDir, 'user');
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.mkdir(userDir, { recursive: true });
    await fsp.writeFile(path.join(sessionDir, 'default.md'), '严禁泄露的 default 会话规则', 'utf-8');
    await fsp.writeFile(path.join(userDir, 'default.md'), '严禁泄露的 default 用户画像', 'utf-8');

    // 为 peer1 与 peer2 分别写入独立记忆
    await memoryService.storage.writeSessionMemory(MOCK_PEER_1, '用户1专属会话约定');
    await memoryService.storage.writeUserProfile(MOCK_PEER_1, '用户1专属画像特征');
    await memoryService.storage.writeSessionMemory(MOCK_PEER_2, '用户2专属会话约定');
    await memoryService.storage.writeUserProfile(MOCK_PEER_2, '用户2专属画像特征');

    const snapshotManager = setupSnapshotHub({
      ctx,
      db,
      memoryStorage: memoryService.storage,
    });

    expect(snapshotManager.getProvider('kujira:session_rules')).toBeDefined();
    expect(snapshotManager.getProvider('kujira:user_profiles')).toBeDefined();

    // 1. 会话 1 仅注入 peer1 的双层记忆，绝不混入 peer2 或 default.md
    const res1 = await snapshotManager.handlePreStep({
      agent: { session: { id: MOCK_SESSION_1 } },
    });
    const texts1 = (res1?.messages || []).map((m: any) => m.content?.[0]?.text || '').join('\n');
    expect(texts1).toContain('用户1专属会话约定');
    expect(texts1).toContain('用户1专属画像特征');
    expect(texts1).not.toContain('用户2专属');
    expect(texts1).not.toContain('严禁泄露的 default');

    // 2. 会话 2 仅注入 peer2 的双层记忆
    const res2 = await snapshotManager.handlePreStep({
      agent: { session: { id: MOCK_SESSION_2 } },
    });
    const texts2 = (res2?.messages || []).map((m: any) => m.content?.[0]?.text || '').join('\n');
    expect(texts2).toContain('用户2专属会话约定');
    expect(texts2).toContain('用户2专属画像特征');
    expect(texts2).not.toContain('用户1专属');
    expect(texts2).not.toContain('严禁泄露的 default');

    // 3. Fail-Closed：Web / 沙箱 / default 会话不注入任何记忆通道
    for (const nonKujiraSid of ['web-1', 'review-1', 'default']) {
      const nonRes = await snapshotManager.handlePreStep({
        agent: { session: { id: nonKujiraSid } },
      });
      expect(nonRes?.messages || []).toHaveLength(0);
    }

    snapshotManager.dispose();
    memoryService.dispose();
    db.close();
  });

  it('契约 6: 主 Agent System Prompt 行为准则段包含记忆工具被动调用指引 (与 Background Review 职责分离)', async () => {
    booted = await bootDshKujira({
      dshHome: tmpDir,
      mountPlugin: false,
      config: {},
    });

    const ctx = booted.ctx;
    const { registerKujiraDynamicPrompt } = await import('../../src/prompt/dynamic.js');
    const disposePrompt = registerKujiraDynamicPrompt(
      ctx,
      () => '测试人格',
      () => '重要约束：测试行为'
    );

    const snapshotManager = (ctx as any).snapshotManager;
    expect(snapshotManager).toBeDefined();

    const preStepResult = await snapshotManager.handlePreStep({
      agent: { session: { id: MOCK_SESSION_1 } },
    });
    const injectedTexts = (preStepResult?.messages || [])
      .map((m: any) => m.content?.[0]?.text || '')
      .join('\n');

    expect(injectedTexts).toContain('重要约束：测试行为');
    expect(injectedTexts).toContain('记忆工具规则');
    expect(injectedTexts).toContain('不必每轮都调用记忆工具');
    expect(injectedTexts).toContain('create_memory');

    disposePrompt();
    snapshotManager.dispose();
  });
});
