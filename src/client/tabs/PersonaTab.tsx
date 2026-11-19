import React from 'react';
import { TextAreaField } from '../fields.js';
import { cardStyle } from '../card-styles.js';
import type { BridgePluginConfig } from '../../types/index.js';
import type { KujiraFormModel } from '../model.js';

export interface PersonaTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function PersonaTab(props: PersonaTabProps): React.JSX.Element {
  const { active, draft, model, saving, onFieldChange, onResetField } = props;

  return (
    <div
      id="kujira-tabpanel-persona"
      data-testid="kujira-tabpanel-persona"
      role="tabpanel"
      aria-labelledby="kujira-tab-persona"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <TextAreaField
        id="kujira-persona"
        label="助手人设"
        hint="注入 Agent 动态 System Prompt 的角色设定 (保护静态 KV 缓存)"
        placeholder="例如: 你是一个得力的 QQ 单聊智能助手..."
        value={draft.persona || ''}
        disabled={saving}
        overridden={model.isOverridden('persona')}
        onReset={() => onResetField('persona')}
        onChange={(val) => onFieldChange('persona', val)}
      />

      <TextAreaField
        id="kujira-behavior"
        label="行为准则"
        hint="注入 Agent 动态 System Prompt 的行为准则与回答风格要求"
        placeholder="例如: 回答请清晰精炼，必要时调用 read_chat_history 查询近期单聊上下文..."
        value={draft.behavior || ''}
        disabled={saving}
        overridden={model.isOverridden('behavior')}
        onReset={() => onResetField('behavior')}
        onChange={(val) => onFieldChange('behavior', val)}
      />
    </div>
  );
}
