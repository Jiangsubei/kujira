import type React from 'react';
import type { BridgePluginConfig, CredentialStatusSummary } from '../types/index.js';
import type { KujiraFormModel } from './model.js';

export type SettingsTabId =
  | 'connection'
  | 'reply'
  | 'persona'
  | 'memory'
  | 'face'
  | 'slang'
  | 'more';

export interface TabItem {
  id: SettingsTabId;
  label: string;
}

export const SETTINGS_TABS: readonly TabItem[] = [
  { id: 'connection', label: '常规' },
  { id: 'reply', label: '回复节奏' },
  { id: 'persona', label: '人格与准则' },
  { id: 'memory', label: '记忆' },
  { id: 'face', label: '表情包' },
  { id: 'slang', label: '黑话学习' },
  { id: 'more', label: '更多配置' },
] as const;

export interface CredentialsInputPayload {
  app_id?: string;
  app_secret?: string;
}

export type SaveSettingsPayload = Partial<BridgePluginConfig> & {
  credentials?: CredentialsInputPayload;
  clear_credentials?: Array<'app_id' | 'app_secret'>;
};

export interface SaveSettingsResult {
  revision?: number;
  credentials?: CredentialStatusSummary;
}

export interface CardController {
  activeTab: SettingsTabId;
  setActiveTab: (tab: SettingsTabId) => void;
  model: KujiraFormModel;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  isDirty: boolean;
  saving: boolean;
  errorMessage: string | null;
  credentialsStatus: CredentialStatusSummary;
  appIdInput: string;
  appSecretInput: string;
  handleAppIdChange: (val: string) => void;
  handleAppSecretChange: (val: string) => void;
  handleFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  handleResetField: (key: keyof BridgePluginConfig) => void;
  handleDiscard: () => void;
  handleSave: () => Promise<void>;
}

export interface CardProps {
  layoutMode?: 'card' | 'section';
  initialConfig?: Partial<BridgePluginConfig>;
  credentialsStatus?: CredentialStatusSummary;
  revision?: number;
  baseDefaults?: Partial<BridgePluginConfig>;
  initialExpanded?: boolean;
  initialTab?: SettingsTabId;
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
  controllerRef?:
    | React.MutableRefObject<CardController | null>
    | ((controller: CardController) => void);
  onSaveSettings?: (
    values: SaveSettingsPayload,
    options: { expectedRevision: number }
  ) => Promise<SaveSettingsResult | void>;
}

export interface SettingsSectionProps extends CardProps {
  close?: () => void;
}
