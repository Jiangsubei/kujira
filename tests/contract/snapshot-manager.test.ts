/**
 * tests/contract/snapshot-manager.test.ts
 * 契约测试: Kujira 多通道独立运行时快照与上下文注入管理器 (SnapshotManager Contract)
 *
 * 验证规则:
 * 1. 契约 1: resolveQQSessionContext 与 isExplicitNonQQSession 具备严格 Fail-Closed 白名单校验（仅放行 kujira-user-<hash> 与 user_<hash>）；
 * 2. 契约 2: SnapshotManager 安全门控 — Web UI / 旧群聊格式 / 空上下文 / 沙箱 100% 阻断，0 条注入；
 * 3. 契约 3: 单 Provider 异常时优雅降级隔离，绝不影响其他 Provider 和装配流程；
 * 4. 契约 4: dispose 与 unregister 正确释放 Provider 与清理会话状态；
 * 5. 契约 5: setupSnapshotHub 规范装配 6 大独立原子通道 (kujira:*)，单聊用户画像严格按 session.peer 隔离读取；
 * 6. 契约 6: 多通道独立快照脏检查与增量注入契约（0-Token 命中、单通道增量、历史恢复）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  SnapshotManager,
  resolveQQSessionContext,
  isExplicitNonQQSession,
  setupSnapshotHub,
  type SnapshotProvider,
} from '../../src/prompt/snapshot.js';
import { MemoryStorage } from '../../src/memory/storage.js';
import { DEFAULT_BEHAVIOR } from '../../src/constants/index.js';
import { computeOpenidHash16, openidToPeer, openidToSessionBaseId } from '../../src/utils/peer.js';

describe('契约测试: Kujira 多通道独立运行时快照管理器 (SnapshotManager Contract)', () => {
  let mockCtx: any;
  let preStepHandler: ((args: any, next: any) => Promise<any>) | undefined;

  const hashA = computeOpenidHash16('MOCK_OPENID_SNAPSHOT_A');
  const peerA = openidToPeer('MOCK_OPENID_SNAPSHOT_A');
  const sessionBaseA = openidToSessionBaseId('MOCK_OPENID_SNAPSHOT_A');

  const hashB = computeOpenidHash16('MOCK_OPENID_SNAPSHOT_B');
  const peerB = openidToPeer('MOCK_OPENID_SNAPSHOT_B');

  beforeEach(() => {
    preStepHandler = undefined;
    mockCtx = {
      on: vi.fn().mockImplementation((event: string, handler: any) => {
        if (event === 'agent/pre-step') {
          preStepHandler = handler;
        }
        return () => {
          if (preStepHandler === handler) {
            preStepHandler = undefined;
          }
        };
      }),
    };
  });

  describe('契约 1: resolveQQSessionContext 与 isExplicitNonQQSession Fail-Closed 判定', () => {
    it('1.1 能从 kujira-user-<hash>（含可选轮次/版本/防撞后缀）与 user_<hash> 解析出干净 { peer, userId }', () => {
      const ctx1 = { agent: { session: { id: sessionBaseA } } };
      const res1 = resolveQQSessionContext(ctx1);
      expect(res1).toEqual({ peer: peerA, userId: hashA });
      expect((res1 as any).qq).toBeUndefined();
      expect((res1 as any).isGroup).toBeUndefined();
      expect((res1 as any).isPrivate).toBeUndefined();

      const ctx2 = { agent: { sessionId: `${sessionBaseA}-2` } };
      expect(resolveQQSessionContext(ctx2)).toEqual({ peer: peerA, userId: hashA });

      const ctx3 = { session: { id: `${sessionBaseA}-r3-2-deadbe` } };
      expect(resolveQQSessionContext(ctx3)).toEqual({ peer: peerA, userId: hashA });

      const ctx4 = { peer: peerB };
      expect(resolveQQSessionContext(ctx4)).toEqual({ peer: peerB, userId: hashB });

      // 不受 \d+ 纯数字限制，兼容大小写字母与下划线短哈希
      const ctx5 = { sessionId: 'kujira-user-abc123DEF_99-r1-1-a1b2' };
      expect(resolveQQSessionContext(ctx5)).toEqual({
        peer: 'user_abc123DEF_99',
        userId: 'abc123DEF_99',
      });
    });

    it('1.2 严格 Fail-Closed: 旧群聊/旧 NapCat、Web UI、沙箱、空上下文及畸形 ID 一律返回 null', () => {
      expect(resolveQQSessionContext(undefined)).toBeNull();
      expect(resolveQQSessionContext(null)).toBeNull();
      expect(resolveQQSessionContext({})).toBeNull();
      expect(resolveQQSessionContext({ session: { id: '' } })).toBeNull();
      expect(resolveQQSessionContext({ session: { id: 'web-session-123' } })).toBeNull();
      expect(resolveQQSessionContext({ agent: { sessionId: 'desktop-main' } })).toBeNull();
      expect(resolveQQSessionContext({ scope: 's-random-guid' })).toBeNull();
      expect(resolveQQSessionContext({ peer: 'default' })).toBeNull();
      expect(resolveQQSessionContext({ peer: `review-${peerA}` })).toBeNull();

      // 彻底移除旧群聊与旧 NapCat 格式
      expect(resolveQQSessionContext({ session: { id: 'qq-group-1000000001-1' } })).toBeNull();
      expect(resolveQQSessionContext({ peer: 'group_1000000001' })).toBeNull();
      expect(resolveQQSessionContext({ session: { id: 'group-1000000001' } })).toBeNull();
      expect(resolveQQSessionContext({ session: { id: 'qq-user-1000000010' } })).toBeNull();
      expect(resolveQQSessionContext({ session: { id: 'qq-1000000030' } })).toBeNull();

      // 畸形/不完整 Kujira 前缀
      expect(resolveQQSessionContext({ session: { id: 'kujira-user-' } })).toBeNull();
      expect(resolveQQSessionContext({ peer: 'user_' })).toBeNull();
      expect(resolveQQSessionContext({ session: { id: `${sessionBaseA}-bad-suffix` } })).toBeNull();
    });

    it('1.3 isExplicitNonQQSession 放行 kujira-user-* 与 user_*，拦截显式非 Kujira 会话', () => {
      expect(isExplicitNonQQSession(undefined)).toBe(false);
      expect(isExplicitNonQQSession({})).toBe(false);
      expect(isExplicitNonQQSession({ session: { id: sessionBaseA } })).toBe(false);
      expect(isExplicitNonQQSession({ session: { id: `${sessionBaseA}-r1-1-a1b2c3` } })).toBe(false);
      expect(isExplicitNonQQSession({ peer: peerB })).toBe(false);

      expect(isExplicitNonQQSession({ session: { id: 'web-session-123' } })).toBe(true);
      expect(isExplicitNonQQSession({ agent: { sessionId: 'desktop-main' } })).toBe(true);
      expect(isExplicitNonQQSession({ scope: 's-random-guid' })).toBe(true);
      expect(isExplicitNonQQSession({ peer: `review-${peerA}` })).toBe(true);
      expect(isExplicitNonQQSession({ peer: 'default' })).toBe(true);
      expect(isExplicitNonQQSession({ session: { id: 'qq-group-1000000001' } })).toBe(true);
      expect(isExplicitNonQQSession({ peer: 'group_1000000001' })).toBe(true);
      expect(isExplicitNonQQSession({ session: { id: 'qq-user-1000000010' } })).toBe(true);
    });
  });

  describe('契约 2: SnapshotManager 统一安全门控 (Web UI / 旧群聊 / 非 Kujira 0 泄露)', () => {
    it('2.1 Web UI 与旧群聊会话触发 pre-step，所有 qqOnly Provider 均不被调用且 0 条消息注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      const provideSlang = vi.fn().mockReturnValue('## 黑话与梗知识库 (Slang & Memes)\n- 词条A');
      const provideFace = vi.fn().mockReturnValue('## 本地表情包库存 (Sticker & Meme Library)');

      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: provideSlang,
      });
      manager.registerProvider({
        name: 'kujira:face_summary',
        order: 48,
        provide: provideFace,
      });

      const webArgs = {
        agent: { session: { id: 'web-session-42' } },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Web 用户提问' }] }],
      };

      const webResult = await manager.handlePreStep(webArgs, async () => ({
        kind: 'enter',
        messages: webArgs.messages,
      }));
      expect(webResult.messages.length).toBe(1);
      expect(webResult.messages[0].content[0].text).toBe('Web 用户提问');

      const legacyGroupArgs = {
        agent: { session: { id: 'qq-group-1000000001' } },
        messages: [],
      };
      const groupResult = await manager.handlePreStep(legacyGroupArgs, async () => ({
        kind: 'enter',
        messages: [],
      }));
      expect(groupResult.messages.length).toBe(0);

      expect(provideSlang).not.toHaveBeenCalled();
      expect(provideFace).not.toHaveBeenCalled();

      manager.dispose();
    });

    it('2.2 Kujira 单聊会话下，正常放行并调用 provide 产生专属通道快照消息', async () => {
      const manager = new SnapshotManager(mockCtx);

      const provideSlang = vi.fn().mockReturnValue('## 黑话与梗知识库 (Slang & Memes)\n- 词条A: 释义A');
      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: provideSlang,
      });

      const kujiraArgs = {
        agent: { session: { id: `${sessionBaseA}-r1-1` } },
        messages: [],
      };

      const result = await manager.handlePreStep(kujiraArgs, async () => ({
        kind: 'enter',
        messages: [],
      }));

      expect(provideSlang).toHaveBeenCalledTimes(1);
      expect(provideSlang).toHaveBeenCalledWith({ peer: peerA, userId: hashA }, expect.anything());
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].source.kind).toBe('kujira:slang');
      expect(result.messages[0].source.form).toBe('snapshot');
      expect(result.messages[0].source.sections[0].text).toContain('词条A');

      manager.dispose();
    });
  });

  describe('契约 3: 单 Provider 异常优雅降级', () => {
    it('3.1 当某 Provider 执行抛出异常时，捕获并不阻断其他正常通道的注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      const badProvider: SnapshotProvider = {
        name: 'kujira:face_summary',
        order: 48,
        provide: () => {
          throw new Error('SQLite disk I/O error');
        },
      };

      const goodProvider: SnapshotProvider = {
        name: 'kujira:slang',
        order: 45,
        provide: () => '## 黑话与梗知识库 (Slang & Memes)\n正常黑话内容',
      };

      manager.registerProvider(badProvider);
      manager.registerProvider(goodProvider);

      const kujiraArgs = {
        agent: { session: { id: sessionBaseA } },
        messages: [],
      };

      const result = await manager.handlePreStep(kujiraArgs, async () => ({
        kind: 'enter',
        messages: [],
      }));

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].source.kind).toBe('kujira:slang');

      manager.dispose();
    });
  });

  describe('契约 4: dispose 正确释放注册项与清理状态', () => {
    it('4.1 独立 unregister 与全量 dispose 正确注销通道与清理缓存', async () => {
      const manager = new SnapshotManager(mockCtx);

      const unregister = manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: () => 'test',
      });
      expect(manager.getProvider('kujira:slang')).toBeDefined();

      unregister();
      expect(manager.getProvider('kujira:slang')).toBeUndefined();

      manager.registerProvider({
        name: 'kujira:session_rules',
        order: 40,
        provide: () => 'rules',
      });
      manager.registerProvider({
        name: 'kujira:face_summary',
        order: 48,
        provide: () => 'face',
      });

      await manager.handlePreStep(
        { agent: { session: { id: peerA } }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );
      expect(manager.getRetained(peerA, 'kujira:session_rules')).toBe('rules');

      manager.dispose();
      expect(manager.getProvider('kujira:session_rules')).toBeUndefined();
      expect(manager.getRetained(peerA, 'kujira:session_rules')).toBeUndefined();
    });
  });

  describe('契约 5: setupSnapshotHub 装配 6 大独立原子通道规范与单聊强隔离', () => {
    it('5.1 准确装配 6 个 kujira:* 原子通道，按 session.peer 单聊强隔离注入且不调用 db.getActiveUsers', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kujira-hub-mem-'));
      try {
        const memoryStorage = new MemoryStorage(tmpDir);
        await memoryStorage.writeSessionMemory(peerA, '约定：回答保持精简');
        await memoryStorage.writeUserProfile(peerA, '用户 A 偏好使用 TypeScript');
        await memoryStorage.writeUserProfile(peerB, '用户 B 的隔离画像');

        const mockDb: any = {
          getActiveFacesForContext: vi.fn().mockReturnValue({
            total: 2,
            faces: [
              { id: 'face_1', mood: '开心', tags: ['大笑'], enabled: true },
              { id: 'face_2', mood: '调侃', tags: ['摊手'], enabled: true },
            ],
          }),
        };

        const mockSlangStorage: any = {
          getRawMarkdownSync: vi.fn().mockReturnValue('- 词条一：触发场景一'),
        };

        const hub = setupSnapshotHub({
          ctx: mockCtx,
          db: mockDb,
          memoryStorage,
          slangStorage: mockSlangStorage,
          getPersona: () => '自定义人格设定',
          getBehavior: () => '',
        });

        expect(hub.getProvider('kujira:persona')).toBeDefined();
        expect(hub.getProvider('kujira:behavior')).toBeDefined();
        expect(hub.getProvider('kujira:session_rules')).toBeDefined();
        expect(hub.getProvider('kujira:user_profiles')).toBeDefined();
        expect(hub.getProvider('kujira:slang')).toBeDefined();
        expect(hub.getProvider('kujira:face_summary')).toBeDefined();

        expect(hub.getProvider('napcat:persona')).toBeUndefined();
        expect(hub.getProvider('kujira:memory')).toBeUndefined();
        expect(hub.getProvider('kujira:behavior_persona')).toBeUndefined();

        const kujiraSessionA = { peer: peerA, userId: hashA };
        const assembleCtxA = { session: { id: sessionBaseA } };

        // 1. 人格
        expect(hub.getProvider('kujira:persona')?.provide(kujiraSessionA, assembleCtxA)).toBe(
          '## 人格设定 (Persona)\n\n自定义人格设定'
        );
        // 2. 行为准则（未配置时默认回退 DEFAULT_BEHAVIOR 且声明支持 Markdown）
        const behaviorOut = hub.getProvider('kujira:behavior')?.provide(kujiraSessionA, assembleCtxA) || '';
        expect(behaviorOut).toContain('## 行为准则 (Behavior Guidelines)');
        expect(behaviorOut).toContain(DEFAULT_BEHAVIOR);
        expect(behaviorOut).toContain('Markdown');
        // 3. 会话规则
        const rulesOut = hub.getProvider('kujira:session_rules')?.provide(kujiraSessionA, assembleCtxA) || '';
        expect(rulesOut).toContain('## 会话规则与约定 (Session Rules & Conventions)');
        expect(rulesOut).toContain('约定：回答保持精简');
        // 4. 用户画像（单聊强隔离，绝不含群成员字样与 peerB 画像）
        const profileOut = hub.getProvider('kujira:user_profiles')?.provide(kujiraSessionA, assembleCtxA) || '';
        expect(profileOut).toContain('## 用户画像与偏好 (User Profile)');
        expect(profileOut).toContain('### 用户画像\n用户 A 偏好使用 TypeScript');
        expect(profileOut).not.toContain('群成员');
        expect(profileOut).not.toContain('用户 B 的隔离画像');
        // 5. 黑话
        const slangOut = hub.getProvider('kujira:slang')?.provide(kujiraSessionA, assembleCtxA) || '';
        expect(slangOut).toContain('## 黑话与梗知识库 (Slang & Memes)');
        expect(slangOut).not.toContain('社群');
        // 6. 表情包
        expect(hub.getProvider('kujira:face_summary')?.provide(kujiraSessionA, assembleCtxA)).toContain(
          '## 本地表情包库存 (Sticker & Meme Library)'
        );

        hub.dispose();
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('5.2 setupSnapshotHub 传递 getFaceStoreMax 时，表情包查询上限严格遵循该配置', () => {
      const mockDb: any = {
        getActiveFacesForContext: vi.fn().mockReturnValue({
          total: 0,
          faces: [],
        }),
      };

      const hub = setupSnapshotHub({
        ctx: mockCtx,
        db: mockDb,
        getFaceStoreMax: () => 250,
      });

      const kujiraSession = { peer: peerA, userId: hashA };
      hub.getProvider('kujira:face_summary')?.provide(kujiraSession, {});

      expect(mockDb.getActiveFacesForContext).toHaveBeenCalledWith(250);

      hub.dispose();
    });
  });

  describe('契约 6: 多通道独立快照脏检查与增量注入契约 (Multi-Channel Snapshot)', () => {
    it('6.1 首次进入会话触发 pre-step，各通道独立生成带有 form: "snapshot" 的 UserMessage', async () => {
      const manager = new SnapshotManager(mockCtx);

      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: () => '## 黑话与梗知识库 (Slang & Memes)\n- 词条A: 释义A',
      });
      manager.registerProvider({
        name: 'kujira:face_summary',
        order: 48,
        provide: () => '## 本地表情包库存\n- face_1',
      });

      const sessionObj = { id: sessionBaseA };
      const preStepArgs = {
        agent: { session: sessionObj },
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      };

      const result = await manager.handlePreStep(preStepArgs, async () => ({
        kind: 'enter',
        messages: preStepArgs.messages,
      }));

      expect(result.kind).toBe('enter');
      expect(result.messages.length).toBe(3);

      const slangMsg = result.messages.find((m: any) => m.source?.kind === 'kujira:slang');
      expect(slangMsg).toBeDefined();
      expect(slangMsg.source.form).toBe('snapshot');
      expect(slangMsg.source.sections[0].name).toBe('kujira:slang');
      expect(slangMsg.source.sections[0].text).toContain('词条A');
      expect(slangMsg.content[0].text).toContain('<system-reminder>');
      expect(slangMsg.content[0].text).toContain('Current runtime context: kujira:slang');

      const faceMsg = result.messages.find((m: any) => m.source?.kind === 'kujira:face_summary');
      expect(faceMsg).toBeDefined();
      expect(faceMsg.source.form).toBe('snapshot');
      expect(faceMsg.source.sections[0].name).toBe('kujira:face_summary');
      expect(faceMsg.source.sections[0].text).toContain('face_1');

      manager.dispose();
    });

    it('6.2 第二轮对话中各通道内容未发生变化时，产出 0 条注入消息，杜绝 Token 浪费', async () => {
      const manager = new SnapshotManager(mockCtx);

      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: () => '## 黑话与梗知识库 (Slang & Memes)\n- 词条A: 释义A',
      });
      manager.registerProvider({
        name: 'kujira:face_summary',
        order: 48,
        provide: () => '## 本地表情包库存\n- face_1',
      });

      const sessionObj = { id: sessionBaseA };
      await manager.handlePreStep(
        { agent: { session: sessionObj }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      const preStepArgs2 = {
        agent: { session: sessionObj },
        messages: [{ role: 'user', content: [{ type: 'text', text: '第二轮发言' }] }],
      };
      const result2 = await manager.handlePreStep(preStepArgs2, async () => ({
        kind: 'enter',
        messages: preStepArgs2.messages,
      }));

      expect(result2.messages.length).toBe(1);
      expect(result2.messages[0].content[0].text).toBe('第二轮发言');

      manager.dispose();
    });

    it('6.3 仅某一个通道（如黑话）变动时，仅为该通道生成新快照，表情包等大块通道绝不重发', async () => {
      const manager = new SnapshotManager(mockCtx);

      let slangContent = '## 黑话与梗知识库 (Slang & Memes)\n- 词条1: 释义1';
      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: () => slangContent,
      });
      manager.registerProvider({
        name: 'kujira:face_summary',
        order: 48,
        provide: () => '## 本地表情包库存\n- face_1\n- face_2',
      });

      const sessionObj = { id: sessionBaseA };

      await manager.handlePreStep(
        { agent: { session: sessionObj }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      slangContent = '## 黑话与梗知识库 (Slang & Memes)\n- 词条1: 释义1\n- 词条2: 新增词条';

      const result = await manager.handlePreStep(
        { agent: { session: sessionObj }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      expect(result.messages.length).toBe(1);
      const injected = result.messages[0];
      expect(injected.source.kind).toBe('kujira:slang');
      expect(injected.source.sections[0].text).toContain('词条2: 新增词条');
      expect(result.messages.some((m: any) => m.source?.kind === 'kujira:face_summary')).toBe(false);

      manager.dispose();
    });

    it('6.4 非 Kujira 会话（如 Web UI）触发 pre-step，严格 Fail-Closed 阻断，0 条注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: () => '私密黑话',
      });
      manager.registerProvider({
        name: 'kujira:face_summary',
        order: 48,
        provide: () => '私密表情包库存',
      });

      const webSessionObj = { id: 'web-session-999' };
      const preStepArgs = {
        agent: { session: webSessionObj },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Web端提问' }] }],
      };

      const result = await manager.handlePreStep(preStepArgs, async () => ({
        kind: 'enter',
        messages: preStepArgs.messages,
      }));

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content[0].text).toBe('Web端提问');

      manager.dispose();
    });

    it('6.5 会话重连与历史恢复：当会话历史中已存在某通道相同快照时，不重复注入', async () => {
      const manager = new SnapshotManager(mockCtx);

      const existingSlang = '## 黑话与梗知识库 (Slang & Memes)\n- 历史已学黑话';
      manager.registerProvider({
        name: 'kujira:slang',
        order: 45,
        provide: () => existingSlang,
      });

      const mockSession = {
        id: sessionBaseA,
        snapshotEvents: () => [
          {
            type: 'user/message',
            data: {
              source: {
                kind: 'kujira:slang',
                form: 'snapshot',
                sections: [{ name: 'kujira:slang', text: existingSlang }],
              },
            },
          },
        ],
      };

      const result = await manager.handlePreStep(
        { agent: { session: mockSession }, messages: [] },
        async () => ({ kind: 'enter', messages: [] })
      );

      expect(result.messages.length).toBe(0);

      manager.dispose();
    });
  });
});
