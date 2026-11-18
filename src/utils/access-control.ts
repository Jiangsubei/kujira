/**
 * kujira: 管理员权限与隐私工具隔离公共判定函数
 *
 * 纯函数、无副作用，供审批门控、斜杠命令分层、会话装配与设置前端共用。
 */

import { PRIVACY_ISOLATED_TOOL_NAMES } from '../constants/index.js';
import type { BridgePluginConfig } from '../types/index.js';
import { isValidOpenid, openidToPeer } from './peer.js';

const SYSTEM_PSEUDO_IDENTITIES = new Set(['system', 'agent', 'self']);

const PEER_RE = /^user_[A-Za-z0-9_]+$/;
const SESSION_ID_RE = /^kujira-user-([A-Za-z0-9_]+)(?:-.*)?$/;
const OPENID_HEX32_RE = /^[0-9a-fA-F]{32}$/;

/**
 * 将多种身份形态归一化为内部单聊 peer (`user_<id>`)：
 * - 已经是 `user_<id>` → 原样返回
 * - `kujira-user-<id>(...可选后缀)` → 提取 `user_<id>`
 * - 32 位 hex `openid` 或其它合法非空 openid → 调用 `openidToPeer` 稳定映射
 * - 空值、空白、残缺前缀或系统伪身份 (`system`/`agent`/`self`，大小写不敏感) → 返回 `null`
 */
export function normalizeIdentityToPeer(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (SYSTEM_PSEUDO_IDENTITIES.has(trimmed.toLowerCase())) {
    return null;
  }
  if (PEER_RE.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('user_')) {
    return null;
  }
  const sessionMatch = SESSION_ID_RE.exec(trimmed);
  if (sessionMatch) {
    return `user_${sessionMatch[1]!}`;
  }
  if (trimmed.startsWith('kujira-user-')) {
    return null;
  }
  if (OPENID_HEX32_RE.test(trimmed)) {
    return openidToPeer(trimmed);
  }
  if (isValidOpenid(trimmed)) {
    return openidToPeer(trimmed);
  }
  return null;
}

/**
 * 将配置数组中的每一项经 `normalizeIdentityToPeer` 归一化并去重保序，忽略无效项。
 */
export function normalizePeerList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const peer = normalizeIdentityToPeer(item);
    if (peer && !seen.has(peer)) {
      seen.add(peer);
      result.push(peer);
    }
  }
  return result;
}

/**
 * 判断是否显式配置了至少一位管理员。
 */
export function hasConfiguredAdmins(config?: Pick<BridgePluginConfig, 'admins'> | null): boolean {
  return normalizePeerList(config?.admins).length > 0;
}

/**
 * 判断给定身份是否具备管理员权限：
 * - 空值、空白或系统伪身份绝不被视为管理员（返回 `false`）；
 * - `admins` 列表为空（1 对 1 模式）时，所有有效单聊好友均具备管理员权限（返回 `true`）；
 * - `admins` 非空时，仅归一化后命中 `admins` 名单的身份返回 `true`。
 */
export function isAdminIdentity(
  identity: string | undefined | null,
  config?: Pick<BridgePluginConfig, 'admins'> | null
): boolean {
  const peer = normalizeIdentityToPeer(identity);
  if (!peer) {
    return false;
  }
  const admins = normalizePeerList(config?.admins);
  if (admins.length === 0) {
    return true;
  }
  return admins.includes(peer);
}

/**
 * 判断给定身份是否命中「隔离可能泄露隐私的工具」策略：
 * - `blacklist` 模式（默认）：仅当归一化后命中黑名单时返回 `true`（无效身份返回 `false`）；
 * - `whitelist` 模式：Fail-Closed，无效身份或未命中白名单均返回 `true`（空白名单全员隔离）。
 */
export function isPrivacyToolsRestricted(
  identity: string | undefined | null,
  config?: Pick<
    BridgePluginConfig,
    'privacy_tools_list_mode' | 'privacy_tools_blacklist' | 'privacy_tools_whitelist'
  > | null
): boolean {
  const mode = config?.privacy_tools_list_mode === 'whitelist' ? 'whitelist' : 'blacklist';
  const peer = normalizeIdentityToPeer(identity);
  if (mode === 'whitelist') {
    if (!peer) {
      return true;
    }
    const whitelist = normalizePeerList(config?.privacy_tools_whitelist);
    return !whitelist.includes(peer);
  }
  if (!peer) {
    return false;
  }
  const blacklist = normalizePeerList(config?.privacy_tools_blacklist);
  return blacklist.includes(peer);
}

/**
 * 解析当前环境下需要被隔离的隐私敏感工具名称列表：
 * - 提供 `knownNames` 时：返回 `PRIVACY_ISOLATED_TOOL_NAMES` 中存在于 `knownNames` 集合的交集；
 * - 未提供 `knownNames` 时：按当前操作系统平台过滤不适用 Shell（`win32` 排除 `bash`，非 `win32` 排除 `pwsh`）。
 */
export function resolvePrivacyIsolatedTools(knownNames?: Iterable<string>): string[] {
  if (knownNames !== undefined) {
    const knownSet = new Set(knownNames);
    return PRIVACY_ISOLATED_TOOL_NAMES.filter((name) => knownSet.has(name));
  }
  const excludedShell = process.platform === 'win32' ? 'bash' : 'pwsh';
  return PRIVACY_ISOLATED_TOOL_NAMES.filter((name) => name !== excludedShell);
}
