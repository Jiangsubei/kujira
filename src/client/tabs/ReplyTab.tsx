import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ValueField, SwitchField, SegmentedField } from '../fields.js';
import { cardStyle, fieldStyle, faceStyle } from '../card-styles.js';
import { IconPlus, IconTrash } from '../icons.js';
import type {
  BridgePluginConfig,
  IdleReplyListMode,
  KnownPeerSummaryRecord,
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

export const PEERS_ENDPOINT = '/plugins/kujira/peers';
export const IDLE_REPLY_PEERS_POLL_MS = 5_000;

export type KnownPeerSummary = KnownPeerSummaryRecord;

const PROACTIVE_ATTITUDE_OPTIONS: Array<{ value: ProactiveAttitude; label: string }> = [
  { value: 'enthusiastic', label: '热情' },
  { value: 'balanced', label: '均衡' },
  { value: 'aloof', label: '冷淡' },
];

const IDLE_REPLY_LIST_MODE_OPTIONS: Array<{ value: IdleReplyListMode; label: string }> = [
  { value: 'blacklist', label: '黑名单模式' },
  { value: 'whitelist', label: '白名单模式' },
];

export function formatRelativeSpeakTime(timestamp: number | null, now = Date.now()): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return '暂无发言';
  }
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < 60_000) return '刚刚';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;

  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatPeerDropdownLabel(peer: KnownPeerSummary, now = Date.now()): string {
  const shortId = peer.short_openid ? `${peer.short_openid}…` : peer.peer;
  const timeText = formatRelativeSpeakTime(peer.last_message_time, now);
  const preview = peer.last_message_preview?.trim();
  if (preview) {
    return `${shortId} · ${timeText} · “${preview}”`;
  }
  return `${shortId} · ${timeText}`;
}

/**
 * 启动已互动用户列表自动轮询：启动时立即拉取一次，随后每隔 intervalMs 自动刷新。
 * 返回清理函数，切换 Tab、关闭总开关或卸载组件时停止轮询。
 */
export function startPeerListPolling(
  fetcher: () => void | Promise<void>,
  intervalMs = IDLE_REPLY_PEERS_POLL_MS
): () => void {
  void fetcher();
  const timer = setInterval(() => {
    void fetcher();
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

export interface ReplyTabProps {
  active: boolean;
  draft: Partial<BridgePluginConfig>;
  model: KujiraFormModel;
  saving: boolean;
  /** 可选初始已互动用户列表（供 SSR 与契约测试注入） */
  initialKnownPeers?: KnownPeerSummary[];
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
    initialAddingPeer,
    onFieldChange,
    onResetField,
  } = props;

  const [knownPeers, setKnownPeers] = useState<KnownPeerSummary[]>(initialKnownPeers ?? []);
  const [isAddingPeer, setIsAddingPeer] = useState<boolean>(Boolean(initialAddingPeer));
  const [candidatePeer, setCandidatePeer] = useState<string>('');
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadKnownPeers = useCallback(async () => {
    if (typeof fetch !== 'function' || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch(PEERS_ENDPOINT);
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current && data?.ok && Array.isArray(data.peers)) {
        setKnownPeers(data.peers);
        setNowTs(Date.now());
      }
    } catch {
      // 离线或接口暂不可用时静默容错
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const idleReplyEnabled = Boolean(draft.idle_reply_enabled ?? DEFAULT_IDLE_REPLY_ENABLED);

  // 打开设置/切入本 Tab 或开启冷场搭话时自动刷新，并在停留期间每 5 秒轮询一次
  useEffect(() => {
    if (!active || !idleReplyEnabled) return;
    return startPeerListPolling(loadKnownPeers, IDLE_REPLY_PEERS_POLL_MS);
  }, [active, idleReplyEnabled, loadKnownPeers]);

  const listMode: IdleReplyListMode =
    draft.idle_reply_list_mode === 'whitelist' ? 'whitelist' : DEFAULT_IDLE_REPLY_LIST_MODE;
  const selectedPeers: string[] = Array.isArray(draft.idle_reply_peers)
    ? draft.idle_reply_peers.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const selectedSet = new Set(selectedPeers);
  const knownPeersById = new Map(knownPeers.map((item) => [item.peer, item]));
  const availablePeers = knownPeers.filter((item) => !selectedSet.has(item.peer));

  const effectiveCandidate =
    candidatePeer && availablePeers.some((p) => p.peer === candidatePeer)
      ? candidatePeer
      : (availablePeers[0]?.peer ?? '');

  const handleOpenAddPeer = () => {
    setIsAddingPeer(true);
    setCandidatePeer('');
  };

  const handleCancelAddPeer = () => {
    setIsAddingPeer(false);
    setCandidatePeer('');
  };

  const handleSaveAddPeer = () => {
    if (!effectiveCandidate || selectedSet.has(effectiveCandidate)) return;
    onFieldChange('idle_reply_peers', [...selectedPeers, effectiveCandidate]);
    setIsAddingPeer(false);
    setCandidatePeer('');
  };

  const handleRemovePeer = (peerToRemove: string) => {
    onFieldChange(
      'idle_reply_peers',
      selectedPeers.filter((p) => p !== peerToRemove)
    );
  };

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
            onReset={() => onResetField('idle_reply_list_mode')}
            onChange={(val) => onFieldChange('idle_reply_list_mode', val)}
          />

          <div className={fieldStyle.field}>
            <div className={fieldStyle.head}>
              <label htmlFor="kujira-idle-reply-peer-select" className={fieldStyle.label}>
                {listMode === 'whitelist'
                  ? '白名单用户 (idle_reply_peers)'
                  : '黑名单用户 (idle_reply_peers)'}
              </label>
              <div className={fieldStyle.badges}>
                <button
                  id="kujira-idle-reply-peer-add"
                  type="button"
                  className={faceStyle.actionBtn}
                  title={listMode === 'whitelist' ? '添加白名单用户' : '添加黑名单用户'}
                  aria-label={listMode === 'whitelist' ? '添加白名单用户' : '添加黑名单用户'}
                  disabled={saving || isAddingPeer}
                  onClick={handleOpenAddPeer}
                >
                  <IconPlus size={12} />
                </button>
                {model.isOverridden('idle_reply_peers') && (
                  <>
                    <span className={fieldStyle.badge}>已自定义</span>
                    <button
                      type="button"
                      className={fieldStyle.reset}
                      disabled={saving}
                      onClick={() => {
                        setIsAddingPeer(false);
                        setCandidatePeer('');
                        onResetField('idle_reply_peers');
                      }}
                    >
                      重置
                    </button>
                  </>
                )}
              </div>
            </div>

            {isAddingPeer && (
              <div
                id="kujira-idle-reply-peer-editor"
                data-testid="kujira-idle-reply-peer-editor"
                className={fieldStyle.peerEditorRow}
              >
                <select
                  id="kujira-idle-reply-peer-select"
                  className={[fieldStyle.input, fieldStyle.peerSelect].join(' ')}
                  disabled={saving || availablePeers.length === 0}
                  value={effectiveCandidate}
                  onChange={(e) => setCandidatePeer(e.target.value)}
                >
                  {availablePeers.length === 0 ? (
                    <option value="">
                      {knownPeers.length === 0
                        ? '暂无已收到消息的用户'
                        : '所有已互动用户均已加入名单'}
                    </option>
                  ) : (
                    availablePeers.map((item) => (
                      <option key={item.peer} value={item.peer}>
                        {formatPeerDropdownLabel(item, nowTs)}
                      </option>
                    ))
                  )}
                </select>
                <div className={fieldStyle.peerEditorActions}>
                  <button
                    id="kujira-idle-reply-peer-cancel"
                    type="button"
                    className={[cardStyle.discard, fieldStyle.peerEditorBtn].join(' ')}
                    disabled={saving}
                    onClick={handleCancelAddPeer}
                  >
                    取消
                  </button>
                  <button
                    id="kujira-idle-reply-peer-save"
                    type="button"
                    className={[cardStyle.save, fieldStyle.peerEditorBtn].join(' ')}
                    disabled={saving || !effectiveCandidate}
                    onClick={handleSaveAddPeer}
                  >
                    保存
                  </button>
                </div>
              </div>
            )}

            {selectedPeers.length > 0 ? (
              <div className={fieldStyle.peerList}>
                {selectedPeers.map((peerId) => {
                  const info = knownPeersById.get(peerId);
                  const shortCode = info?.short_openid ? `${info.short_openid}…` : peerId;
                  const timeText = info ? formatRelativeSpeakTime(info.last_message_time, nowTs) : '';
                  const preview = info?.last_message_preview?.trim() || '';
                  const subText = [timeText, preview ? `“${preview}”` : '']
                    .filter(Boolean)
                    .join(' · ');

                  return (
                    <div
                      key={peerId}
                      data-testid={`kujira-idle-reply-peer-item-${peerId}`}
                      className={fieldStyle.peerRow}
                    >
                      <div className={fieldStyle.peerMeta}>
                        <span className={fieldStyle.peerCode}>{shortCode}</span>
                        {subText && <span className={fieldStyle.peerSub}>{subText}</span>}
                      </div>
                      <button
                        type="button"
                        data-testid={`kujira-idle-reply-peer-remove-${peerId}`}
                        className={[faceStyle.actionBtn, faceStyle.actionDelete].join(' ')}
                        title="移出名单"
                        aria-label={`移出 ${shortCode}`}
                        disabled={saving}
                        onClick={() => handleRemovePeer(peerId)}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : !isAddingPeer ? (
              <p className={fieldStyle.hint}>
                {listMode === 'whitelist'
                  ? '暂未配置，所有用户都不会触发冷场主动搭话。'
                  : '暂未配置，所有用户都会触发冷场主动搭话。'}
              </p>
            ) : null}
          </div>
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
