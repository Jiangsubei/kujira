/**
 * kujira: Memory 插件核心模块
 * 组合 MemoryStorage 与 MemoryTools。
 * 动态提示词快照统一接入 SnapshotManager，全面贯彻 Fail-Closed 白名单防御与单聊强隔离。
 */

import type { Context } from '@deepseek-ai/cordis';
import { MemoryStorage } from './storage.js';
import { MemoryTools, createMemoryToolDefinitions } from '../tools/memory/index.js';
import {
  SnapshotManager,
  formatSessionRulesContext,
  formatUserProfilesContext,
} from '../prompt/snapshot.js';
import {
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';

export * from './types.js';
export * from './storage.js';
export * from '../tools/memory/index.js';

export interface MemoryServiceOptions {
  storageDir?: string;
  dshHome?: string;
  /** 单个用户画像文件的写入上限 */
  userProfileBudgetChars?: number;
  /** 单个 Session 规则文件的写入上限 */
  sessionMemoryBudgetChars?: number;
  getUserProfileBudgetChars?: () => number;
  getSessionMemoryBudgetChars?: () => number;
  /** 是否向 root ctx.tools 注册全局 Memory 工具（默认 true；在配合预设架构时传入 false 隔离 Web 会话） */
  registerGlobalTools?: boolean;
  /** 是否向 root ctx 注册动态提示词段（默认 true；在配合统一 SnapshotHub 装配时传入 false） */
  registerPromptContext?: boolean;
}

export function setupMemoryService(
  ctx: Context,
  options: MemoryServiceOptions
): {
  storage: MemoryStorage;
  tools: MemoryTools;
  dispose: () => void;
} {
  const effectiveDshHome = resolveDshPath(options.dshHome);
  const storage = new MemoryStorage(options.storageDir, effectiveDshHome);

  const getUserProfileBudget = () =>
    options.getUserProfileBudgetChars?.() ??
    options.userProfileBudgetChars ??
    DEFAULT_USER_PROFILE_BUDGET_CHARS;

  const getSessionMemoryBudget = () =>
    options.getSessionMemoryBudgetChars?.() ??
    options.sessionMemoryBudgetChars ??
    DEFAULT_SESSION_MEMORY_BUDGET_CHARS;

  const tools = new MemoryTools(storage, ctx, {
    getUserProfileLimit: getUserProfileBudget,
    getSessionLimit: getSessionMemoryBudget,
  });

  const unregisters: Array<() => void> = [];

  // 1. 注册 3 个 Memory Agent 工具到 DSH ctx.tools
  const doRegisterTools = (toolsService: any) => {
    if (!toolsService || typeof toolsService.register !== 'function') return;
    const defs = createMemoryToolDefinitions(tools);
    for (const def of defs) {
      if (typeof toolsService.get === 'function' && toolsService.get(def.name)) {
        continue;
      }
      unregisters.push(toolsService.register(def));
    }
  };

  if (options.registerGlobalTools !== false) {
    const initialTools = typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined;
    if (initialTools) {
      doRegisterTools(initialTools);
    }

    const checkReadyTools = () => {
      const readyTools = typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined;
      if (readyTools) doRegisterTools(readyTools);
    };
    const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
    if (appReady && typeof appReady.onReady === 'function') {
      appReady.onReady(checkReadyTools);
    }
    (ctx as any).on?.('ready', checkReadyTools);
  }

  // 2. 统一通过 SnapshotManager 挂载单聊会话规则与用户画像独立动态通道 (Fail-Closed 安全白名单防护)
  if (options.registerPromptContext !== false) {
    const snapshotManager = new SnapshotManager(ctx);
    unregisters.push(() => snapshotManager.dispose());

    const rulesDisposer = snapshotManager.registerProvider({
      name: 'kujira:session_rules',
      order: 40,
      provide: (session) => {
        const raw = storage.getSessionRulesSnapshotSync(session.peer);
        return raw ? formatSessionRulesContext(raw) : '';
      },
    });
    unregisters.push(rulesDisposer);

    const profilesDisposer = snapshotManager.registerProvider({
      name: 'kujira:user_profiles',
      order: 42,
      provide: (session) => {
        const raw = storage.getUserProfilesSnapshotSync(session.peer);
        return raw ? formatUserProfilesContext(raw) : '';
      },
    });
    unregisters.push(profilesDisposer);
  }

  return {
    storage,
    tools,
    dispose: () => {
      for (const unreg of unregisters) {
        try {
          unreg();
        } catch {}
      }
    },
  };
}
