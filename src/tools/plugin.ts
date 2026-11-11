/**
 * kujira: QQ 官方 Bot 单聊工具集 Cordis 插件
 * 供 DSH 预设 (@deepseek-ai/dsh-agent-preset) 或 Agent 作用域作为独立 row 挂载。
 */

import type { Context } from '@deepseek-ai/cordis';

export const name = 'kujira-tools';
export const inject = ['tools'];

export interface KujiraBridgeToolsProvider {
  registerTools(ctx: Context): () => void;
}

let globalBridgeToolsProvider: KujiraBridgeToolsProvider | undefined;

export function setGlobalBridgeToolsProvider(provider: KujiraBridgeToolsProvider | undefined): void {
  globalBridgeToolsProvider = provider;
}

export function getGlobalBridgeToolsProvider(): KujiraBridgeToolsProvider | undefined {
  return globalBridgeToolsProvider;
}

export function apply(ctx: Context): void {
  const getProvider = (): KujiraBridgeToolsProvider | undefined => {
    return (
      (typeof (ctx as any).get === 'function' ? (ctx as any).get('kujiraBridgeTools') : undefined) ||
      (ctx as any).kujiraBridgeTools ||
      (ctx.root as any)?.kujiraBridgeTools ||
      globalBridgeToolsProvider
    );
  };

  const provider = getProvider();
  if (provider && typeof provider.registerTools === 'function') {
    const unregister = provider.registerTools(ctx);
    if (typeof (ctx as any).effect === 'function') {
      (ctx as any).effect(
        () => () => {
          try {
            unregister();
          } catch {}
        },
        'kujira-tools.effect'
      );
    } else {
      (ctx as any).on?.('dispose', () => {
        try {
          unregister();
        } catch {}
      });
    }
  }
}

export default { name, inject, apply };
