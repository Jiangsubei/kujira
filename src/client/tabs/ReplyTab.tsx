import React, { useState, useEffect, useRef } from 'react';
import { ValueField, SwitchField, SegmentedField } from '../fields.js';
import { cardStyle, fieldStyle } from '../card-styles.js';
import {
  PEERS_ENDPOINT,
  PEERS_POLL_MS,
  PeerListEditor,
  formatRelativeSpeakTime,
  formatPeerDropdownLabel,
  startPeerListPolling,
  useKnownPeersPolling,
  type KnownPeerSummary,
} from '../components/PeerListEditor.js';
import type {
  BridgePluginConfig,
  IdleReplyListMode,
  ProactiveAttitude,
} from '../../types/index.js';
import {
  DEFAULT_NEW_MESSAGE_BEHAVIOR,
  DEFAULT_AGGREGATION_ENABLED,
  DEFAULT_AGGREGATION_MIN_SECONDS,
  DEFAULT_AGGREGATION_MAX_SECONDS,
  DEFAULT_IDLE_REPLY_ENABLED,
  DEFAULT_IDLE_REPLY_MIN_MINS,
  DEFAULT_IDLE_REPLY_MAX_MINS,
  DEFAULT_IDLE_REPLY_LIST_MODE,
  DEFAULT_PROACTIVE_ATTITUDE,
  DEFAULT_INSTANT_REPLY_ENABLED,
} from '../../constants/index.js';
import type { KujiraFormModel } from '../model.js';

export {
  PEERS_ENDPOINT,
  formatRelativeSpeakTime,
  formatPeerDropdownLabel,
  startPeerListPolling,
  type KnownPeerSummary,
};
export const IDLE_REPLY_PEERS_POLL_MS = PEERS_POLL_MS;

const PROACTIVE_ATTITUDE_OPTIONS: Array<{ value: ProactiveAttitude; label: string }> = [
  { value: 'enthusiastic', label: '热情' },
  { value: 'balanced', label: '均衡' },
  { value: 'aloof', label: '冷淡' },
];

const IDLE_REPLY_LIST_MODE_OPTIONS: Array<{ value: IdleReplyListMode; label: string }> = [
  { value: 'blacklist', label: '黑名单模式' },
  { value: 'whitelist', label: '白名单模式' },
];

/**
 * 判断草稿中是否已配置了非默认的冷场搭话黑白名单规则。
 * 只要切换为白名单模式或任一名单非空即返回 true（打开设置时默认展开，避免隐形生效）。
 */
export function hasCustomIdleReplyFilterConfig(draft: Partial<BridgePluginConfig>): boolean {
  if (draft.idle_reply_list_mode === 'whitelist') return true;
  const blacklist = Array.isArray(draft.idle_reply_blacklist)
    ? draft.idle_reply_blacklist.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];
  if (blacklist.length > 0) return true;
  const whitelist = Array.isArray(draft.idle_reply_whitelist)
    ? draft.idle_reply_whitelist.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];
  return whitelist.length > 0;
}

export interface ReplyTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  /** 可选初始已互动用户列表（供 SSR 与契约测试注入） */
  initialKnownPeers?: KnownPeerSummary[];
  /** 可选初始是否展开「更多选项」黑白名单面板（供 SSR 与契约测试验证展开态） */
  initialPeerFilterExpanded?: boolean;
  /** 可选初始是否展开内联添加行（供 SSR 与契约测试验证编辑态） */
  initialAddingPeer?: boolean;
  onFieldChange: (key: keyof BridgePluginConfig, val: any) => void;
  onResetField: (key: keyof BridgePluginConfig) => void;
}

export function ReplyTab(props: ReplyTabProps): React.JSX.Element {
  const {
    active,
    draft,
    model,
    saving,
    initialKnownPeers,
    initialPeerFilterExpanded,
    initialAddingPeer,
    onFieldChange,
    onResetField,
  } = props;

  const hasCustomFilter = hasCustomIdleReplyFilterConfig(draft);
  const [peerFilterExpanded, setPeerFilterExpanded] = useState<boolean>(
    () => initialPeerFilterExpanded ?? hasCustomFilter
  );
  const userToggledPeerFilterRef = useRef<boolean>(initialPeerFilterExpanded !== undefined);
  const [isAddingPeer, setIsAddingPeer] = useState<boolean>(Boolean(initialAddingPeer));

  // 异步远程配置加载完成后，若检测到已配置非默认名单且用户尚未手动折叠，自动展开
  useEffect(() => {
    if (!userToggledPeerFilterRef.current && hasCustomFilter) {
      setPeerFilterExpanded(true);
    }
  }, [hasCustomFilter]);

  const idleReplyEnabled = Boolean(draft.idle_reply_enabled ?? DEFAULT_IDLE_REPLY_ENABLED);

  // 打开设置/切入本 Tab 且展开「更多选项」时自动刷新，并在停留期间每 5 秒轮询一次
  const { knownPeers, nowTs } = useKnownPeersPolling(
    active && idleReplyEnabled && peerFilterExpanded,
    initialKnownPeers
  );

  const listMode: IdleReplyListMode =
    draft.idle_reply_list_mode === 'whitelist' ? 'whitelist' : DEFAULT_IDLE_REPLY_LIST_MODE;
  const activeListKey: 'idle_reply_blacklist' | 'idle_reply_whitelist' =
    listMode === 'whitelist' ? 'idle_reply_whitelist' : 'idle_reply_blacklist';
  const rawSelectedPeers = draft[activeListKey];
  const selectedPeers: string[] = Array.isArray(rawSelectedPeers)
    ? rawSelectedPeers.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];

  return (
    <div
      id="kujira-tabpanel-reply"
      data-testid="kujira-tabpanel-reply"
      role="tabpanel"
      aria-labelledby="kujira-tab-reply"
      hidden={!active}
      className={[
        cardStyle.tabPanel,
        !active ? cardStyle.tabPanelHidden : '',
      ].filter(Boolean).join(' ')}
      style={!active ? { display: 'none' } : undefined}
    >
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

      <SegmentedField
        id="kujira-proactive-attitude"
        label="互动偏好 (proactive_attitude)"
        hint="全局仿生节奏偏置，同时作用于下方的连续消息聚合与冷场主动搭话：热情（偏向最小时长，反应迅速、潜水间隔短）；均衡（均匀随机分布）；冷淡（偏向最大时长，节奏沉着、留白多）"
        value={draft.proactive_attitude ?? DEFAULT_PROACTIVE_ATTITUDE}
        options={PROACTIVE_ATTITUDE_OPTIONS}
        disabled={saving}
        overridden={model.isOverridden('proactive_attitude')}
        onReset={() => onResetField('proactive_attitude')}
        onChange={(val) => onFieldChange('proactive_attitude', val)}
      />

      <SwitchField
        id="kujira-aggregation-enabled"
        label="连续消息聚合回复 (aggregation_enabled)"
        hint={
          draft.aggregation_enabled
            ? '按事件驱动与仿生动态节奏聚合新消息，到点后由模型统一回复；不逐条即时应答，等待用户答题或审批期间自动跳过'
            : '开启后，用户连续发送的多条消息不再逐条即时回复，而是按仿生动态节奏统一合并回复'
        }
        checked={draft.aggregation_enabled ?? DEFAULT_AGGREGATION_ENABLED}
        disabled={saving}
        overridden={model.isOverridden('aggregation_enabled')}
        onReset={() => onResetField('aggregation_enabled')}
        onChange={(checked) => onFieldChange('aggregation_enabled', checked)}
      />

      <ValueField
        id="kujira-aggregation-min-seconds"
        label="聚合最小时长 (aggregation_min_seconds)"
        hint={`连续消息聚合等待的下限硬底线，即使多条消息快速折减也不会低于此时长 (单位秒，默认 ${DEFAULT_AGGREGATION_MIN_SECONDS})`}
        placeholder={String(DEFAULT_AGGREGATION_MIN_SECONDS)}
        numeric
        value={String(draft.aggregation_min_seconds ?? DEFAULT_AGGREGATION_MIN_SECONDS)}
        disabled={saving || !draft.aggregation_enabled}
        overridden={model.isOverridden('aggregation_min_seconds')}
        onReset={() => onResetField('aggregation_min_seconds')}
        onChange={(val) => {
          const parsed = parseInt(val, 10);
          onFieldChange(
            'aggregation_min_seconds',
            Number.isNaN(parsed) ? DEFAULT_AGGREGATION_MIN_SECONDS : parsed
          );
        }}
      />

      <ValueField
        id="kujira-aggregation-max-seconds"
        label="聚合最大时长 (aggregation_max_seconds)"
        hint={`连续消息聚合等待的上限，初始随机采样的最长等待时间 (单位秒，默认 ${DEFAULT_AGGREGATION_MAX_SECONDS})`}
        placeholder={String(DEFAULT_AGGREGATION_MAX_SECONDS)}
        numeric
        value={String(draft.aggregation_max_seconds ?? DEFAULT_AGGREGATION_MAX_SECONDS)}
        disabled={saving || !draft.aggregation_enabled}
        overridden={model.isOverridden('aggregation_max_seconds')}
        onReset={() => onResetField('aggregation_max_seconds')}
        onChange={(val) => {
          const parsed = parseInt(val, 10);
          onFieldChange(
            'aggregation_max_seconds',
            Number.isNaN(parsed) ? DEFAULT_AGGREGATION_MAX_SECONDS : parsed
          );
        }}
      />

      <SwitchField
        id="kujira-instant-reply-enabled"
        label="允许在连续热聊时概率秒回 (instant_reply_enabled)"
        hint="开启后，在会话处于高热度时允许突破聚合等待下限，在 0~2 秒内极速响应"
        checked={draft.instant_reply_enabled ?? DEFAULT_INSTANT_REPLY_ENABLED}
        disabled={saving || !draft.aggregation_enabled}
        overridden={model.isOverridden('instant_reply_enabled')}
        onReset={() => onResetField('instant_reply_enabled')}
        onChange={(checked) => onFieldChange('instant_reply_enabled', checked)}
      />

      <SwitchField
        id="kujira-idle-reply-enabled"
        label="冷场主动搭话 (idle_reply_enabled)"
        hint={
          idleReplyEnabled
            ? '长时间没有新消息时，由模型自主判断是否主动发起话题；等待用户答题或审批期间同样跳过'
            : '开启后，单聊长时间无新消息时模型会主动找话题；需存在可用的被动回复锚点才会发信'
        }
        checked={idleReplyEnabled}
        disabled={saving}
        overridden={model.isOverridden('idle_reply_enabled')}
        onReset={() => onResetField('idle_reply_enabled')}
        onChange={(checked) => onFieldChange('idle_reply_enabled', checked)}
      />

      {idleReplyEnabled && (
        <div
          id="kujira-idle-reply-more-section"
          data-testid="kujira-idle-reply-more-section"
          className={fieldStyle.peerFilterSection}
        >
          <button
            id="kujira-idle-reply-more-toggle"
            type="button"
            className={fieldStyle.moreToggle}
            aria-expanded={peerFilterExpanded}
            aria-controls="kujira-idle-reply-peer-filter"
            disabled={saving}
            onClick={() => {
              userToggledPeerFilterRef.current = true;
              setPeerFilterExpanded((prev) => {
                const next = !prev;
                if (!next) {
                  setIsAddingPeer(false);
                }
                return next;
              });
            }}
          >
            <span aria-hidden="true">{peerFilterExpanded ? '▾' : '▸'}</span>
            <span>更多选项</span>
          </button>

          {peerFilterExpanded && (
            <div
              id="kujira-idle-reply-peer-filter"
              data-testid="kujira-idle-reply-peer-filter"
              className={fieldStyle.peerFilterBox}
            >
              <SegmentedField
                id="kujira-idle-reply-list-mode"
                label="搭话名单模式 (idle_reply_list_mode)"
                hint={
                  listMode === 'whitelist'
                    ? '白名单模式：仅下方名单内的用户会触发冷场主动搭话，其余好友均不受打扰'
                    : '黑名单模式：排除下方名单内的用户，其余已互动用户正常触发冷场主动搭话'
                }
                value={listMode}
                options={IDLE_REPLY_LIST_MODE_OPTIONS}
                disabled={saving}
                overridden={model.isOverridden('idle_reply_list_mode')}
                onReset={() => {
                  setIsAddingPeer(false);
                  onResetField('idle_reply_list_mode');
                }}
                onChange={(val) => {
                  setIsAddingPeer(false);
                  onFieldChange('idle_reply_list_mode', val);
                }}
              />

              <PeerListEditor
                idPrefix="kujira-idle-reply-peer"
                label={
                  listMode === 'whitelist'
                    ? '白名单用户 (idle_reply_whitelist)'
                    : '黑名单用户 (idle_reply_blacklist)'
                }
                addButtonTitle={listMode === 'whitelist' ? '添加白名单用户' : '添加黑名单用户'}
                emptyHint={
                  listMode === 'whitelist'
                    ? '暂未配置，所有用户都不会触发冷场主动搭话。'
                    : '暂未配置，所有用户都会触发冷场主动搭话。'
                }
                selectedPeers={selectedPeers}
                knownPeers={knownPeers}
                nowTs={nowTs}
                saving={saving}
                overridden={model.isOverridden(activeListKey)}
                adding={isAddingPeer}
                onAddingChange={setIsAddingPeer}
                onAdd={(peer) => onFieldChange(activeListKey, [...selectedPeers, peer])}
                onRemove={(peer) =>
                  onFieldChange(
                    activeListKey,
                    selectedPeers.filter((p) => p !== peer)
                  )
                }
                onReset={() => onResetField(activeListKey)}
              />
            </div>
          )}
        </div>
      )}

      <ValueField
        id="kujira-idle-reply-min-mins"
        label="潜水搭话最小沉默时长 (idle_reply_min_mins)"
        hint={`单聊无新消息后主动搭话的最早尝试时间 (单位分钟，默认 ${DEFAULT_IDLE_REPLY_MIN_MINS})`}
        placeholder={String(DEFAULT_IDLE_REPLY_MIN_MINS)}
        numeric
        value={String(draft.idle_reply_min_mins ?? DEFAULT_IDLE_REPLY_MIN_MINS)}
        disabled={saving || !idleReplyEnabled}
        overridden={model.isOverridden('idle_reply_min_mins')}
        onReset={() => onResetField('idle_reply_min_mins')}
        onChange={(val) => {
          const parsed = parseInt(val, 10);
          onFieldChange(
            'idle_reply_min_mins',
            Number.isNaN(parsed) ? DEFAULT_IDLE_REPLY_MIN_MINS : parsed
          );
        }}
      />

      <ValueField
        id="kujira-idle-reply-max-mins"
        label="潜水搭话最大沉默时长 (idle_reply_max_mins)"
        hint={`单聊无新消息后主动搭话的最迟尝试时间 (单位分钟，默认 ${DEFAULT_IDLE_REPLY_MAX_MINS})`}
        placeholder={String(DEFAULT_IDLE_REPLY_MAX_MINS)}
        numeric
        value={String(draft.idle_reply_max_mins ?? DEFAULT_IDLE_REPLY_MAX_MINS)}
        disabled={saving || !idleReplyEnabled}
        overridden={model.isOverridden('idle_reply_max_mins')}
        onReset={() => onResetField('idle_reply_max_mins')}
        onChange={(val) => {
          const parsed = parseInt(val, 10);
          onFieldChange(
            'idle_reply_max_mins',
            Number.isNaN(parsed) ? DEFAULT_IDLE_REPLY_MAX_MINS : parsed
          );
        }}
      />
    </div>
  );
}
