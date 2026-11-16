/**
 * tests/contract/session-title-name.test.ts
 *
 * 契约测试: DSH 原生 AI 会话标题放行、回退格式与 `/会话` / `/状态` 指令展示对齐
 *
 * 覆盖规范:
 * 1. 纯函数 `formatSessionVersionTag` 与 `formatFallbackSessionTitle` 格式化契约（`#1`、`#2 (1)`、`新会话 #1`），
 *    确认旧 `formatSessionTitle` / `extractNameFromSessionTitle` 已移除；
 * 2. 真实装配下 `getOrCreateAgent` 与 `dispatchWakeup` 绝不调用 `sessionTitle.rename`，放行 DSH 原生 AI 总结；
 * 3. `getSessionTitle` / `getSessionDisplayName` 只读读取 `sessionTitle` 与 `sessions` 标题（无则返回 undefined）；
 * 4. `/会话` 与 `/状态` 真实展示原生 AI 会话标题与轮次标签，并支持按 AI 标题关键字切换会话。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { bootDshKujira, type BootedDsh } from '../../src/boot.js';
import { handleSlashCommand } from '../../src/commands/index.js';
import * as sessionModule from '../../src/gateway/session.js';
import {
  SessionManager,
  formatFallbackSessionTitle,
  formatSessionVersionTag,
} from '../../src/gateway/session.js';
import { openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

const MOCK_OPENID_1 = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const MOCK_PEER_1 = openidToPeer(MOCK_OPENID_1);
const MOCK_SID_1 = openidToSessionBaseId(MOCK_OPENID_1);

const MOCK_OPENID_2 = 'B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6A1';
const MOCK_PEER_2 = openidToPeer(MOCK_OPENID_2);
const MOCK_SID_2 = openidToSessionBaseId(MOCK_OPENID_2);

const MOCK_OPENID_3 = 'C3D4E5F6A7B8C9D0E1F2A3B4C5D6A1B2';
const MOCK_PEER_3 = openidToPeer(MOCK_OPENID_3);
const MOCK_SID_3 = openidToSessionBaseId(MOCK_OPENID_3);

describe('契约测试: 原生 AI 会话标题与 /会话 /状态 展示对齐', () => {
  let tmpHome: string;
  let booted: BootedDsh | undefined;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-title-'));
    booted = await bootDshKujira({
      dshHome: tmpHome,
      mountPlugin: false,
    });
  });

  afterEach(async () => {
    if (booted) {
      await booted.dispose().catch(() => {});
      booted = undefined;
    }
    if (tmpHome) {
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('契约 1: formatSessionVersionTag 与 formatFallbackSessionTitle 格式准确，遗留私聊锁标题导出已移除', () => {
    expect((sessionModule as any).formatSessionTitle).toBeUndefined();
    expect((sessionModule as any).extractNameFromSessionTitle).toBeUndefined();

    expect(formatSessionVersionTag(MOCK_SID_1)).toBe('#1');
    expect(formatSessionVersionTag(`${MOCK_SID_1}-3`)).toBe('#3');
    expect(formatSessionVersionTag(`${MOCK_SID_1}-r1-1`)).toBe('#1 (1)');
    expect(formatSessionVersionTag(`${MOCK_SID_1}-r1-2`)).toBe('#2 (1)');
    expect(formatSessionVersionTag(`${MOCK_SID_1}-r2-1`)).toBe('#1 (2)');

    expect(formatFallbackSessionTitle(MOCK_SID_1)).toBe('新会话 #1');
    expect(formatFallbackSessionTitle(`${MOCK_SID_1}-3`)).toBe('新会话 #3');
    expect(formatFallbackSessionTitle(`${MOCK_SID_1}-r1-2`)).toBe('新会话 #2 (1)');
  });

  it('契约 2: 真实装配下创建与唤醒会话绝不调用 sessionTitle.rename，只读读取 DSH 原生标题', async () => {
    const ctx: any = booted!.ctx;
    const titleSvc: any = ctx.get('sessionTitle') || ctx.sessionTitle;
    expect(titleSvc).toBeDefined();

    const renameSpy = vi.spyOn(titleSvc, 'rename');
    const sessionManager = new SessionManager(ctx, tmpHome);

    try {
      const agent = await sessionManager.getOrCreateAgent(MOCK_PEER_1);
      expect(agent.session.id).toBe(MOCK_SID_1);
      expect(renameSpy).not.toHaveBeenCalled();

      // 尚无 AI 总结标题时，返回 undefined（不伪造 "私聊: <hash>"）
      expect(sessionManager.getSessionTitle(MOCK_SID_1)).toBeUndefined();
      expect(sessionManager.getSessionDisplayName(MOCK_SID_1)).toBeUndefined();

      // 真实入站唤醒也绝不强制 rename 标题
      await sessionManager.dispatchWakeup({
        peer: MOCK_PEER_1,
        trigger: 'direct',
        from_user: MOCK_OPENID_1,
        from_name: '测试用户',
        content: '帮我写一份架构总结',
        timestamp: Date.now(),
      });
      expect(renameSpy).not.toHaveBeenCalled();

      // 当 DSH session/title 产生原生标题后，getSessionTitle / getSessionDisplayName 立即读出
      agent.session.append('session/title', {
        title: 'QQ 单聊架构总结',
        messageSeqs: [],
        source: { kind: 'fallback' },
      });

      expect(sessionManager.getSessionTitle(MOCK_SID_1)).toBe('QQ 单聊架构总结');
      expect(sessionManager.getSessionDisplayName(MOCK_SID_1)).toBe('QQ 单聊架构总结');
    } finally {
      renameSpy.mockRestore();
      await sessionManager.dispose();
    }
  });

  it('契约 3: /会话 与 /状态 使用真实 AI 会话标题与轮次标签展示，并支持按 AI 标题关键字切换', async () => {
    const ctx: any = booted!.ctx;
    const sessionManager = new SessionManager(ctx, tmpHome);

    try {
      const a1 = await sessionManager.getOrCreateAgent(MOCK_PEER_2);
      a1.session.append('session/title', {
        title: '调试图片下载失败',
        messageSeqs: [],
        source: { kind: 'fallback' },
      });
      await ctx.sessions.flush(a1.session);

      sessionManager.markSessionCleared(MOCK_PEER_2);
      const a2 = await sessionManager.getOrCreateAgent(MOCK_PEER_2);
      // 第二轮尚未产生 AI 标题，且仅此一个未命名会话，应显示无后缀「新会话」
      await ctx.sessions.flush(a2.session);

      const listRes = await handleSlashCommand('/会话', {
        userId: MOCK_PEER_2,
        session: a2.session,
        ctx,
        sessionManager,
      });
      expect(listRes.handled).toBe(true);
      expect(listRes.success).toBe(true);
      expect(listRes.reply).toContain('1. [当前] 新会话');
      expect(listRes.reply).toContain('2. 调试图片下载失败');
      expect(listRes.reply).not.toContain('调试图片下载失败 (#1)');
      expect(listRes.reply).not.toContain('新会话 #2');
      expect(listRes.reply).not.toContain('新会话 (#2)');
      expect(listRes.reply).not.toContain(`[${MOCK_SID_2}`);
      expect(listRes.reply).toContain('- 按标题切换：/会话 <标题或关键字>');
      expect(listRes.reply).not.toContain('私聊:');

      // 在 /状态 中查看有 AI 标题的会话与无标题的新会话（无重名均不带 (#N) 且无会话标识）
      const statusUntitled = await handleSlashCommand('/状态', {
        userId: MOCK_PEER_2,
        session: a2.session,
        ctx,
        sessionManager,
      });
      expect(statusUntitled.success).toBe(true);
      expect(statusUntitled.reply).toContain('当前会话：新会话');
      expect(statusUntitled.reply).not.toContain('新会话 (#2)');
      expect(statusUntitled.reply).not.toContain('会话标识');

      const statusTitled = await handleSlashCommand('/状态', {
        userId: MOCK_PEER_2,
        session: a1.session,
        ctx,
        sessionManager,
      });
      expect(statusTitled.success).toBe(true);
      expect(statusTitled.reply).toContain('当前会话：调试图片下载失败');
      expect(statusTitled.reply).not.toContain('调试图片下载失败 (#1)');
      expect(statusTitled.reply).not.toContain('会话标识');

      // 支持按真实 AI 标题关键字模糊匹配切换回会话 1
      const switchByTitle = await handleSlashCommand('/会话 图片下载', {
        userId: MOCK_PEER_2,
        session: a2.session,
        ctx,
        sessionManager,
      });
      expect(switchByTitle.success).toBe(true);
      expect(switchByTitle.reply).toBe('已切换到会话：调试图片下载失败');
      expect(sessionManager.peerToSessionId(MOCK_PEER_2)).toBe(MOCK_SID_2);
    } finally {
      await sessionManager.dispose();
    }
  });

  it('契约 4: 同名会话冲突（含多个未命名「新会话」）时展示 (#N) 并支持按版本切换', async () => {
    const ctx: any = booted!.ctx;
    const sessionManager = new SessionManager(ctx, tmpHome);

    try {
      const a1 = await sessionManager.getOrCreateAgent(MOCK_PEER_3);
      await ctx.sessions.flush(a1.session);

      sessionManager.markSessionCleared(MOCK_PEER_3);
      const a2 = await sessionManager.getOrCreateAgent(MOCK_PEER_3);
      await ctx.sessions.flush(a2.session);

      // 两个未命名会话同为「新会话」，触发同名后缀
      const untitledStatus = await handleSlashCommand('/状态', {
        userId: MOCK_PEER_3,
        session: a2.session,
        ctx,
        sessionManager,
      });
      expect(untitledStatus.success).toBe(true);
      expect(untitledStatus.reply).toContain('当前会话：新会话 (#2)');
      expect(untitledStatus.reply).not.toContain('会话标识');

      const untitledList = await handleSlashCommand('/会话', {
        userId: MOCK_PEER_3,
        session: a2.session,
        ctx,
        sessionManager,
      });
      expect(untitledList.success).toBe(true);
      expect(untitledList.reply).toContain('1. [当前] 新会话 (#2)');
      expect(untitledList.reply).toContain('2. 新会话 (#1)');
      expect(untitledList.reply).not.toContain(`[${MOCK_SID_3}`);

      const untitledMulti = await handleSlashCommand('/会话 新会话', {
        userId: MOCK_PEER_3,
        session: a2.session,
        ctx,
        sessionManager,
      });
      expect(untitledMulti.success).toBe(false);
      expect(untitledMulti.error).toContain('发现多个匹配的会话');
      expect(untitledMulti.error).toContain('- 1. 新会话 (#2)');
      expect(untitledMulti.error).toContain('- 2. 新会话 (#1)');

      // 两个同名「日常闲聊」与一个无重名「架构讨论」共存
      a1.session.append('session/title', {
        title: '日常闲聊',
        messageSeqs: [],
        source: { kind: 'fallback' },
      });
      a2.session.append('session/title', {
        title: '日常闲聊',
        messageSeqs: [],
        source: { kind: 'fallback' },
      });
      await ctx.sessions.flush(a1.session);
      await ctx.sessions.flush(a2.session);

      sessionManager.markSessionCleared(MOCK_PEER_3);
      const a3 = await sessionManager.getOrCreateAgent(MOCK_PEER_3);
      a3.session.append('session/title', {
        title: '架构讨论',
        messageSeqs: [],
        source: { kind: 'fallback' },
      });
      await ctx.sessions.flush(a3.session);

      const mixedList = await handleSlashCommand('/会话', {
        userId: MOCK_PEER_3,
        session: a3.session,
        ctx,
        sessionManager,
      });
      expect(mixedList.success).toBe(true);
      expect(mixedList.reply).toContain('1. [当前] 架构讨论');
      expect(mixedList.reply).toContain('2. 日常闲聊 (#2)');
      expect(mixedList.reply).toContain('3. 日常闲聊 (#1)');
      expect(mixedList.reply).not.toContain('架构讨论 (#3)');
      expect(mixedList.reply).not.toContain(`[${MOCK_SID_3}`);

      const statusDup1 = await handleSlashCommand('/状态', {
        userId: MOCK_PEER_3,
        session: a1.session,
        ctx,
        sessionManager,
      });
      expect(statusDup1.success).toBe(true);
      expect(statusDup1.reply).toContain('当前会话：日常闲聊 (#1)');
      expect(statusDup1.reply).not.toContain('会话标识');

      const statusUnique = await handleSlashCommand('/状态', {
        userId: MOCK_PEER_3,
        session: a3.session,
        ctx,
        sessionManager,
      });
      expect(statusUnique.success).toBe(true);
      expect(statusUnique.reply).toContain('当前会话：架构讨论');
      expect(statusUnique.reply).not.toContain('架构讨论 (#3)');
      expect(statusUnique.reply).not.toContain('会话标识');

      const multiMatch = await handleSlashCommand('/会话 日常闲聊', {
        userId: MOCK_PEER_3,
        session: a3.session,
        ctx,
        sessionManager,
      });
      expect(multiMatch.success).toBe(false);
      expect(multiMatch.error).toContain('发现多个匹配的会话');
      expect(multiMatch.error).toContain('- 2. 日常闲聊 (#2)');
      expect(multiMatch.error).toContain('- 3. 日常闲聊 (#1)');
      expect(multiMatch.error).toContain('/会话 <序号>');
      expect(multiMatch.error).toContain('/会话 日常闲聊 (#2)');

      const exactSwitch = await handleSlashCommand('/会话 日常闲聊 (#2)', {
        userId: MOCK_PEER_3,
        session: a3.session,
        ctx,
        sessionManager,
      });
      expect(exactSwitch.success).toBe(true);
      expect(exactSwitch.reply).toBe('已切换到会话：日常闲聊 (#2)');
      expect(sessionManager.peerToSessionId(MOCK_PEER_3)).toBe(`${MOCK_SID_3}-2`);
    } finally {
      await sessionManager.dispose();
    }
  });
});
