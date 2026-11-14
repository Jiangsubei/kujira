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

export class KujiraFormModel {
  private initialValues: Partial<BridgePluginConfig>;
  private draft: Partial<BridgePluginConfig>;
  private revision: number;
  private baseDefaults: Partial<BridgePluginConfig>;

  constructor(options: FormModelOptions = {}) {
    this.initialValues = { ...options.initialValues };
    this.draft = { ...options.initialValues };
    this.revision = options.revision ?? 0;
    this.baseDefaults = { ...options.baseDefaults };
  }

  setInitialValues(values: Partial<BridgePluginConfig>) {
    this.initialValues = { ...values };
    this.draft = { ...values };
  }

  setBaseDefaults(defaults: Partial<BridgePluginConfig>) {
    this.baseDefaults = { ...defaults };
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
      this.draft = { ...this.draft, [key]: this.baseDefaults[key] };
    } else {
      const next = { ...this.draft };
      delete next[key];
      this.draft = next;
    }
  }

  isOverridden<K extends keyof BridgePluginConfig>(key: K): boolean {
    const draftVal = this.draft[key];
    if (draftVal === undefined) return false;
    const defaultVal = this.baseDefaults[key];
    return draftVal !== defaultVal;
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
