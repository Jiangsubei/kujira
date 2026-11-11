/**
 * tests/contract/memory-storage.test.ts
 *
 * 契约测试: Kujira MemoryStorage 单聊双层记忆强隔离存储层
 *
 * 覆盖场景:
 * 1. 目录结构 (.dsh/kujira/memory/session/ 与 user/) 及原子写入，使用 encodeSegment 免疫特殊字符与路径穿越冲突
 * 2. Session 记忆 (per-peer) 读写、CAS 原子更新与缓存
 * 3. User Profile (per-peer) 读写与缓存，彻底移除 default.md 跨会话兜底，各单聊强隔离
 * 4. 单聊 Snapshot 组装（Session 规则与 User Profile 全量注入；无 # 标题时渲染为 ### 用户画像，绝不重复两遍 openid/peer）
 * 5. kujira-user-<hash16>（含 -r<round>-<version>[-<hash>]）与 user_<hash16> 归一化一致性及空键防御
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStorage } from '../../src/memory/storage.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';
import { encodeSegment } from '../../src/utils/path.js';

describe('契约测试: Kujira MemoryStorage 单聊双层记忆强隔离存储层', () => {
  let tmpDir: string;
  let storage: MemoryStorage;
  const peerA = openidToPeer('MOCK_OPENID_USER_ALPHA_001');
  const peerB = openidToPeer('MOCK_OPENID_USER_BETA_002');
  const sessionBaseA = openidToSessionBaseId('MOCK_OPENID_USER_ALPHA_001');

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-memory-test-'));
    storage = new MemoryStorage(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: 目录结构初始化、encodeSegment 无损转义与原子写入 (atomicWriteFile)', async () => {
    await storage.writeSessionMemory(peerA, '# 会话约定\n- 主要讨论 TypeScript');
    await storage.writeUserProfile(peerA, '# 用户画像\n- 喜欢详细解释');

    const sessionFile = path.join(tmpDir, 'session', `${encodeSegment(peerA)}.md`);
    const userFile = path.join(tmpDir, 'user', `${encodeSegment(peerA)}.md`);

    expect(await fsp.readFile(sessionFile, 'utf-8')).toContain('主要讨论 TypeScript');
    expect(await fsp.readFile(userFile, 'utf-8')).toContain('喜欢详细解释');

    // 验证 encodeSegment 保留特殊字符区分度，不再因有损替换发生冲突
    await storage.writeSessionMemory('user_special:a', '冒号版本');
    await storage.writeSessionMemory('user_special/a', '斜杠版本');
    expect(storage.getSessionMemoryPath('user_special:a')).not.toBe(
      storage.getSessionMemoryPath('user_special/a')
    );
    expect(await storage.readSessionMemory('user_special:a')).toBe('冒号版本');
    expect(await storage.readSessionMemory('user_special/a')).toBe('斜杠版本');

    // 路径穿越保护: '..' 与 '.' 被 encodeSegment 安全转义在根目录内
    const dotPath = storage.getUserProfilePath('..');
    expect(dotPath).toBe(path.join(tmpDir, 'user', '~002E~002E.md'));
  });

  it('契约 2: Session 记忆读写、CAS 原子更新与缓存', async () => {
    // 1. 读取不存在的 session 记忆返回空字符串
    expect(await storage.readSessionMemory(peerA)).toBe('');
    expect(await storage.existsSessionMemory(peerA)).toBe(false);

    // 2. 写入与读取
    await storage.writeSessionMemory(peerA, '约定：回答尽量简短');
    expect(await storage.readSessionMemory(peerA)).toBe('约定：回答尽量简短');
    expect(await storage.existsSessionMemory(peerA)).toBe(true);
    expect(await storage.readSessionMemoryRaw(peerA)).toBe('约定：回答尽量简短');

    // 3. 并发 CAS 更新顺序一致且不丢失
    const [res1, res2] = await Promise.all([
      storage.updateSessionMemory(peerA, (cur) => `${cur}\n- 条目一`),
      storage.updateSessionMemory(peerA, (cur) => `${cur}\n- 条目二`),
    ]);
    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    const finalContent = await storage.readSessionMemory(peerA);
    expect(finalContent).toContain('- 条目一');
    expect(finalContent).toContain('- 条目二');
  });

  it('契约 3: User Profile 单聊强隔离，彻底移除 default.md 跨会话兜底', async () => {
    // 1. 写入 peerB 画像以及历史遗留名 default.md
    await storage.writeUserProfile('default', '通用画像：不应被其他会话读取');
    await storage.writeUserProfile(peerB, '用户 B 的隐私画像');

    // 2. 未建立画像的 peerA 一律返回空字符串，绝不回退到 default.md，也绝不串到 peerB
    expect(await storage.readUserProfile(peerA)).toBe('');
    expect(await storage.readUserProfileRaw(peerA)).toBe('');
    expect(storage.readUserProfileSync(peerA)).toBe('');
    expect(storage.getUserProfilesSnapshotSync(peerA)).toBe('');
    expect(await storage.existsUserProfile(peerA)).toBe(false);

    // 3. 写入 peerA 专属画像后仅影响 peerA
    await storage.writeUserProfile(peerA, '资深 Rust 工程师');
    expect(await storage.readUserProfile(peerA)).toBe('资深 Rust 工程师');
    expect(await storage.readUserProfileRaw(peerA)).toBe('资深 Rust 工程师');
    expect(await storage.existsUserProfile(peerA)).toBe(true);
    expect(await storage.readUserProfile(peerB)).toBe('用户 B 的隐私画像');

    // 4. CAS 原子更新 User Profile
    const editRes = await storage.updateUserProfile(peerA, (cur) => `${cur}\n- 偏好使用 pnpm`);
    expect(editRes.success).toBe(true);
    expect(await storage.readUserProfile(peerA)).toBe('资深 Rust 工程师\n- 偏好使用 pnpm');
  });

  it('契约 4: 单聊双层快照组装 — 全量注入且无 # 标题时渲染为 ### 用户画像，绝不重复 peer/openid', () => {
    storage.writeSessionMemorySync(peerA, '# 会话规则\n\n私聊约定：每周五汇报周报');
    storage.writeUserProfileSync(peerA, '偏好简洁的 Markdown 表格输出');

    const snapshot = storage.getPromptSnapshotSync(peerA);

    // Session 规则自带 # 标题时不套外层 ### Session 记忆
    expect(snapshot).not.toContain('### Session 记忆');
    expect(snapshot).toContain('# 会话规则\n\n私聊约定：每周五汇报周报');

    // User Profile 不以 # 开头时补 ### 用户画像，不重复两遍 peer/openid
    expect(snapshot).toContain('### 用户画像\n偏好简洁的 Markdown 表格输出');
    expect(snapshot).not.toContain(`${peerA} (${peerA})`);
    expect(snapshot).not.toContain('受字符预算限制');

    // 无 # 标题的 Session 记忆补充 ### Session 记忆（peer）
    storage.writeSessionMemorySync(peerB, '周末不发提醒');
    storage.writeUserProfileSync(peerB, '# 个人档案\n\n- 习惯晚间沟通');
    const snapshotB = storage.getPromptSnapshotSync(peerB);
    expect(snapshotB).toContain(`### Session 记忆（${peerB}）\n周末不发提醒`);
    expect(snapshotB).toContain('# 个人档案\n\n- 习惯晚间沟通');
    expect(snapshotB).not.toContain('### 用户画像');

    // 超长单聊画像全量注入，不被群聊预算截断
    const longProfile = '长画像内容'.repeat(600);
    storage.writeUserProfileSync(peerA, longProfile);
    expect(storage.getUserProfilesSnapshotSync(peerA)).toContain(longProfile);
  });

  it('契约 5: kujira-user-<hash16>（含归档后缀）与 user_<hash16> 归一化一致性及空键防御', async () => {
    const archivedSessionId = `${sessionBaseA}-r2-3-a1b2c3`;
    await storage.writeSessionMemory(archivedSessionId, '来自归档轮次的会话规则');
    await storage.writeUserProfile(`${sessionBaseA}-1`, '通过 sessionId 写入的用户画像');

    // 与规范 peer 完全互通同一文件
    expect(storage.getSessionMemoryPath(archivedSessionId)).toBe(storage.getSessionMemoryPath(peerA));
    expect(storage.getUserProfilePath(`${sessionBaseA}-1`)).toBe(storage.getUserProfilePath(peerA));
    expect(await storage.readSessionMemory(peerA)).toBe('来自归档轮次的会话规则');
    expect(await storage.readUserProfile(peerA)).toBe('通过 sessionId 写入的用户画像');

    // 空键安全防御：读返回空/false，写明确抛错不创建垃圾文件
    expect(await storage.readSessionMemory('')).toBe('');
    expect(await storage.readUserProfile('   ')).toBe('');
    expect(await storage.existsSessionMemory('')).toBe(false);
    expect(await storage.existsUserProfile('')).toBe(false);
    expect(storage.getPromptSnapshotSync('')).toBe('');
    await expect(storage.writeSessionMemory('', 'invalid')).rejects.toThrow('cannot be empty');
    await expect(storage.writeUserProfile('', 'invalid')).rejects.toThrow('cannot be empty');
  });
});
