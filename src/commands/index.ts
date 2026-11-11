/**
 * kujira: 斜杠命令门面模块
 * 面向已接入的 QQ 官方单聊 (C2C) 会话提供全量指令路由分发入口（已移除 admins 白名单鉴权）。
 */

import type { CommandContext, CommandResult } from './types.js';
import { dispatchCommand } from './router.js';

export type { CommandContext, CommandResult, CommandHandler } from './types.js';
export type { DiscoveredModelInfo, ModelReasoningMetadata } from './model/types.js';
export { getDiscoveredModels } from './model/discovery.js';
export { safeSyncSessionModel } from './model/sync.js';
export { getModelReasoningInfo } from './model/reasoning.js';
export { formatTokens, getContextUsageBrief } from './utils/usage.js';
export { COMPACT_FAIL_TEXT } from './session/compact-handler.js';

/**
 * 判断输入文本是否为斜杠命令（兼容全半角斜杠）
 */
export function isSlashCommand(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('／');
}

/**
 * 处理单聊斜杠命令并分发至对应指令处理器
 */
export async function handleSlashCommand(
  commandText: string,
  context: CommandContext
): Promise<CommandResult> {
  if (!isSlashCommand(commandText)) {
    return { handled: false };
  }

  const trimmed = commandText.trim().replace(/^／/, '/');
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) {
    return { handled: false };
  }

  const command = match[1];
  const args = (match[2] || '').trim();

  return await dispatchCommand(command, args, context);
}
