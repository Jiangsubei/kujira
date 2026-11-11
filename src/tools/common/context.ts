/**
 * kujira: 工具执行上下文定义、单聊 Peer 归一化与出站调度桥解析
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MessageDatabase } from '../../storage/database.js';
import type { MediaStorageManager } from '../../storage/media.js';
import type { MessageWaitRegistry } from '../../gateway/server.js';
import {
  OutboundStreamBridge,
  type KujiraGatewayClientLike,
} from '../../outbound/stream.js';
import type { PerPeerSerialSender } from '../../outbound/queue.js';
import type { SerialSender, BridgePluginConfig } from '../../types/index.js';
import type { TaskScheduler } from '../../scheduler/index.js';
import type { SlangStorage } from '../../slang/index.js';
import { isValidOpenid, openidToPeer } from '../../utils/peer.js';

export interface ToolExecutionContext {
  db?: MessageDatabase | null;
  outboundBridge?: OutboundStreamBridge | null;
  gateway?: KujiraGatewayClientLike | null;
  mediaManager?: MediaStorageManager | null;
  /** 共享 per-peer 串行发送器 */
  sender?: PerPeerSerialSender | SerialSender | null;
  peer?: string;
  /** 可选目标 openid（测试场景未落库 peer_openid_map 时兜底） */
  openid?: string;
  dshHome?: string;
  /** 入站消息等待收集器（wait_for_user_messages 工具） */
  waitRegistry?: MessageWaitRegistry | null;
  /** 当前工具调用的取消信号（Agent 回合中断时中止等待） */
  signal?: AbortSignal;
  /** 当前回合入站消息 ID 获取器（collect_face / 出站被动锚点兜底） */
  inboundMsgIdGetter?: (peer: string) => string | undefined;
  /** 表情包落盘存储目录 */
  faceDir?: string;
  /** 表情包存储配额上限 */
  faceStoreMax?: number;
  /** 表情包淘汰策略 */
  faceEvictPolicy?: 'reject' | 'evict_lru';
  /** 定时任务与周期调度引擎 */
  scheduler?: TaskScheduler | null;
  /** 黑话存储管理器 */
  slangStorage?: SlangStorage;
  /** 当前工具执行所在的 Session ID */
  sessionId?: string;
  /** 配置项提供器或配置快照 */
  config?: (() => BridgePluginConfig) | BridgePluginConfig;
}

export interface AgentToolsOptions {
  db: MessageDatabase;
  outboundBridge?: OutboundStreamBridge;
  gateway?: KujiraGatewayClientLike;
  mediaManager: MediaStorageManager;
  sender?: PerPeerSerialSender | SerialSender;
  dshHome?: string;
  waitRegistry?: MessageWaitRegistry;
  inboundMsgIdGetter?: (peer: string) => string | undefined;
  scheduler?: TaskScheduler;
  slangStorage?: SlangStorage;
  /** 当前工具执行所在的 Session ID */
  sessionId?: string;
  config?: (() => BridgePluginConfig) | BridgePluginConfig;
  configGetter?: () => BridgePluginConfig;
}

let globalToolContext: ToolExecutionContext = {};

export function setGlobalToolContext(context: ToolExecutionContext): void {
  globalToolContext = { ...globalToolContext, ...context };
}

export function resetGlobalToolContext(): void {
  globalToolContext = {};
}

export function getGlobalToolContext(): ToolExecutionContext {
  return globalToolContext;
}

export type ContextSource =
  | ToolExecutionContext
  | AgentToolsOptions
  | (() => ToolExecutionContext)
  | undefined;

export function resolveToolContext(source?: ContextSource): ToolExecutionContext {
  const dynamic = typeof source === 'function' ? source() : source || {};
  return { ...globalToolContext, ...dynamic };
}

const KUJIRA_SESSION_ID_REGEX = /^kujira-user-([0-9a-zA-Z_]+)(?:-.*)?$/;
const USER_PEER_REGEX = /^user_([0-9a-zA-Z_]+)$/;
const HEX32_OPENID_REGEX = /^[0-9a-fA-F]{32}$/;
const UUID_OPENID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 归一化单聊 Peer 标识：
 * - `kujira-user-<hash>(-...)` -> `user_<hash>`
 * - `user_<hash>` 保留原样
 * - 32 位十六进制 / UUID / `openid:<id>` 形式的 openid -> `openidToPeer(...)`
 * - 其余非单聊会话标识（如 `web-session`、`review-*`、`default`）原样返回以便上游 Fail-Closed 拦截
 */
export function normalizePeer(peer: string): string {
  if (typeof peer !== 'string') return '';
  const trimmed = peer.trim();
  if (!trimmed) return '';

  const sessionMatch = KUJIRA_SESSION_ID_REGEX.exec(trimmed);
  if (sessionMatch) {
    return `user_${sessionMatch[1]!}`;
  }

  if (USER_PEER_REGEX.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('openid:')) {
    const rawOpenid = trimmed.slice('openid:'.length).trim();
    if (isValidOpenid(rawOpenid)) {
      return openidToPeer(rawOpenid);
    }
    return trimmed;
  }

  if (HEX32_OPENID_REGEX.test(trimmed) || UUID_OPENID_REGEX.test(trimmed)) {
    return openidToPeer(trimmed);
  }

  return trimmed;
}

/** 校验归一化后的 peer 是否为合法的 Kujira 单聊会话标识 (`user_<hash>`) */
export function isKujiraUserPeer(peer: string): boolean {
  return typeof peer === 'string' && USER_PEER_REGEX.test(peer);
}

/** 从工具调用 `exec` 中解析并归一化当前会话 peer（缺省回退 context.peer） */
export function resolveSessionPeerFromExec(
  exec: any,
  fallbackPeer?: string
): string {
  const session = exec?.agent?.session;
  const rawSessionId =
    session?.id ||
    session?.sessionId ||
    exec?.agent?.sessionId ||
    exec?.agent?.id ||
    '';
  if (typeof rawSessionId === 'string' && rawSessionId.trim() !== '') {
    return normalizePeer(rawSessionId);
  }
  return fallbackPeer ? normalizePeer(fallbackPeer) : '';
}

/**
 * 统一解析出站调度桥 (`OutboundStreamBridge`)：
 * - 优先直接复用 `ctx.outboundBridge`；
 * - 若测试或简化调用仅注入 `ctx.gateway`，现场构造临时 `OutboundStreamBridge`
 *   并注入 `ctx.inboundMsgIdGetter` 与可选 `ctx.openid`，避免出站工具各自重复分片/槽位/上传逻辑。
 */
export function resolveOutboundBridge(ctx: ToolExecutionContext): OutboundStreamBridge | null {
  const peer = ctx.peer ? normalizePeer(ctx.peer) : '';

  if (ctx.outboundBridge) {
    if (
      peer &&
      ctx.openid &&
      isValidOpenid(ctx.openid) &&
      !ctx.outboundBridge.resolveOpenid(peer)
    ) {
      ctx.outboundBridge.registerPeerOpenid(peer, ctx.openid);
    }
    return ctx.outboundBridge;
  }

  if (!ctx.gateway) {
    return null;
  }

  const getConfig =
    typeof ctx.config === 'function'
      ? ctx.config
      : ctx.config && typeof ctx.config === 'object'
        ? () => ctx.config as BridgePluginConfig
        : undefined;

  const bridge = new OutboundStreamBridge({} as Context, {
    gateway: ctx.gateway,
    ...(ctx.db ? { db: ctx.db } : {}),
    ...(getConfig ? { getConfig } : {}),
  });

  if (peer && ctx.openid && isValidOpenid(ctx.openid)) {
    bridge.registerPeerOpenid(peer, ctx.openid);
  }

  if (peer && ctx.inboundMsgIdGetter) {
    const msgId = ctx.inboundMsgIdGetter(peer);
    if (typeof msgId === 'string' && msgId.trim() !== '') {
      const openid = ctx.openid ?? ctx.db?.getOpenidByPeer?.(peer) ?? undefined;
      bridge.trackInboundContext(peer, {
        msg_id: msgId.trim(),
        from_user: openid || peer,
        ...(openid ? { openid } : {}),
      });
    }
  }

  return bridge;
}
