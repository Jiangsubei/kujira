import React, { useState, useEffect, useRef } from 'react';
import { ValueField, SegmentedField } from '../fields.js';
import { cardStyle, fieldStyle } from '../card-styles.js';
import {
  PeerListEditor,
  useKnownPeersPolling,
  type KnownPeerSummary,
} from '../components/PeerListEditor.js';
import type {
  BridgePluginConfig,
  CredentialSlotStatus,
  CredentialStatusSummary,
  PrivacyToolsListMode,
} from '../../types/index.js';
import {
  DEFAULT_IMAGE_TTL_DAYS,
  DEFAULT_ADMINS,
  DEFAULT_PRIVACY_TOOLS_LIST_MODE,
  DEFAULT_PRIVACY_TOOLS_BLACKLIST,
  DEFAULT_PRIVACY_TOOLS_WHITELIST,
} from '../../constants/index.js';
import type { KujiraFormModel } from '../model.js';

const PRIVACY_TOOLS_LIST_MODE_OPTIONS: Array<{ value: PrivacyToolsListMode; label: string }> = [
  { value: 'blacklist', label: '黑名单模式' },
  { value: 'whitelist', label: '白名单模式' },
];

function normalizeNonEmptyPeers(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/**
 * 判断草稿中是否已配置了非默认的管理员名单或隐私工具隔离规则。
 * 只要满足以下任一项即返回 true（打开设置且用户未手动折叠时默认展开，避免隐形生效）：
 * - admins 非空
 * - privacy_tools_list_mode === 'whitelist'
 * - privacy_tools_blacklist 非空
 * - privacy_tools_whitelist 非空
 */
export function hasCustomAccessControlConfig(draft: Partial<BridgePluginConfig>): boolean {
  if (normalizeNonEmptyPeers(draft.admins).length > 0) return true;
  if (draft.privacy_tools_list_mode === 'whitelist') return true;
  if (normalizeNonEmptyPeers(draft.privacy_tools_blacklist).length > 0) return true;
  if (normalizeNonEmptyPeers(draft.privacy_tools_whitelist).length > 0) return true;
  return false;
}

export interface ConnectionTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  credentialsStatus: CredentialStatusSummary;
  appIdInput: string;
  appSecretInput: string;
  /** 可选初始已互动用户列表（供 SSR 与契约测试注入） */
  initialKnownPeers?: KnownPeerSummary[];
  /** 可选初始是否展开「更多选项」面板（供 SSR 与契约测试验证展开态） */
  initialAccessControlExpanded?: boolean;
  /** 可选初始是否展开管理员内联添加行（供 SSR 与契约测试验证编辑态） */
  initialAddingAdmin?: boolean;
  /** 可选初始是否展开隐私工具隔离名单内联添加行（供 SSR 与契约测试验证编辑态） */
  initialAddingPrivacyPeer?: boolean;
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
    initialKnownPeers,
    initialAccessControlExpanded,
    initialAddingAdmin,
    initialAddingPrivacyPeer,
    onAppIdChange,
    onAppSecretChange,
    onFieldChange,
    onResetField,
  } = props;

  const hasCustomAccessControl = hasCustomAccessControlConfig(draft);
  const [accessControlExpanded, setAccessControlExpanded] = useState<boolean>(
    () => initialAccessControlExpanded ?? hasCustomAccessControl
  );
  const userToggledRef = useRef<boolean>(initialAccessControlExpanded !== undefined);
  const [isAddingAdmin, setIsAddingAdmin] = useState<boolean>(Boolean(initialAddingAdmin));
  const [isAddingPrivacyPeer, setIsAddingPrivacyPeer] = useState<boolean>(
    Boolean(initialAddingPrivacyPeer)
  );

  // 异步远程配置加载完成后，若检测到已配置非默认权限/隐私隔离规则且用户尚未手动折叠，自动展开
  useEffect(() => {
    if (!userToggledRef.current && hasCustomAccessControl) {
      setAccessControlExpanded(true);
    }
  }, [hasCustomAccessControl]);

  // 仅在处于本 Tab 且展开「更多选项」时开启 /plugins/kujira/peers 5 秒轮询
  const { knownPeers, nowTs } = useKnownPeersPolling(
    active && accessControlExpanded,
    initialKnownPeers
  );

  const selectedAdmins = normalizeNonEmptyPeers(draft.admins ?? DEFAULT_ADMINS);

  const privacyListMode: PrivacyToolsListMode =
    draft.privacy_tools_list_mode === 'whitelist'
      ? 'whitelist'
      : DEFAULT_PRIVACY_TOOLS_LIST_MODE;
  const activePrivacyListKey: 'privacy_tools_blacklist' | 'privacy_tools_whitelist' =
    privacyListMode === 'whitelist' ? 'privacy_tools_whitelist' : 'privacy_tools_blacklist';
  const selectedPrivacyPeers = normalizeNonEmptyPeers(
    draft[activePrivacyListKey] ??
      (privacyListMode === 'whitelist'
        ? DEFAULT_PRIVACY_TOOLS_WHITELIST
        : DEFAULT_PRIVACY_TOOLS_BLACKLIST)
  );

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

      <div
        id="kujira-access-control-more-section"
        data-testid="kujira-access-control-more-section"
        className={fieldStyle.peerFilterSection}
      >
        <button
          id="kujira-access-control-more-toggle"
          type="button"
          className={fieldStyle.moreToggle}
          aria-expanded={accessControlExpanded}
          aria-controls="kujira-access-control-panel"
          disabled={saving}
          onClick={() => {
            userToggledRef.current = true;
            setAccessControlExpanded((prev) => {
              const next = !prev;
              if (!next) {
                setIsAddingAdmin(false);
                setIsAddingPrivacyPeer(false);
              }
              return next;
            });
          }}
        >
          <span aria-hidden="true">{accessControlExpanded ? '▾' : '▸'}</span>
          <span>更多选项</span>
        </button>

        {accessControlExpanded && (
          <div
            id="kujira-access-control-panel"
            data-testid="kujira-access-control-panel"
            className={fieldStyle.peerFilterBox}
          >
            <PeerListEditor
              idPrefix="kujira-admins"
              label="管理员名单 (admins)"
              addButtonTitle="添加管理员"
              hint="默认未配置时视为 1 对 1 场景（所有单聊用户均具备完整权限）；配置后仅名单内用户可审批敏感工具以及使用 /权限、/模型 -默认、/思考 -默认。首次配置请先向机器人发一条消息，即可在列表中识别并添加自己；保存后对已有会话热生效。"
              emptyHint="暂未配置，默认按 1 对 1 场景对所有单聊用户开放完整权限。"
              selectedPeers={selectedAdmins}
              knownPeers={knownPeers}
              nowTs={nowTs}
              saving={saving}
              overridden={model.isOverridden('admins')}
              adding={isAddingAdmin}
              onAddingChange={setIsAddingAdmin}
              onAdd={(peer) => onFieldChange('admins', [...selectedAdmins, peer])}
              onRemove={(peer) =>
                onFieldChange(
                  'admins',
                  selectedAdmins.filter((p) => p !== peer)
                )
              }
              onReset={() => onResetField('admins')}
            />

            <SegmentedField
              id="kujira-privacy-tools-list-mode"
              label="隔离可能泄露隐私的工具 (privacy_tools_list_mode)"
              hint={
                privacyListMode === 'whitelist'
                  ? '白名单模式：仅下方名单内的用户可使用 Shell/文件/目录/环境/技能等可能泄露隐私的工具（保留发文件与识图等聊天工具），其余用户一律隔离；保存后热生效'
                  : '黑名单模式：排除下方名单内的用户（对其隔离 Shell/文件/目录/环境/技能等可能泄露隐私的工具，保留发文件与识图等聊天工具），其余用户正常使用；保存后热生效'
              }
              value={privacyListMode}
              options={PRIVACY_TOOLS_LIST_MODE_OPTIONS}
              disabled={saving}
              overridden={model.isOverridden('privacy_tools_list_mode')}
              onReset={() => {
                setIsAddingPrivacyPeer(false);
                onResetField('privacy_tools_list_mode');
              }}
              onChange={(val) => {
                setIsAddingPrivacyPeer(false);
                onFieldChange('privacy_tools_list_mode', val);
              }}
            />

            <PeerListEditor
              idPrefix="kujira-privacy-tools-peer"
              label={
                privacyListMode === 'whitelist'
                  ? '白名单用户 (privacy_tools_whitelist)'
                  : '黑名单用户 (privacy_tools_blacklist)'
              }
              addButtonTitle={
                privacyListMode === 'whitelist' ? '添加白名单用户' : '添加黑名单用户'
              }
              emptyHint={
                privacyListMode === 'whitelist'
                  ? '暂未配置，所有单聊会话都会隔离可能泄露隐私的工具。'
                  : '暂未配置，所有单聊会话均保留完整工具。'
              }
              selectedPeers={selectedPrivacyPeers}
              knownPeers={knownPeers}
              nowTs={nowTs}
              saving={saving}
              overridden={model.isOverridden(activePrivacyListKey)}
              adding={isAddingPrivacyPeer}
              onAddingChange={setIsAddingPrivacyPeer}
              onAdd={(peer) => onFieldChange(activePrivacyListKey, [...selectedPrivacyPeers, peer])}
              onRemove={(peer) =>
                onFieldChange(
                  activePrivacyListKey,
                  selectedPrivacyPeers.filter((p) => p !== peer)
                )
              }
              onReset={() => onResetField(activePrivacyListKey)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
