/**
 * kujira: 模型选择与推理链深度 (reasoningEffort) 调度模块
 * 负责与 DSH LLM 服务交互、维护会话级 (Per-Session) 与 Kujira 插件默认模型选择。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionPersistenceManager } from './persistence.js';

const KUJIRA_DEFAULT_MODEL_KEY = 'kujira_default_model';

/**
 * Kujira 内部维护的会话级模型选择引用。
 * DSH 0.2.2 起 `ModelSelectionRef` 不再由 `@deepseek-ai/dsh-agent` 导出，
 * 模型选择的生效路径为 agentOptions / `agent.model.select()`，此处仅作插件内状态缓存。
 */
export interface KujiraModelSelectionRef {
  current: ModelSelection;
  assembled?: unknown;
}

export class SessionModelSelector {
  private selectionMap = new Map<string, KujiraModelSelectionRef>();
  private configuredDefaultModel?: ModelSelection;

  constructor(
    private readonly ctx?: Context,
    private readonly persistence?: SessionPersistenceManager
  ) {}

  public loadState(records: any[]): void {
    if (!this.persistence) return;
    try {
      const rawDefault = this.persistence.getPluginConfig(KUJIRA_DEFAULT_MODEL_KEY);
      if (rawDefault) {
        try {
          this.configuredDefaultModel = JSON.parse(rawDefault);
        } catch {}
      }

      for (const rec of records) {
        if (rec.peer && rec.current_session_id) {
          if (rec.model_provider && rec.model_name) {
            this.selectionMap.set(rec.current_session_id, {
              current: {
                provider: rec.model_provider,
                model: rec.model_name,
                ...(rec.model_reasoning_effort ? { reasoningEffort: rec.model_reasoning_effort as any } : {}),
              },
              assembled: undefined,
            });
          }
        }
      }
    } catch {}
  }

  /**
   * 获取 DSH 宿主全局默认模型 (跟随 agentDefaultModel)
   */
  public getHostDefaultModelSelection(): ModelSelection {
    const defaultModelSvc =
      this.ctx?.get?.('agentDefaultModel') || (this.ctx as any)?.agentDefaultModel;
    if (defaultModelSvc && typeof defaultModelSvc.currentSelection === 'function') {
      try {
        const sel = defaultModelSvc.currentSelection();
        if (sel?.provider && sel?.model) {
          return {
            provider: sel.provider,
            model: sel.model,
            ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
          };
        }
      } catch {}
    }

    const llm = this.ctx?.get?.('llm') || (this.ctx as any)?.llm;
    if (llm && typeof llm.listProviders === 'function') {
      try {
        const providers = llm.listProviders();
        if (providers.length > 0) {
          const p = providers[0];
          const models = llm.listModels(p.id || p);
          if (models.length > 0) {
            return { provider: p.id || p, model: models[0]?.id || models[0] };
          }
        }
      } catch {}
    }

    return {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high' as any,
    };
  }

  /**
   * 动态解析指定模型的默认思考档位 (若模型不支持思考则返回 undefined)
   */
  public async resolveDefaultEffort(provider: string, model: string): Promise<string | undefined> {
    const llm = this.ctx?.get?.('llm') || (this.ctx as any)?.llm;
    if (llm && typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        if (info && info.reasoning && Array.isArray(info.reasoning.efforts) && info.reasoning.efforts.length > 0) {
          return info.reasoning.defaultEffort
            ? String(info.reasoning.defaultEffort)
            : String(info.reasoning.efforts[0]?.id);
        } else if (info && info.reasoning === undefined) {
          return undefined;
        }
      } catch {}
    }
    if (provider === 'deepseek-official') {
      return 'high';
    }
    return undefined;
  }

  /**
   * 探测指定提供商与模型在当前 DSH 环境中是否真实存在且可用
   */
  public async checkModelExists(provider: string, model: string): Promise<boolean> {
    const llm = this.ctx?.get?.('llm') || (this.ctx as any)?.llm;
    if (!llm) return false;
    try {
      if (typeof llm.listProviders === 'function') {
        const providers = llm.listProviders();
        if (Array.isArray(providers) && providers.length > 0) {
          const pHit = providers.some((p: any) => (p.id || p) === provider);
          if (!pHit) return false;
        }
      }
      if (typeof llm.listModels === 'function') {
        const models = llm.listModels(provider);
        if (Array.isArray(models) && models.length > 0) {
          return models.some((m: any) => (m.id || m) === model);
        }
      }
      if (typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(provider, model);
        return Boolean(info);
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * 获取用户显式配置的新建会话默认模型（未配置则返回 undefined）
   */
  public getConfiguredDefaultModel(): ModelSelection | undefined {
    if (this.configuredDefaultModel?.provider && this.configuredDefaultModel?.model) {
      return { ...this.configuredDefaultModel };
    }
    return undefined;
  }

  /**
   * 设置新建会话默认模型，仅持久化记录配置，绝不暴力改写现有其他活跃会话
   */
  public setConfiguredDefaultModel(
    provider: string,
    model: string,
    reasoningEffort?: any
  ): void {
    const sel: ModelSelection = {
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    this.configuredDefaultModel = sel;
    if (this.persistence) {
      this.persistence.setPluginConfig(KUJIRA_DEFAULT_MODEL_KEY, JSON.stringify(sel));
    }
  }

  /**
   * 获取新建会话生效的默认模型 (优先用户显式配置，否则回退到宿主全局默认)
   */
  public getDefaultModelSelection(): ModelSelection {
    const configured = this.getConfiguredDefaultModel();
    if (configured) {
      return configured;
    }
    return this.getHostDefaultModelSelection();
  }

  /**
   * 兼容性别名：获取 Kujira 插件默认模型
   */
  public getKujiraDefaultModel(): ModelSelection {
    return this.getDefaultModelSelection();
  }

  /**
   * 兼容性别名：设置 Kujira 插件默认模型（已重构为纯配置记录，不再暴力批量改写全场会话）
   */
  public setKujiraDefaultModel(
    provider: string,
    model: string,
    reasoningEffort?: any,
    _activeSessionIds?: string[]
  ): void {
    this.setConfiguredDefaultModel(provider, model, reasoningEffort);
  }

  public getOrCreateSelectionRef(sessionId: string): KujiraModelSelectionRef {
    let ref = this.selectionMap.get(sessionId);
    if (!ref) {
      ref = {
        current: this.getDefaultModelSelection(),
        assembled: undefined,
      };
      this.selectionMap.set(sessionId, ref);
    }
    return ref;
  }

  public setModelSelection(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: any,
    peer?: string,
    persistDb = true
  ): void {
    const ref = this.getOrCreateSelectionRef(sessionId);
    ref.current = {
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };

    if (persistDb && this.persistence && peer) {
      let state = this.persistence.getSessionState(peer);
      if (!state) {
        state = {
          peer,
          current_session_id: sessionId,
          cleared_round: 0,
          cleared_version: 1,
          updated_at: Date.now(),
        };
      }
      state.model_provider = provider;
      state.model_name = model;
      state.model_reasoning_effort = reasoningEffort ?? undefined;
      this.persistence.saveSessionState(state);
    }
  }

  public getModelSelection(sessionId: string): ModelSelection | undefined {
    const ref = this.getOrCreateSelectionRef(sessionId);
    return ref.current;
  }

  public getTrackedSessionIds(): string[] {
    return Array.from(this.selectionMap.keys());
  }

  public clear(): void {
    this.selectionMap.clear();
  }
}
