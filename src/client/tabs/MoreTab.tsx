import React, { useState, useEffect, useRef } from 'react';
import { SwitchField, SegmentedField } from '../fields.js';
import { cardStyle, fieldStyle } from '../card-styles.js';
import {
  PeerListEditor,
  useKnownPeersPolling,
  type KnownPeerSummary,
} from '../components/PeerListEditor.js';
import type {
  BridgePluginConfig,
  PrivacyToolsListMode,
  IdleReplyListMode,
} from '../../types/index.js';
import {
  DEFAULT_ADMINS,
  DEFAULT_PRIVACY_TOOLS_ENABLED,
  DEFAULT_PRIVACY_TOOLS_LIST_MODE,
  DEFAULT_PRIVACY_TOOLS_BLACKLIST,
  DEFAULT_PRIVACY_TOOLS_WHITELIST,
  DEFAULT_IDLE_REPLY_ENABLED,
  DEFAULT_IDLE_REPLY_LIST_MODE,
  DEFAULT_IDLE_REPLY_BLACKLIST,
  DEFAULT_IDLE_REPLY_WHITELIST,
} from '../../constants/index.js';
import type { KujiraFormModel } from '../model.js';

const PRIVACY_TOOLS_LIST_MODE_OPTIONS: Array<{ value: PrivacyToolsListMode; label: string }> = [
  { value: 'whitelist', label: '白名单模式' },
  { value: 'blacklist', label: '黑名单模式' },
];

const IDLE_REPLY_LIST_MODE_OPTIONS: Array<{ value: IdleReplyListMode; label: string }> = [
  { value: 'blacklist', label: '黑名单模式' },
  { value: 'whitelist', label: '白名单模式' },
];

function normalizeNonEmptyPeers(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/**
 * 判断草稿中是否已配置了非默认的冷场搭话名单规则。
 * 只要切换为白名单模式或任一名单非空即返回 true。
 */
export function hasCustomIdleReplyFilterConfig(draft: Partial<BridgePluginConfig>): boolean {
  if (draft.idle_reply_list_mode === 'whitelist') return true;
  if (normalizeNonEmptyPeers(draft.idle_reply_blacklist).length > 0) return true;
  if (normalizeNonEmptyPeers(draft.idle_reply_whitelist).length > 0) return true;
  return false;
}

export interface MoreTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  /** 可选初始已互动用户列表（供 SSR 与契约测试注入） */
  initialKnownPeers?: KnownPeerSummary[];
  /** 可选初始是否展开管理员内联添加行（供 SSR 与契约测试验证编辑态） */
  initialAddingAdmin?: boolean;
  /** 可选初始是否展开隐私工具隔离名单内联添加行（供 SSR 与契约测试验证编辑态） */
  initialAddingPrivacyPeer?: boolean;
  /** 可选初始是否开启冷场搭话名单过滤开关（供 SSR 与契约测试验证） */
  initialIdleFilterEnabled?: boolean;
  /** 可选初始是否展开冷场搭话名单内联添加行（供 SSR 与契约测试验证编辑态） */
  initialAddingIdlePeer?: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function MoreTab(props: MoreTabProps): React.JSX.Element {
  const {
    active,
    draft,
    model,
    saving,
    initialKnownPeers,
    initialAddingAdmin,
    initialAddingPrivacyPeer,
    initialIdleFilterEnabled,
    initialAddingIdlePeer,
    onFieldChange,
    onResetField,
  } = props;

  const [isAddingAdmin, setIsAddingAdmin] = useState<boolean>(Boolean(initialAddingAdmin));
  const [isAddingPrivacyPeer, setIsAddingPrivacyPeer] = useState<boolean>(
    Boolean(initialAddingPrivacyPeer)
  );
  const [isAddingIdlePeer, setIsAddingIdlePeer] = useState<boolean>(
    Boolean(initialAddingIdlePeer)
  );

  // 停留在更多配置 Tab 时自动拉取并每 5 秒轮询已互动用户列表，供管理员、隐私隔离与冷场搭话名单共用
  const { knownPeers, nowTs } = useKnownPeersPolling(active, initialKnownPeers);

  // 1. 管理员名单
  const selectedAdmins = normalizeNonEmptyPeers(draft.admins ?? DEFAULT_ADMINS);

  // 2. 隔离可能泄露隐私的工具
  const privacyToolsEnabled = Boolean(
    draft.privacy_tools_enabled ?? DEFAULT_PRIVACY_TOOLS_ENABLED
  );
  const privacyListMode: PrivacyToolsListMode =
    draft.privacy_tools_list_mode === 'blacklist'
      ? 'blacklist'
      : DEFAULT_PRIVACY_TOOLS_LIST_MODE;
  const activePrivacyListKey: 'privacy_tools_blacklist' | 'privacy_tools_whitelist' =
    privacyListMode === 'blacklist' ? 'privacy_tools_blacklist' : 'privacy_tools_whitelist';
  const selectedPrivacyPeers = normalizeNonEmptyPeers(
    draft[activePrivacyListKey] ??
      (privacyListMode === 'blacklist'
        ? DEFAULT_PRIVACY_TOOLS_BLACKLIST
        : DEFAULT_PRIVACY_TOOLS_WHITELIST)
  );

  // 3. 冷场主动搭话名单过滤
  const idleReplyEnabled = Boolean(
    draft.idle_reply_enabled ?? DEFAULT_IDLE_REPLY_ENABLED
  );
  const hasCustomIdleFilter = hasCustomIdleReplyFilterConfig(draft);
  const [idleFilterEnabled, setIdleFilterEnabled] = useState<boolean>(
    () => initialIdleFilterEnabled ?? hasCustomIdleFilter
  );
  const userToggledIdleFilterRef = useRef<boolean>(initialIdleFilterEnabled !== undefined);

  useEffect(() => {
    if (!userToggledIdleFilterRef.current && hasCustomIdleFilter) {
      setIdleFilterEnabled(true);
    }
  }, [hasCustomIdleFilter]);

  const idleListMode: IdleReplyListMode =
    draft.idle_reply_list_mode === 'whitelist' ? 'whitelist' : DEFAULT_IDLE_REPLY_LIST_MODE;
  const activeIdleListKey: 'idle_reply_blacklist' | 'idle_reply_whitelist' =
    idleListMode === 'whitelist' ? 'idle_reply_whitelist' : 'idle_reply_blacklist';
  const selectedIdlePeers = normalizeNonEmptyPeers(
    draft[activeIdleListKey] ??
      (idleListMode === 'whitelist'
        ? DEFAULT_IDLE_REPLY_WHITELIST
        : DEFAULT_IDLE_REPLY_BLACKLIST)
  );

  const isIdleFilterOverridden =
    model.isOverridden('idle_reply_list_mode') ||
    model.isOverridden('idle_reply_blacklist') ||
    model.isOverridden('idle_reply_whitelist');

  return (
    <div
      id="kujira-tabpanel-more"
      data-testid="kujira-tabpanel-more"
      role="tabpanel"
      aria-labelledby="kujira-tab-more"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
      <PeerListEditor
        idPrefix="kujira-admins"
        label="管理员名单"
        addButtonTitle="添加管理员"
        hint={
          selectedAdmins.length > 0
            ? '仅上方名单内用户可审批敏感工具以及使用 /权限、/模型 -默认、/思考 -默认；保存后对已有会话热生效。'
            : undefined
        }
        emptyHint="暂未配置，默认按 1 对 1 场景对所有单聊用户开放完整权限。配置后仅名单内用户可审批敏感工具及使用 /权限、/模型 -默认、/思考 -默认（首次配置请先向机器人发一条消息再点 + 选择，保存后热生效）。"
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

      <SwitchField
        id="kujira-privacy-tools-enabled"
        label="隔离可能泄露隐私的工具"
        hint={
          privacyToolsEnabled
            ? '已开启，按下方名单规则隔离 Shell、文件读写、目录、环境依赖与技能加载等可能泄露隐私的工具（保留发文件与识图等聊天工具）；保存后对已有会话热生效'
            : '开启后默认对所有单聊隔离 Shell、文件读写、目录、环境依赖与技能加载等可能泄露隐私的工具，开启后可在下方配置白名单豁免或黑名单精准隔离'
        }
        checked={privacyToolsEnabled}
        disabled={saving}
        overridden={model.isOverridden('privacy_tools_enabled')}
        onReset={() => onResetField('privacy_tools_enabled')}
        onChange={(checked) => onFieldChange('privacy_tools_enabled', checked)}
      />

      {privacyToolsEnabled && (
        <div
          id="kujira-privacy-tools-peer-filter"
          data-testid="kujira-privacy-tools-peer-filter"
          className={fieldStyle.peerFilterBox}
        >
          <SegmentedField
            id="kujira-privacy-tools-list-mode"
            label="隔离名单模式"
            hint={
              privacyListMode === 'blacklist'
                ? '黑名单模式：仅对下方名单内的用户隔离上述工具，其余用户正常使用'
                : '白名单模式：仅下方名单内的用户可使用上述工具，其余用户一律隔离'
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
              privacyListMode === 'blacklist'
                ? '黑名单用户'
                : '白名单用户'
            }
            addButtonTitle={
              privacyListMode === 'blacklist' ? '添加黑名单用户' : '添加白名单用户'
            }
            emptyHint={
              privacyListMode === 'blacklist'
                ? '暂未配置，所有单聊会话均保留完整工具。'
                : '暂未配置，所有单聊会话都会隔离可能泄露隐私的工具。'
            }
            selectedPeers={selectedPrivacyPeers}
            knownPeers={knownPeers}
            nowTs={nowTs}
            saving={saving}
            overridden={model.isOverridden(activePrivacyListKey)}
            adding={isAddingPrivacyPeer}
            onAddingChange={setIsAddingPrivacyPeer}
            onAdd={(peer) =>
              onFieldChange(activePrivacyListKey, [...selectedPrivacyPeers, peer])
            }
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

      <SwitchField
        id="kujira-idle-reply-filter-enabled"
        label="冷场主动搭话名单"
        hint={
          idleFilterEnabled
            ? idleReplyEnabled
              ? '已开启，按下方名单模式与好友列表限制主动搭话对象'
              : '已开启，按下方名单模式与好友列表限制主动搭话对象（提示：当前在「回复节奏」中未开启冷场主动搭话总开关，下方名单暂未生效）'
            : '开启后可配置黑名单排除或白名单限制冷场主动搭话的好友对象；未开启时默认对所有已互动好友正常触发'
        }
        checked={idleFilterEnabled}
        disabled={saving}
        overridden={isIdleFilterOverridden}
        onReset={() => {
          userToggledIdleFilterRef.current = true;
          setIdleFilterEnabled(false);
          setIsAddingIdlePeer(false);
          onResetField('idle_reply_list_mode');
          onResetField('idle_reply_blacklist');
          onResetField('idle_reply_whitelist');
        }}
        onChange={(checked) => {
          userToggledIdleFilterRef.current = true;
          setIdleFilterEnabled(checked);
          if (!checked) {
            setIsAddingIdlePeer(false);
            onFieldChange('idle_reply_list_mode', DEFAULT_IDLE_REPLY_LIST_MODE);
            onFieldChange('idle_reply_blacklist', []);
            onFieldChange('idle_reply_whitelist', []);
          }
        }}
      />

      {idleFilterEnabled && (
        <div
          id="kujira-idle-reply-peer-filter"
          data-testid="kujira-idle-reply-peer-filter"
          className={fieldStyle.peerFilterBox}
        >
          <SegmentedField
            id="kujira-idle-reply-list-mode"
            label="搭话名单模式"
            hint={
              idleListMode === 'whitelist'
                ? '白名单模式：仅下方名单内的用户会触发冷场主动搭话，其余好友均不受打扰'
                : '黑名单模式：排除下方名单内的用户，其余已互动用户正常触发冷场主动搭话'
            }
            value={idleListMode}
            options={IDLE_REPLY_LIST_MODE_OPTIONS}
            disabled={saving}
            overridden={model.isOverridden('idle_reply_list_mode')}
            onReset={() => {
              setIsAddingIdlePeer(false);
              onResetField('idle_reply_list_mode');
            }}
            onChange={(val) => {
              setIsAddingIdlePeer(false);
              onFieldChange('idle_reply_list_mode', val);
            }}
          />

          <PeerListEditor
            idPrefix="kujira-idle-reply-peer"
            label={
              idleListMode === 'whitelist'
                ? '白名单用户'
                : '黑名单用户'
            }
            addButtonTitle={idleListMode === 'whitelist' ? '添加白名单用户' : '添加黑名单用户'}
            emptyHint={
              idleListMode === 'whitelist'
                ? '暂未配置，所有用户都不会触发冷场主动搭话。'
                : '暂未配置，所有用户都会触发冷场主动搭话。'
            }
            selectedPeers={selectedIdlePeers}
            knownPeers={knownPeers}
            nowTs={nowTs}
            saving={saving}
            overridden={model.isOverridden(activeIdleListKey)}
            adding={isAddingIdlePeer}
            onAddingChange={setIsAddingIdlePeer}
            onAdd={(peer) => onFieldChange(activeIdleListKey, [...selectedIdlePeers, peer])}
            onRemove={(peer) =>
              onFieldChange(
                activeIdleListKey,
                selectedIdlePeers.filter((p) => p !== peer)
              )
            }
            onReset={() => onResetField(activeIdleListKey)}
          />
        </div>
      )}
    </div>
  );
}
