import React, { useState, useEffect, useCallback, useRef } from 'react';
import { cardStyle, fieldStyle, faceStyle } from '../card-styles.js';
import { IconPlus, IconTrash } from '../icons.js';
import type { KnownPeerSummaryRecord } from '../../types/index.js';

export const PEERS_ENDPOINT = '/plugins/kujira/peers';
export const PEERS_POLL_MS = 5_000;

export type KnownPeerSummary = KnownPeerSummaryRecord;

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
 * 返回清理函数，切换 Tab、折叠面板或卸载组件时停止轮询。
 */
export function startPeerListPolling(
  fetcher: () => void | Promise<void>,
  intervalMs = PEERS_POLL_MS
): () => void {
  void fetcher();
  const timer = setInterval(() => {
    void fetcher();
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

/**
 * 管理已互动用户摘要列表、相对时间锚点以及 5 秒自动轮询。
 * 仅在 enabled 为 true 时轮询，切 Tab 或折叠即停。
 */
export function useKnownPeersPolling(
  enabled: boolean,
  initialKnownPeers?: KnownPeerSummary[]
): {
  knownPeers: KnownPeerSummary[];
  nowTs: number;
  refresh: () => Promise<void>;
} {
  const [knownPeers, setKnownPeers] = useState<KnownPeerSummary[]>(initialKnownPeers ?? []);
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

  useEffect(() => {
    if (!enabled) return;
    return startPeerListPolling(loadKnownPeers, PEERS_POLL_MS);
  }, [enabled, loadKnownPeers]);

  return { knownPeers, nowTs, refresh: loadKnownPeers };
}

export interface PeerListEditorProps {
  /** DOM id / data-testid 前缀 */
  idPrefix: string;
  /** 字段标题 */
  label: string;
  /** 添加按钮 title / aria-label */
  addButtonTitle: string;
  /** 名单为空且未处于内联添加态时的提示文案 */
  emptyHint: string;
  /** 可选常驻说明文案 */
  hint?: string;
  /** 当前已选内部 peer 列表 */
  selectedPeers: string[];
  /** 已互动用户摘要列表 */
  knownPeers: KnownPeerSummary[];
  /** 当前时间戳（用于计算相对发言时间） */
  nowTs: number;
  /** 是否正在保存 */
  saving: boolean;
  /** 当前字段是否已偏离默认值 */
  overridden: boolean;
  /** 非受控模式下初始是否展开内联添加行 */
  initialAdding?: boolean;
  /** 受控内联添加态（配合 onAddingChange 便于外部在切换模式/折叠时重置） */
  adding?: boolean;
  /** 内联添加态变更回调 */
  onAddingChange?: (adding: boolean) => void;
  /** 添加选中用户 */
  onAdd: (peer: string) => void;
  /** 移出用户 */
  onRemove: (peer: string) => void;
  /** 重置整个列表字段 */
  onReset: () => void;
}

export function PeerListEditor(props: PeerListEditorProps): React.JSX.Element {
  const {
    idPrefix,
    label,
    addButtonTitle,
    emptyHint,
    hint,
    selectedPeers,
    knownPeers,
    nowTs,
    saving,
    overridden,
    initialAdding,
    adding,
    onAddingChange,
    onAdd,
    onRemove,
    onReset,
  } = props;

  const [internalAdding, setInternalAdding] = useState<boolean>(Boolean(initialAdding));
  const [candidatePeer, setCandidatePeer] = useState<string>('');

  const isControlled = adding !== undefined;
  const isAdding = isControlled ? adding : internalAdding;

  const setAdding = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalAdding(next);
      }
      onAddingChange?.(next);
    },
    [isControlled, onAddingChange]
  );

  useEffect(() => {
    if (!isAdding) {
      setCandidatePeer('');
    }
  }, [isAdding]);

  const normalizedSelected = selectedPeers.filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0
  );
  const selectedSet = new Set(normalizedSelected);
  const knownPeersById = new Map(knownPeers.map((item) => [item.peer, item]));
  const availablePeers = knownPeers.filter((item) => !selectedSet.has(item.peer));

  const effectiveCandidate =
    candidatePeer && availablePeers.some((p) => p.peer === candidatePeer)
      ? candidatePeer
      : (availablePeers[0]?.peer ?? '');

  const handleOpenAdd = () => {
    setCandidatePeer('');
    setAdding(true);
  };

  const handleCancelAdd = () => {
    setAdding(false);
    setCandidatePeer('');
  };

  const handleSaveAdd = () => {
    if (!effectiveCandidate || selectedSet.has(effectiveCandidate)) return;
    onAdd(effectiveCandidate);
    setAdding(false);
    setCandidatePeer('');
  };

  const handleReset = () => {
    setAdding(false);
    setCandidatePeer('');
    onReset();
  };

  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label htmlFor={`${idPrefix}-select`} className={fieldStyle.label}>
          {label}
        </label>
        <div className={fieldStyle.badges}>
          {overridden && (
            <>
              <span className={fieldStyle.badge}>已自定义</span>
              <button
                type="button"
                className={fieldStyle.reset}
                disabled={saving}
                onClick={handleReset}
              >
                重置
              </button>
            </>
          )}
          <button
            id={`${idPrefix}-add`}
            type="button"
            className={faceStyle.actionBtn}
            title={addButtonTitle}
            aria-label={addButtonTitle}
            disabled={saving || isAdding}
            onClick={handleOpenAdd}
          >
            <IconPlus size={12} />
          </button>
        </div>
      </div>

      {isAdding && (
        <div
          id={`${idPrefix}-editor`}
          data-testid={`${idPrefix}-editor`}
          className={fieldStyle.peerEditorRow}
        >
          <select
            id={`${idPrefix}-select`}
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
              id={`${idPrefix}-cancel`}
              type="button"
              className={[cardStyle.discard, fieldStyle.peerEditorBtn].join(' ')}
              disabled={saving}
              onClick={handleCancelAdd}
            >
              取消
            </button>
            <button
              id={`${idPrefix}-save`}
              type="button"
              className={[cardStyle.save, fieldStyle.peerEditorBtn].join(' ')}
              disabled={saving || !effectiveCandidate}
              onClick={handleSaveAdd}
            >
              保存
            </button>
          </div>
        </div>
      )}

      {normalizedSelected.length > 0 ? (
        <div className={fieldStyle.peerList}>
          {normalizedSelected.map((peerId) => {
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
                data-testid={`${idPrefix}-item-${peerId}`}
                className={fieldStyle.peerRow}
              >
                <div className={fieldStyle.peerMeta}>
                  <span className={fieldStyle.peerCode}>{shortCode}</span>
                  {subText && <span className={fieldStyle.peerSub}>{subText}</span>}
                </div>
                <button
                  type="button"
                  data-testid={`${idPrefix}-remove-${peerId}`}
                  className={[faceStyle.actionBtn, faceStyle.actionDelete].join(' ')}
                  title="移出名单"
                  aria-label={`移出 ${shortCode}`}
                  disabled={saving}
                  onClick={() => onRemove(peerId)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            );
          })}
        </div>
      ) : !isAdding ? (
        <p className={fieldStyle.hint}>{emptyHint}</p>
      ) : null}

      {hint && <p className={fieldStyle.hint}>{hint}</p>}
    </div>
  );
}
