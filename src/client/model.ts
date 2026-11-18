import type { BridgePluginConfig } from '../types/index.js';
import type { SaveSettingsPayload, SaveSettingsResult } from './types.js';

export class SettingsConflictError extends Error {
  public code = 'SETTINGS_CONFLICT';
  constructor(message = 'Settings revision conflict') {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

export interface FormModelOptions {
  initialValues?: Partial<BridgePluginConfig>;
  revision?: number;
  baseDefaults?: Partial<BridgePluginConfig>;
}

function isBlankFallbackKey(key: keyof BridgePluginConfig): boolean {
  return key === 'persona' || key === 'behavior';
}

export class KujiraFormModel {
  private initialValues: Partial<BridgePluginConfig>;
  private draft: Partial<BridgePluginConfig>;
  private revision: number;
  private baseDefaults: Partial<BridgePluginConfig>;

  constructor(options: FormModelOptions = {}) {
    this.revision = options.revision ?? 0;
    this.baseDefaults = { ...options.baseDefaults };
    const sanitized = this.sanitizeInitialValues(options.initialValues, options.baseDefaults);
    this.initialValues = sanitized;
    this.draft = { ...sanitized };
  }

  private sanitizeInitialValues(
    values?: Partial<BridgePluginConfig>,
    baseDefaults?: Partial<BridgePluginConfig>
  ): Partial<BridgePluginConfig> {
    const out = { ...values };
    const defaults = baseDefaults || this.baseDefaults || {};
    for (const key of ['persona', 'behavior'] as const) {
      if (typeof out[key] === 'string' && out[key]!.trim() === '') {
        if (defaults[key] !== undefined) {
          out[key] = defaults[key];
        } else {
          delete out[key];
        }
      }
    }
    return out;
  }

  setInitialValues(values: Partial<BridgePluginConfig>) {
    const sanitized = this.sanitizeInitialValues(values);
    this.initialValues = sanitized;
    this.draft = { ...sanitized };
  }

  setBaseDefaults(defaults: Partial<BridgePluginConfig>) {
    this.baseDefaults = { ...defaults };
    const sanitized = this.sanitizeInitialValues(this.initialValues, defaults);
    this.initialValues = sanitized;
    if (typeof this.draft.persona === 'string' && this.draft.persona.trim() === '') {
      if (defaults.persona) this.draft.persona = defaults.persona;
    }
    if (typeof this.draft.behavior === 'string' && this.draft.behavior.trim() === '') {
      if (defaults.behavior) this.draft.behavior = defaults.behavior;
    }
  }

  markClean() {
    this.initialValues = { ...this.draft };
  }

  setRevision(revision: number) {
    this.revision = revision;
  }

  getRevision(): number {
    return this.revision;
  }

  getDraft(): Partial<BridgePluginConfig> {
    return this.draft;
  }

  setField<K extends keyof BridgePluginConfig>(key: K, value: BridgePluginConfig[K]) {
    this.draft = { ...this.draft, [key]: value };
  }

  resetField<K extends keyof BridgePluginConfig>(key: K) {
    if (this.baseDefaults[key] !== undefined) {
      const defVal = this.baseDefaults[key];
      this.draft = {
        ...this.draft,
        [key]: Array.isArray(defVal) ? ([...defVal] as BridgePluginConfig[K]) : defVal,
      };
    } else {
      const next = { ...this.draft };
      delete next[key];
      this.draft = next;
    }
  }

  isOverridden<K extends keyof BridgePluginConfig>(key: K): boolean {
    const draftVal = this.draft[key];
    if (draftVal === undefined) return false;
    if (isBlankFallbackKey(key) && typeof draftVal === 'string' && draftVal.trim() === '') {
      return false;
    }
    const defaultVal = this.baseDefaults[key];
    if (Array.isArray(draftVal) || Array.isArray(defaultVal)) {
      return JSON.stringify(draftVal || []) !== JSON.stringify(defaultVal || []);
    }
    return draftVal !== defaultVal;
  }

  normalizeDraft(): Partial<BridgePluginConfig> {
    const normalized = { ...this.draft };
    for (const key of ['persona', 'behavior'] as const) {
      if (typeof normalized[key] === 'string' && normalized[key]!.trim() === '') {
        if (this.baseDefaults[key] !== undefined) {
          normalized[key] = this.baseDefaults[key];
        }
      }
    }
    this.draft = normalized;
    return normalized;
  }

  isDirty(): boolean {
    const keys = Array.from(
      new Set([...Object.keys(this.initialValues), ...Object.keys(this.draft)])
    ) as Array<keyof BridgePluginConfig>;

    for (const key of keys) {
      const initVal = this.initialValues[key];
      const draftVal = this.draft[key];
      if (Array.isArray(initVal) || Array.isArray(draftVal)) {
        if (JSON.stringify(initVal || []) !== JSON.stringify(draftVal || [])) {
          return true;
        }
      } else if (initVal !== draftVal) {
        return true;
      }
    }
    return false;
  }

  discard() {
    this.draft = { ...this.initialValues };
  }

  async save(callbacks: {
    saveSettings: (
      values: SaveSettingsPayload,
      options: { expectedRevision: number }
    ) => Promise<SaveSettingsResult | void>;
    extraPayload?: Omit<SaveSettingsPayload, keyof BridgePluginConfig>;
  }): Promise<SaveSettingsResult | void> {
    this.normalizeDraft();
    const payload: SaveSettingsPayload = {
      ...this.draft,
      ...(callbacks.extraPayload || {}),
    };
    const res = await callbacks.saveSettings(payload, {
      expectedRevision: this.revision,
    });
    if (res && typeof res.revision === 'number') {
      this.revision = res.revision;
    }
    this.initialValues = { ...this.draft };
    return res;
  }
}
