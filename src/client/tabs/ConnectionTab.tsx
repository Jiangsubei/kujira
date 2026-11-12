import React from 'react';
import { ValueField, SwitchField } from '../fields.js';
import { cardStyle, fieldStyle } from '../card-styles.js';
import type {
  BridgePluginConfig,
  CredentialSlotStatus,
  CredentialStatusSummary,
} from '../../types/index.js';
import {
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_NEW_MESSAGE_BEHAVIOR,
  DEFAULT_AGGREGATION_INTERVAL_MINS,
  DEFAULT_IDLE_REPLY_TIMEOUT_MINS,
} from '../../constants/index.js';
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

      <div className={fieldStyle.field}>
        <div className={fieldStyle.head}>
          <label htmlFor="kujira-new-message-behavior" className={fieldStyle.label}>
            新消息行为 (new_message_behavior)
          </label>
          {model.isOverridden('new_message_behavior') && (
            <div className={fieldStyle.badges}>
              <span className={fieldStyle.badge}>已自定义</span>
              <button
                type="button"
                className={fieldStyle.reset}
                onClick={() => onResetField('new_message_behavior')}
              >
                重置
              </button>
            </div>
          )}
        </div>
        <select
          id="kujira-new-message-behavior"
          className={fieldStyle.input}
          disabled={saving}
          value={draft.new_message_behavior || DEFAULT_NEW_MESSAGE_BEHAVIOR}
          onChange={(e) => onFieldChange('new_message_behavior', e.target.value as any)}
        >
          <option value="steer">及时插话 (steer) - 等待当前 Step 完成后立即接纳新消息并调整行动</option>
          <option value="queue">加入队列 (queue) - 等待当前轮次（Turn）完全结束后依次排队执行</option>
        </select>
        <p className={fieldStyle.hint}>
          一轮 Agent 循环正在进行时收到单聊新消息的处理行为。即时对话场景推荐「及时插话」。
        </p>
      </div>

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

      <SwitchField
        id="kujira-aggregation-enabled"
        label="连续消息聚合回复 (aggregation_enabled)"
        hint={
          draft.aggregation_enabled
            ? '用户连续发送的多条消息会先收集起来，攒满下方时长后合并成一轮由模型一次性回复；等待用户答题或审批期间自动暂停计时'
            : '开启后，用户连续发送的多条消息不再逐条即时回复，而是收集一段时间后合并成一轮一次性回复'
        }
        checked={draft.aggregation_enabled ?? false}
        disabled={saving}
        overridden={model.isOverridden('aggregation_enabled')}
        onReset={() => onResetField('aggregation_enabled')}
        onChange={(checked) => onFieldChange('aggregation_enabled', checked)}
      />

      <ValueField
        id="kujira-aggregation-interval-mins"
        label="聚合收集时长 (aggregation_interval_mins)"
        hint={`新消息到达后先收集多少分钟，到期再统一交给模型回复 (默认 ${DEFAULT_AGGREGATION_INTERVAL_MINS} 分钟)`}
        placeholder={String(DEFAULT_AGGREGATION_INTERVAL_MINS)}
        numeric
        value={String(draft.aggregation_interval_mins ?? DEFAULT_AGGREGATION_INTERVAL_MINS)}
        disabled={saving || !draft.aggregation_enabled}
        overridden={model.isOverridden('aggregation_interval_mins')}
        onReset={() => onResetField('aggregation_interval_mins')}
        onChange={(val) =>
          onFieldChange(
            'aggregation_interval_mins',
            parseInt(val, 10) || DEFAULT_AGGREGATION_INTERVAL_MINS
          )
        }
      />

      <SwitchField
        id="kujira-idle-reply-enabled"
        label="冷场主动搭话 (idle_reply_enabled)"
        hint={
          draft.idle_reply_enabled
            ? '长时间没有新消息时，由模型自主判断是否主动发起话题；等待用户答题或审批期间同样暂停计时'
            : '开启后，单聊长时间无新消息时模型会主动找话题；需存在可用的被动回复锚点才会发信'
        }
        checked={draft.idle_reply_enabled ?? false}
        disabled={saving}
        overridden={model.isOverridden('idle_reply_enabled')}
        onReset={() => onResetField('idle_reply_enabled')}
        onChange={(checked) => onFieldChange('idle_reply_enabled', checked)}
      />

      <ValueField
        id="kujira-idle-reply-timeout-mins"
        label="冷场判定阈值 (idle_reply_timeout_mins)"
        hint={`连续多少分钟没有新消息视为冷场 (默认 ${DEFAULT_IDLE_REPLY_TIMEOUT_MINS} 分钟)`}
        placeholder={String(DEFAULT_IDLE_REPLY_TIMEOUT_MINS)}
        numeric
        value={String(draft.idle_reply_timeout_mins ?? DEFAULT_IDLE_REPLY_TIMEOUT_MINS)}
        disabled={saving || !draft.idle_reply_enabled}
        overridden={model.isOverridden('idle_reply_timeout_mins')}
        onReset={() => onResetField('idle_reply_timeout_mins')}
        onChange={(val) =>
          onFieldChange(
            'idle_reply_timeout_mins',
            parseInt(val, 10) || DEFAULT_IDLE_REPLY_TIMEOUT_MINS
          )
        }
      />
    </div>
  );
}
