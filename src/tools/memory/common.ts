/**
 * kujira: Memory Agent 工具集通用辅助与业务类（单聊强隔离）
 *
 * 严格约束：
 * - 两层记忆（'session' 与 'user'）均以当前单聊 `user_<hash16>` peer 为物理主键；
 * - 彻底禁止 `'default'` 兜底、跨会话指定 `peer` / `user_id` 与群聊访问。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MemoryStorage } from '../../memory/storage.js';
import type { MemoryOperationResult } from '../../memory/types.js';
import type {
  CreateMemoryParams,
  EditMemoryParams,
  ReadMemoryParams,
} from '../../types/index.js';
import {
  DEFAULT_USER_PROFILE_BUDGET_CHARS,
  DEFAULT_SESSION_MEMORY_BUDGET_CHARS,
} from '../../constants/index.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

const KUJIRA_SESSION_ID_REGEX = /^kujira-user-([0-9a-zA-Z_]+)(?:-.*)?$/;
const USER_PEER_REGEX = /^user_([0-9a-zA-Z_]+)$/;

/**
 * 将单聊会话标识归一化为严格的 `user_<hash>` 格式；
 * 非有效单聊标识（如 `default`、`web-*`、`review-*`、`group_*` 等）一律返回 `null`。
 */
export function normalizeStrictUserPeer(raw?: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'default') return null;

  const sessionMatch = KUJIRA_SESSION_ID_REGEX.exec(trimmed);
  if (sessionMatch) {
    return `user_${sessionMatch[1]!}`;
  }

  if (USER_PEER_REGEX.test(trimmed)) {
    if (trimmed === 'user_default') return null;
    return trimmed;
  }

  return null;
}

/**
 * 从工具调用上下文 `exec` 中解析当前单聊会话 `peer` (`user_<hash>`)。
 * 无法解析有效 `kujira-user-` / `user_` 单聊标识时严格返回 `null`（Fail-Closed）。
 */
export function resolveContextPeer(context?: unknown): string | null {
  if (!context || typeof context !== 'object') {
    return null;
  }

  const anyCtx = context as Record<string, any>;
  const session = anyCtx.session || anyCtx.agent?.session || anyCtx.agent;
  const rawSessionId =
    session?.id ||
    session?.sessionId ||
    anyCtx.sessionId ||
    anyCtx.peer ||
    '';

  return normalizeStrictUserPeer(rawSessionId);
}

export interface MemoryToolsLimits {
  /** 单个用户画像文件的写入上限 */
  getUserProfileLimit?: () => number;
  /** 单个 Session 规则文件的写入上限 */
  getSessionLimit?: () => number;
}

export class MemoryTools {
  constructor(
    private storage: MemoryStorage,
    private ctx?: Context,
    private limits?: MemoryToolsLimits
  ) {}

  private getUserProfileLimit(): number {
    return this.limits?.getUserProfileLimit?.() ?? DEFAULT_USER_PROFILE_BUDGET_CHARS;
  }

  private getSessionLimit(): number {
    return this.limits?.getSessionLimit?.() ?? DEFAULT_SESSION_MEMORY_BUDGET_CHARS;
  }

  private resolveBoundPeer(boundPeer?: string, args?: unknown): string | null {
    if (boundPeer !== undefined) {
      return normalizeStrictUserPeer(boundPeer);
    }
    const candidate =
      args && typeof args === 'object' ? (args as Record<string, unknown>).peer : undefined;
    return normalizeStrictUserPeer(candidate);
  }

  public async readMemory(
    args: ReadMemoryParams,
    boundPeer?: string
  ): Promise<MemoryOperationResult> {
    const type = args?.type || 'session';

    if (type !== 'session' && type !== 'user') {
      return toLosslessJson({
        success: false,
        message: '无效的记忆类型，仅支持 session 或 user。',
      });
    }

    const targetPeer = this.resolveBoundPeer(boundPeer, args);
    if (!targetPeer) {
      return toLosslessJson({
        success: false,
        message: '缺少有效的单聊会话 peer（需为 user_<hash> 或 kujira-user-<hash>），禁止跨会话或 default 兜底访问。',
      });
    }

    if (type === 'user') {
      const rawContent = await this.storage.readUserProfileRaw(targetPeer);
      const content = rawContent || '';
      const hasContent = Boolean(content.trim());
      return toLosslessJson({
        success: true,
        type: 'user',
        target: targetPeer,
        content,
        message: hasContent
          ? `成功读取用户画像 (${targetPeer})`
          : '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。',
      });
    }

    const rawContent = await this.storage.readSessionMemoryRaw(targetPeer);
    const content = rawContent || '';
    const hasContent = Boolean(content.trim());
    return toLosslessJson({
      success: true,
      type: 'session',
      target: targetPeer,
      content,
      message: hasContent
        ? `成功读取 Session 记忆 (${targetPeer})`
        : '该记忆文件不存在或内容为空。如需记录，请使用 create_memory 创建。',
    });
  }

  public async createMemory(
    args: CreateMemoryParams,
    boundPeer?: string
  ): Promise<MemoryOperationResult> {
    const type = args?.type;
    if (type !== 'session' && type !== 'user') {
      return toLosslessJson({
        success: false,
        message: '无效的记忆类型，仅支持 session 或 user。',
      });
    }

    const targetPeer = this.resolveBoundPeer(boundPeer, args);
    if (!targetPeer) {
      return toLosslessJson({
        success: false,
        message: '缺少有效的单聊会话 peer（需为 user_<hash> 或 kujira-user-<hash>），禁止跨会话或 default 兜底访问。',
      });
    }

    const content = args.content;
    if (content === undefined || content === null || !content.trim()) {
      return toLosslessJson({ success: false, message: '创建内容不能为空。' });
    }

    const limit = type === 'user' ? this.getUserProfileLimit() : this.getSessionLimit();
    if (content.length > limit) {
      return toLosslessJson({
        success: false,
        message: `${type === 'user' ? '用户画像' : 'Session 记忆'}内容长度 (${content.length} 字符) 超出上限 (${limit} 字符)，本次创建未写入。请精简提炼到 ${limit} 字符以内后重新调用 create_memory，或先创建一份简短的基础内容，再用 edit_memory 增量补充。`,
      });
    }

    if (type === 'user') {
      if (await this.storage.existsUserProfile(targetPeer)) {
        return toLosslessJson({
          success: false,
          message: '目标记忆已存在，请使用 edit_memory 修改，不要重复创建。',
        });
      }

      await this.storage.writeUserProfile(targetPeer, content);
      const message = `已创建用户画像 (${targetPeer})`;
      if (this.ctx && typeof (this.ctx as any).emit === 'function') {
        (this.ctx as any).emit('memory/change', {
          type: 'user',
          peer: targetPeer,
          action: 'create',
          content,
          message,
        });
      }
      return toLosslessJson({
        success: true,
        type: 'user',
        target: targetPeer,
        message,
      });
    }

    if (await this.storage.existsSessionMemory(targetPeer)) {
      return toLosslessJson({
        success: false,
        message: '目标记忆已存在，请使用 edit_memory 修改，不要重复创建。',
      });
    }

    await this.storage.writeSessionMemory(targetPeer, content);
    const message = `已创建 Session 记忆 (${targetPeer})`;
    if (this.ctx && typeof (this.ctx as any).emit === 'function') {
      (this.ctx as any).emit('memory/change', {
        type: 'session',
        peer: targetPeer,
        action: 'create',
        content,
        message,
      });
    }
    return toLosslessJson({
      success: true,
      type: 'session',
      target: targetPeer,
      message,
    });
  }

  public async editMemory(
    args: EditMemoryParams,
    boundPeer?: string
  ): Promise<MemoryOperationResult> {
    const type = args?.type;
    if (type !== 'session' && type !== 'user') {
      return toLosslessJson({
        success: false,
        message: '无效的记忆类型，仅支持 session 或 user。',
      });
    }

    const targetPeer = this.resolveBoundPeer(boundPeer, args);
    if (!targetPeer) {
      return toLosslessJson({
        success: false,
        message: '缺少有效的单聊会话 peer（需为 user_<hash> 或 kujira-user-<hash>），禁止跨会话或 default 兜底访问。',
      });
    }

    if (args.old_string === undefined || args.old_string === null || args.old_string === '') {
      return toLosslessJson({ success: false, message: 'old_string 不能为空。' });
    }

    const oldStr = args.old_string;
    const newStr = args.new_string ?? '';
    let preview = '';

    const doReplace = (currentContent: string) => {
      if (!currentContent || !currentContent.trim()) {
        throw new Error('目标记忆不存在，请先 create_memory 创建。');
      }

      let count = 0;
      let firstIndex = -1;
      let pos = 0;
      while ((pos = currentContent.indexOf(oldStr, pos)) !== -1) {
        count++;
        if (firstIndex === -1) firstIndex = pos;
        pos += oldStr.length;
      }

      if (count === 0) {
        throw new Error('old_string 未在当前记忆中找到，可能内容已变化，请先 read_memory 获取最新内容。');
      }

      if (count >= 2) {
        throw new Error(`old_string 出现 ${count} 次，请补充更多上下文使其唯一。`);
      }

      const newContent =
        currentContent.slice(0, firstIndex) +
        newStr +
        currentContent.slice(firstIndex + oldStr.length);

      const limit = type === 'user' ? this.getUserProfileLimit() : this.getSessionLimit();
      if (newContent.length > limit) {
        throw new Error(
          `${type === 'user' ? '用户画像' : 'Session 记忆'}编辑后总长度 (${newContent.length} 字符) 超出上限 (${limit} 字符)，本次编辑未落盘。还需再缩减 ${newContent.length - limit} 字符；请精简合并或删除过时、冗余条目后重试。`
        );
      }

      const preStart = Math.max(0, firstIndex - 30);
      const postEnd = Math.min(newContent.length, firstIndex + newStr.length + 30);
      preview = newContent.slice(preStart, postEnd);
      return newContent;
    };

    let updateResult: { success: boolean; content: string; error?: string };
    if (type === 'user') {
      if (!(await this.storage.existsUserProfile(targetPeer))) {
        return toLosslessJson({
          success: false,
          message: '目标记忆不存在，请先 create_memory 创建。',
        });
      }
      updateResult = await this.storage.updateUserProfile(targetPeer, doReplace);
    } else {
      if (!(await this.storage.existsSessionMemory(targetPeer))) {
        return toLosslessJson({
          success: false,
          message: '目标记忆不存在，请先 create_memory 创建。',
        });
      }
      updateResult = await this.storage.updateSessionMemory(targetPeer, doReplace);
    }

    if (!updateResult.success) {
      return toLosslessJson({
        success: false,
        message: updateResult.error || '编辑记忆失败。',
      });
    }

    const message = `已编辑${type === 'user' ? '用户画像' : 'Session 记忆'} (${targetPeer})：${preview}`;

    if (this.ctx && typeof (this.ctx as any).emit === 'function') {
      (this.ctx as any).emit('memory/change', {
        type,
        peer: targetPeer,
        action: 'edit',
        old_string: oldStr,
        new_string: newStr,
        preview,
        message,
      });
    }

    return toLosslessJson({
      success: true,
      type,
      target: targetPeer,
      preview,
      message,
    });
  }
}
