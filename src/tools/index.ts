/**
 * kujira: Agent 工具集聚合门面
 *
 * 聚合导出所有领域工具工厂、执行逻辑及类型定义，
 * 并提供 registerAgentTools 统一装配管线。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { BridgePluginConfig } from '../types/index.js';
import { resolveDshPath } from '../utils/path.js';
import {
  DEFAULT_FACE_STORE_DIR,
  DEFAULT_SLANG_EVICT_POLICY,
  DEFAULT_SLANG_MAX_ENTRIES,
} from '../constants/index.js';

// 1. 公共基础设施
export * from './common/context.js';
export * from '../utils/lossless-json.js';
export * from './pagination.js';
export { normalizePeer } from './common/context.js';

// 2. 领域工具集 Re-export
export * from './messaging/index.js';
export * from './chat-history/index.js';
export * from './face/index.js';
export * from './resource/index.js';
export * from './file-source.js';
export * from './scheduler.js';
export * from './memory/index.js';
export * from './slang/index.js';
export { SlangStorage } from '../slang/index.js';

// 3. 内部装配依赖
import {
  type AgentToolsOptions,
  setGlobalToolContext,
  getGlobalToolContext,
} from './common/context.js';
import {
  createReadChatHistoryTool,
  createWaitForUserMessagesTool,
} from './chat-history/index.js';
import { createSendFileTool } from './resource/index.js';
import {
  createSendQqMessageTool,
  createRecallMessageTool,
} from './messaging/index.js';
import {
  createListFacesTool,
  createSendFaceTool,
  createCollectFaceTool,
  createManageFacesTool,
} from './face/index.js';
import {
  createScheduleTaskTool,
  createManageScheduledTasksTool,
} from './scheduler.js';
import { createSlangToolDefinitions } from './slang/index.js';
import { SlangStorage } from '../slang/index.js';

/**
 * 注册 Agent 工具集至 DSH 工具运行时 (ctx.tools)
 */
export function registerAgentTools(
  ctx: Context,
  options: AgentToolsOptions
): () => void {
  const getConfig = (): BridgePluginConfig => {
    if (typeof (options as any).config === 'function') {
      return (options as any).config() || {};
    }
    if (typeof (options as any).configGetter === 'function') {
      return (options as any).configGetter() || {};
    }
    if ((options as any).config && typeof (options as any).config === 'object') {
      return (options as any).config;
    }
    return {};
  };

  const currentCfg = getConfig();

  setGlobalToolContext({
    db: options.db,
    outboundBridge: options.outboundBridge,
    gateway: options.gateway,
    mediaManager: options.mediaManager,
    sender: options.sender ?? options.outboundBridge?.getSender?.(),
    dshHome: options.dshHome,
    waitRegistry: options.waitRegistry,
    inboundMsgIdGetter: options.inboundMsgIdGetter,
    faceDir: resolveDshPath(options.dshHome, currentCfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
    faceStoreMax: currentCfg.face_store_max,
    faceEvictPolicy: currentCfg.face_evict_policy,
    scheduler: options.scheduler,
    config: options.config ?? (options as any).configGetter,
  });

  const unregisters: Array<() => void> = [];

  const doRegister = (tools: any) => {
    if (!tools || typeof tools.register !== 'function' || unregisters.length > 0) {
      return;
    }

    // 1. read_chat_history
    unregisters.push(tools.register(createReadChatHistoryTool(options)));

    // 2. send_file
    unregisters.push(tools.register(createSendFileTool(options)));

    // 3. wait_for_user_messages
    unregisters.push(tools.register(createWaitForUserMessagesTool(options)));

    // 4. send_qq_message
    unregisters.push(tools.register(createSendQqMessageTool(options)));

    // 5. recall_message
    unregisters.push(tools.register(createRecallMessageTool(options)));

    // 6. 表情包能力 (由 face_enabled 总开关前置门控)
    if (getConfig().face_enabled) {
      unregisters.push(tools.register(createListFacesTool(options)));
      unregisters.push(tools.register(createSendFaceTool(options)));
      unregisters.push(tools.register(createCollectFaceTool(options)));
      unregisters.push(tools.register(createManageFacesTool(options)));
    }

    // 7. schedule_task
    unregisters.push(
      tools.register(
        createScheduleTaskTool(() => {
          const g = getGlobalToolContext();
          return {
            scheduler: options.scheduler || g.scheduler,
            peer: g.peer,
          };
        })
      )
    );

    // 8. 黑话学习工具集 (由 slang_enabled 总开关前置门控，默认开启)
    if (getConfig().slang_enabled !== false) {
      const storage =
        options.slangStorage ||
        new SlangStorage(
          options.db || getConfig().slang_storage_path,
          () => getConfig().slang_max_entries ?? DEFAULT_SLANG_MAX_ENTRIES,
          () => getConfig().slang_evict_policy ?? DEFAULT_SLANG_EVICT_POLICY,
          options.dshHome
        );
      const slangDefs = createSlangToolDefinitions(storage);
      for (const def of slangDefs) {
        unregisters.push(tools.register(def));
      }
    }

    // 9. manage_scheduled_tasks
    unregisters.push(
      tools.register(
        createManageScheduledTasksTool(() => {
          const g = getGlobalToolContext();
          return {
            scheduler: options.scheduler || g.scheduler,
            peer: g.peer,
          };
        })
      )
    );
  };

  const initialTools =
    (ctx as any).tools || (typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined);
  if (initialTools) {
    doRegister(initialTools);
  }

  const checkReadyTools = () => {
    if (unregisters.length === 0) {
      const readyTools =
        (ctx as any).tools || (typeof (ctx as any).get === 'function' ? (ctx as any).get('tools') : undefined);
      if (readyTools) doRegister(readyTools);
    }
  };
  const appReady = typeof (ctx as any).get === 'function' ? (ctx as any).get('appReady') : undefined;
  if (appReady && typeof appReady.onReady === 'function') {
    appReady.onReady(checkReadyTools);
  }
  (ctx as any).on?.('ready', checkReadyTools);

  return () => {
    for (const unreg of unregisters) {
      try {
        unreg();
      } catch {}
    }
  };
}
