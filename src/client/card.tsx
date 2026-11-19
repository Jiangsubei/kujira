import React from 'react';
import { cardStyle, sectionStyle, injectCardStyles } from './card-styles.js';
import { SafeIconChevronDown } from './icons.js';
import { useCardState } from './use-card-state.js';
import { SectionErrorBoundary } from './error-boundary.js';
import { ConnectionTab, ReplyTab, PersonaTab, MemoryTab, FaceTab, SlangTab, MoreTab } from './tabs/index.js';
import { DEFAULT_BASE_CONFIG } from '../constants/index.js';
import {
  SETTINGS_TABS,
  type SettingsTabId,
  type TabItem,
  type CardController,
  type CardProps,
  type SettingsSectionProps,
} from './types.js';

export {
  DEFAULT_BASE_CONFIG,
  SETTINGS_TABS,
  type SettingsTabId,
  type TabItem,
  type CardController,
  type CardProps,
  type SettingsSectionProps,
};

export function KujiraSettingsCard(props: CardProps): React.JSX.Element {
  injectCardStyles();
  const isSection = props.layoutMode === 'section';
  const state = useCardState(props, DEFAULT_BASE_CONFIG);
  const commonTabProps = {
    draft: state.draft,
    model: state.model,
    saving: state.saving,
    onFieldChange: state.handleFieldChange,
    onResetField: state.handleResetField,
  };

  const formContent = (
    <>
      <div className={cardStyle.tabBar} role="tablist" aria-label="设置分区">
        {SETTINGS_TABS.map((tab) => {
          const isSelected = state.activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`kujira-tab-${tab.id}`}
              data-testid={`kujira-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`kujira-tabpanel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              className={[cardStyle.tab, isSelected ? cardStyle.tabActive : ''].filter(Boolean).join(' ')}
              onClick={() => state.handleTabClick(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <ConnectionTab
        {...commonTabProps}
        active={state.activeTab === 'connection'}
        credentialsStatus={state.credentialsStatus}
        appIdInput={state.appIdInput}
        appSecretInput={state.appSecretInput}
        onAppIdChange={state.handleAppIdChange}
        onAppSecretChange={state.handleAppSecretChange}
      />
      <ReplyTab {...commonTabProps} active={state.activeTab === 'reply'} />
      <PersonaTab {...commonTabProps} active={state.activeTab === 'persona'} />
      <MemoryTab {...commonTabProps} active={state.activeTab === 'memory'} />
      <FaceTab {...commonTabProps} active={state.activeTab === 'face'} onError={state.updateError} />
      <SlangTab {...commonTabProps} active={state.activeTab === 'slang'} onError={state.updateError} />
      <MoreTab {...commonTabProps} active={state.activeTab === 'more'} />

      <div className={cardStyle.footer}>
        {state.errorMessage && <p className={cardStyle.failed} role="alert">{state.errorMessage}</p>}
        <button type="button" className={cardStyle.discard} disabled={state.blocked} onClick={state.handleDiscard}>
          放弃修改
        </button>
        <button type="button" className={cardStyle.save} disabled={state.blocked} onClick={state.handleSave}>
          {state.saving ? '保存中...' : '保存更改'}
        </button>
      </div>
    </>
  );

  if (isSection) {
    return (
      <div className={sectionStyle.section} data-testid="kujira-bridge-section">
        <div className={sectionStyle.head}>
          <div className={sectionStyle.titleRow}>
            <h2 className={sectionStyle.title}>QQ Kujira 机器人配置</h2>
            {state.isDirty && <span className={sectionStyle.badgePending}>未保存修改</span>}
            {state.remoteLoading && <span className={sectionStyle.badgePending}>加载中...</span>}
          </div>
          <p className={sectionStyle.description}>
            QQ 官方 Bot API v2 合规单聊 (C2C) 接入、双层记忆、表情资产、黑话学习与 Agent 对话桥接
          </p>
          {state.remoteLoadError && (
            <p className={cardStyle.failed} role="alert">配置加载异常：{state.remoteLoadError}</p>
          )}
        </div>
        <div className={sectionStyle.body}>{formContent}</div>
      </div>
    );
  }

  return (
    <div
      className={[cardStyle.card, state.expanded ? cardStyle.cardOpen : ''].filter(Boolean).join(' ')}
      data-testid="kujira-bridge-card"
    >
      <button
        type="button"
        className={cardStyle.header}
        aria-expanded={state.expanded}
        aria-label={`${state.expanded ? '收起' : '展开'}: QQ Kujira 机器人 (kujira)`}
        onClick={() => state.setExpanded(!state.expanded)}
      >
        <span className={cardStyle.headText}>
          <span className={cardStyle.name}>QQ Kujira 机器人 (kujira)</span>
          <span className={cardStyle.description}>
            QQ 官方 Bot API v2 合规单聊 (C2C) 接入、双层记忆、表情资产、黑话学习与 Agent 对话桥接
          </span>
        </span>
        {state.isDirty && <span className={cardStyle.badgePending}>未保存修改</span>}
        <SafeIconChevronDown
          className={[cardStyle.chevron, state.expanded ? cardStyle.chevronOpen : ''].filter(Boolean).join(' ')}
        />
      </button>

      {state.expanded && <div className={cardStyle.body}>{formContent}</div>}
    </div>
  );
}

export function KujiraSettingsSection(props: SettingsSectionProps): React.JSX.Element {
  return (
    <SectionErrorBoundary>
      <KujiraSettingsCard {...props} layoutMode="section" initialExpanded={true} />
    </SectionErrorBoundary>
  );
}
