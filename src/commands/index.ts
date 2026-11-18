/**
 * kujira: 斜杠命令门面模块
 * 面向已接入的 QQ 官方单聊 (C2C) 会话提供指令路由分发与管理员权限分层校验。
 */

import { safeGetService } from '../gateway/session/agent-runner.js';
import { hasConfiguredAdmins, isAdminIdentity } from '../utils/access-control.js';
import type { CommandContext, CommandResult } from './types.js';
import { dispatchCommand } from './router.js';

export type { CommandContext, CommandResult, CommandHandler } from './types.js';
export type { DiscoveredModelInfo, ModelReasoningMetadata } from './model/types.js';
export { getDiscoveredModels } from './model/discovery.js';
export { safeSyncSessionModel } from './model/sync.js';
export { getModelReasoningInfo } from './model/reasoning.js';
export { formatTokens, getContextUsageBrief } from './utils/usage.js';
export { COMPACT_FAIL_TEXT } from './session/compact-handler.js';

const ADMIN_REQUIRED_ERROR = '权限不足：该指令仅限管理员使用';

/**
 * 解析当前生效的管理员列表：
 * 优先级：context.admins → context.config?.admins → kujira-bridge-config 服务实时配置 → []
 */
function resolveEffectiveAdmins(context: CommandContext): string[] {
  if (Array.isArray(context.admins)) {
    return context.admins;
  }
  if (Array.isArray(context.config?.admins)) {
    return context.config.admins;
  }
  const cfgService: unknown = safeGetService(context.ctx, 'kujira-bridge-config');
  if (cfgService) {
    try {
      const liveCfg =
        typeof cfgService === 'function' ? (cfgService as () => any)() : (cfgService as any);
      if (Array.isArray(liveCfg?.admins)) {
        return liveCfg.admins;
      }
    } catch {
      // 忽略实时配置服务读取异常，回退为空列表
    }
  }
  return [];
}

/**
 * 判定给定命令与参数是否属于管理员专属受限操作：
 * 1. /权限（无论是否带参数）
 * 2. /模型 且参数 tokens 中包含 -默认
 * 3. /思考 且参数 tokens 中包含 -默认
 */
function isAdminOnlyOperation(command: string, args: string): boolean {
  if (command === '权限') {
    return true;
  }
  if (command === '模型' || command === '思考') {
    const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
    return tokens.includes('-默认');
  }
  return false;
}

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

  const admins = resolveEffectiveAdmins(context);
  if (hasConfiguredAdmins({ admins }) && isAdminOnlyOperation(command, args)) {
    const callerIdentity =
      context.userId?.trim() ||
      (typeof context.sessionManager?.sessionIdToPeer === 'function'
        ? context.sessionManager.sessionIdToPeer(context.session?.id || '')
        : context.session?.id);
    if (!isAdminIdentity(callerIdentity, { admins })) {
      return {
        handled: true,
        success: false,
        error: ADMIN_REQUIRED_ERROR,
      };
    }
  }

  return await dispatchCommand(command, args, context);
}
