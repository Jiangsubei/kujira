/**
 * kujira: 黑话知识库 (Slang & Memes) 学习套件核心模块
 * 组合 SlangStorage, SlangTools 与 SystemPrompt 动态段注入。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { SlangStorage } from './storage.js';
import { createSlangToolDefinitions } from '../tools/slang/index.js';
import {
  DEFAULT_SLANG_MAX_ENTRIES,
  DEFAULT_SLANG_EVICT_POLICY,
  DEFAULT_DATABASE_PATH,
} from '../constants/index.js';
import { resolveDshPath } from '../utils/path.js';
import type { MessageDatabase } from '../storage/database.js';
import { SnapshotManager, formatSlangContext } from '../prompt/snapshot.js';

export * from './storage.js';
export * from '../tools/slang/index.js';

export interface SlangServiceOptions {
  db?: MessageDatabase;
  storagePath?: string;
  dshHome?: string;
  maxEntries?: number | (() => number);
  getMaxEntries?: () => number;
  evictPolicy?: 'reject' | 'evict_lru' | (() => 'reject' | 'evict_lru');
  getEvictPolicy?: () => 'reject' | 'evict_lru';
  /** 是否向 root ctx.tools 注册全局 Slang 工具（默认 true） */
  registerGlobalTools?: boolean;
  /** 是否向 root ctx 注册动态提示词段（默认 true；在配合统一 SnapshotHub 装配时传入 false） */
  registerPromptContext?: boolean;
}

/**
 * 装配并启动黑话知识库 (Slang & Memes) 服务
 */
export function setupSlangService(
  ctx: Context,
  options: SlangServiceOptions = {}
): {
  storage: SlangStorage;
  tools: ToolDefinition[];
  dispose: () => void;
} {
  const effectiveDshHome = resolveDshPath(options.dshHome);
  const getMaxEntries = () =>
    options.getMaxEntries?.() ??
    (typeof options.maxEntries === 'function' ? options.maxEntries() : options.maxEntries) ??
    DEFAULT_SLANG_MAX_ENTRIES;

  const getEvictPolicy = () =>
    options.getEvictPolicy?.() ??
    (typeof options.evictPolicy === 'function' ? options.evictPolicy() : options.evictPolicy) ??
    DEFAULT_SLANG_EVICT_POLICY;

  // 1. 初始化 Storage（基于 SQLite 全局共享）
  const storage = new SlangStorage(
    options.db || options.storagePath || DEFAULT_DATABASE_PATH,
    getMaxEntries,
    getEvictPolicy,
    effectiveDshHome
  );

  const toolDefs = createSlangToolDefinitions(storage);
  const unregisters: Array<() => void> = [];

  // 2. 注册 Slang 工具到 DSH ctx.tools
  const doRegisterTools = (toolsService: any) => {
    if (!toolsService || typeof toolsService.register !== 'function') return;
    for (const def of toolDefs) {
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

  // 3. 注册动态黑话知识库通道，统一通过 SnapshotManager 享受严格 Fail-Closed 白名单防护
  if (options.registerPromptContext !== false) {
    const snapshotManager = new SnapshotManager(ctx);
    unregisters.push(() => snapshotManager.dispose());
    const promptDisposer = snapshotManager.registerProvider({
      name: 'kujira:slang',
      order: 45,
      provide: () => {
        const rawMarkdown = storage.getRawMarkdownSync();
        if (!rawMarkdown || !rawMarkdown.trim()) {
          return '';
        }
        return formatSlangContext(rawMarkdown.trim());
      },
    });
    unregisters.push(promptDisposer);
  }

  return {
    storage,
    tools: toolDefs,
    dispose: () => {
      for (const unreg of unregisters) {
        try {
          unreg();
        } catch {}
      }
    },
  };
}
