import React from 'react';
import { ValueField } from '../fields.js';
import { cardStyle } from '../card-styles.js';
import type { BridgePluginConfig } from '../../types/index.js';
import {
  DEFAULT_MEMORY_DIR,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
} from '../../constants/index.js';
import type { KujiraFormModel } from '../model.js';

export interface MemoryTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function MemoryTab(props: MemoryTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField } = props;

  return (
    <div
      id="kujira-tabpanel-memory"
      data-testid="kujira-tabpanel-memory"
      role="tabpanel"
      aria-labelledby="kujira-tab-memory"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <ValueField
        id="kujira-memory-storage-dir"
        label="记忆存储目录 (memory_storage_dir)"
        hint={`Session 记忆与用户画像 Markdown 存储根目录 (默认 ${DEFAULT_MEMORY_DIR})`}
        placeholder={DEFAULT_MEMORY_DIR}
        value={draft.memory_storage_dir || DEFAULT_MEMORY_DIR}
        disabled={saving}
        overridden={model.isOverridden('memory_storage_dir')}
        onReset={() => onResetField('memory_storage_dir')}
        onChange={(val) => onFieldChange('memory_storage_dir', val)}
      />

      <ValueField
        id="kujira-user-profile-budget-chars"
        label="用户画像字符预算上限 (user_profile_budget_chars)"
        hint={`单个用户画像文件的写入上限，仅在当前单聊会话内隔离生效 (默认 ${DEFAULT_USER_PROFILE_BUDGET_CHARS})`}
        placeholder={String(DEFAULT_USER_PROFILE_BUDGET_CHARS)}
        numeric
        value={String(draft.user_profile_budget_chars ?? DEFAULT_USER_PROFILE_BUDGET_CHARS)}
        disabled={saving}
        overridden={model.isOverridden('user_profile_budget_chars')}
        onReset={() => onResetField('user_profile_budget_chars')}
        onChange={(val) =>
          onFieldChange('user_profile_budget_chars', parseInt(val, 10) || DEFAULT_USER_PROFILE_BUDGET_CHARS)
        }
      />

      <ValueField
        id="kujira-session-memory-budget-chars"
        label="Session 规则字符预算上限 (session_memory_budget_chars)"
        hint={`单个单聊会话规则文件的写入上限 (默认 ${DEFAULT_SESSION_MEMORY_BUDGET_CHARS})`}
        placeholder={String(DEFAULT_SESSION_MEMORY_BUDGET_CHARS)}
        numeric
        value={String(draft.session_memory_budget_chars ?? DEFAULT_SESSION_MEMORY_BUDGET_CHARS)}
        disabled={saving}
        overridden={model.isOverridden('session_memory_budget_chars')}
        onReset={() => onResetField('session_memory_budget_chars')}
        onChange={(val) =>
          onFieldChange('session_memory_budget_chars', parseInt(val, 10) || DEFAULT_SESSION_MEMORY_BUDGET_CHARS)
        }
      />
    </div>
  );
}
