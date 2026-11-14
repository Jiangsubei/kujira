import React from 'react';
import { ValueField } from '../fields.js';
import { cardStyle, fieldStyle } from '../card-styles.js';
import type {
  BridgePluginConfig,
  CredentialSlotStatus,
  CredentialStatusSummary,
} from '../../types/index.js';
import { DEFAULT_IMAGE_TTL_DAYS } from '../../constants/index.js';
import type { KujiraFormModel } from '../model.js';

export interface ConnectionTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  credentialsStatus: CredentialStatusSummary;
  appIdInput: string;
  appSecretInput: string;
  onAppIdChange: (val: string) => void;
  onAppSecretChange: (val: string) => void;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

function renderCredentialBadge(slot: CredentialSlotStatus): React.JSX.Element {
  if (slot.configured) {
    const sourceSuffix = slot.source ? ` (来源: ${slot.source})` : '';
    return <span className={fieldStyle.badge}>{`已配置${sourceSuffix}`}</span>;
  }
  return <span className={fieldStyle.badgeMuted}>未配置</span>;
}

export function ConnectionTab(props: ConnectionTabProps): React.JSX.Element {
  const {
    active,
    draft,
    model,
    saving,
    credentialsStatus,
    appIdInput,
    appSecretInput,
    onAppIdChange,
    onAppSecretChange,
    onFieldChange,
    onResetField,
  } = props;

  return (
    <div
      id="kujira-tabpanel-connection"
      data-testid="kujira-tabpanel-connection"
      role="tabpanel"
      aria-labelledby="kujira-tab-connection"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <ValueField
        id="kujira-cred-app-id"
        label="Bot AppID (QQ_BOT_APP_ID)"
        hint={
          credentialsStatus.appId.configured
            ? '当前已配置 AppID；采用只写保护（绝不回显明文），留空将保留现有凭据，输入新值将持久化至 DSH 凭据库并触发重连'
            : '请填写 QQ 开放平台机器人 AppID（安全存储于 DSH .credentials.yaml，不会写入普通配置文件）'
        }
        placeholder={
          credentialsStatus.appId.configured
            ? '已配置（只写保护，留空保持不变）'
            : '请输入 QQ Bot AppID'
        }
        inputType="text"
        autoComplete="off"
        value={appIdInput}
        disabled={saving}
        statusBadge={renderCredentialBadge(credentialsStatus.appId)}
        onChange={onAppIdChange}
      />

      <ValueField
        id="kujira-cred-app-secret"
        label="Bot AppSecret (QQ_BOT_SECRET)"
        hint={
          credentialsStatus.appSecret.configured
            ? '当前已配置 AppSecret；采用只写保护（绝不回显明文），留空将保留现有密钥，输入新值将覆盖更新并触发重连'
            : '请填写 QQ 开放平台机器人 AppSecret（安全存储于 DSH .credentials.yaml）'
        }
        placeholder={
          credentialsStatus.appSecret.configured
            ? '已配置（只写保护，留空保持不变）'
            : '请输入 QQ Bot AppSecret'
        }
        inputType="password"
        autoComplete="new-password"
        value={appSecretInput}
        disabled={saving}
        statusBadge={renderCredentialBadge(credentialsStatus.appSecret)}
        onChange={onAppSecretChange}
      />

      <ValueField
        id="kujira-image-ttl"
        label="多媒体文件缓存 TTL 天数 (image_ttl_days)"
        hint="接收与生成的图片/音视频/文件在本地的保留天数，过期定时自动清理 (默认 7)"
        placeholder={String(DEFAULT_IMAGE_TTL_DAYS)}
        numeric
        value={String(draft.image_ttl_days ?? DEFAULT_IMAGE_TTL_DAYS)}
        disabled={saving}
        overridden={model.isOverridden('image_ttl_days')}
        onReset={() => onResetField('image_ttl_days')}
        onChange={(val) => onFieldChange('image_ttl_days', parseInt(val, 10) || DEFAULT_IMAGE_TTL_DAYS)}
      />
    </div>
  );
}
