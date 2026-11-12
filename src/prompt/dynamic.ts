/**
 * kujira: 动态提示词与上下文注入模块
 * 统一委托至 SnapshotManager，全面贯彻 Fail-Closed 白名单防御。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../storage/database.js';
import {
  SnapshotManager,
  isExplicitNonQQSession,
  formatFaceLibraryContext,
  formatPersonaContext,
  formatBehaviorContext,
} from './snapshot.js';
import {
  DEFAULT_PERSONA,
  resolveEffectiveBehavior,
  DEFAULT_FACE_STORE_MAX,
} from '../constants/index.js';

export * from './snapshot.js';

/**
 * 提示词干净度兼容空桩 (不向 systemPrompt 注入任何场景段)
 */
export function registerQQScenarioDynamicPrompt(_ctx: Context): () => void {
  return () => {};
}

/**
 * 注册 Kujira 动态上下文快照 (委托至 SnapshotManager)
 */
export function registerKujiraDynamicPrompt(
  ctx: Context,
  getPersona: () => string,
  getBehavior: () => string,
  snapshotManager?: SnapshotManager
): () => void {
  const manager = snapshotManager || (ctx as any).snapshotManager || new SnapshotManager(ctx);
  if (typeof (ctx as any).reflect?.provide === 'function' && !(ctx as any).snapshotManager) {
    (ctx as any).reflect.provide('snapshotManager', manager);
  }
  const unreg1 = manager.registerProvider({
    name: 'kujira:persona',
    order: 30,
    qqOnly: false,
    provide: (_session: any, assembleCtx: any) => {
      if (isExplicitNonQQSession(assembleCtx)) return '';
      return formatPersonaContext((getPersona() || '').trim() || DEFAULT_PERSONA);
    },
  });
  const unreg2 = manager.registerProvider({
    name: 'kujira:behavior',
    order: 35,
    qqOnly: false,
    provide: (_session: any, assembleCtx: any) => {
      if (isExplicitNonQQSession(assembleCtx)) return '';
      return formatBehaviorContext(resolveEffectiveBehavior(getBehavior()));
    },
  });
  return () => {
    unreg1();
    unreg2();
  };
}

/**
 * 注册表情包动态 System Prompt 上下文锚点 (委托至 SnapshotManager)
 */
export function registerFacePromptContext(
  ctx: Context,
  db: MessageDatabase,
  getEnabled: () => boolean = () => true,
  getFaceStoreMax?: () => number,
  snapshotManager?: SnapshotManager
): () => void {
  const manager = snapshotManager || (ctx as any).snapshotManager || new SnapshotManager(ctx);
  if (typeof (ctx as any).reflect?.provide === 'function' && !(ctx as any).snapshotManager) {
    (ctx as any).reflect.provide('snapshotManager', manager);
  }
  return manager.registerProvider({
    name: 'kujira:face_summary',
    order: 48,
    provide: () => {
      if (!getEnabled()) {
        return '';
      }

      const limit = typeof getFaceStoreMax === 'function' ? getFaceStoreMax() : DEFAULT_FACE_STORE_MAX;
      const activeFacesRes = db.getActiveFacesForContext(limit);
      return formatFaceLibraryContext(activeFacesRes.faces, activeFacesRes.total);
    },
  });
}
