/**
 * kujira: /会话 命令处理器
 */

import {
  formatFallbackSessionTitle,
  formatSessionVersionTag,
} from '../../gateway/session.js';
import type { CommandContext, CommandResult } from '../types.js';

export async function handleSessionCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  const sm = context.sessionManager;
  if (!sm) {
    return {
      handled: true,
      success: false,
      error: '执行 /会话 失败: 当前环境缺少 SessionManager 服务',
    };
  }
  const peer = sm.sessionIdToPeer(context.session.id);
  const sessions = sm.listPeerSessionIds(peer); // 升序：旧→新

  const formatEntry = (sid: string): { displayTitle: string; tag: string; label: string } => {
    const aiTitle = sm.getSessionTitle?.(sid);
    const tag = formatSessionVersionTag(sid);
    const displayTitle = aiTitle || formatFallbackSessionTitle(sid);
    const label = aiTitle ? `${displayTitle} (${tag})` : displayTitle;
    return { displayTitle, tag, label };
  };

  if (!args) {
    if (sessions.length === 0) {
      return {
        handled: true,
        success: true,
        reply: '历史会话列表：\n暂无历史会话。',
      };
    }
    const currentSid = sm.peerToSessionId(peer);
    const lines = [...sessions].reverse().map((sid, i) => {
      const num = sessions.length - i;
      const isCurrent = sid === currentSid ? ' [当前]' : '';
      const { label } = formatEntry(sid);
      return `${num}.${isCurrent} ${label} [${sid}]`;
    });
    return {
      handled: true,
      success: true,
      reply: `历史会话列表：\n${lines.join('\n')}\n\n切换方法：\n- 按序号切换：/会话 <序号>\n- 按标题或标识切换：/会话 <关键字>`,
    };
  }

  const trimmedArgs = args.trim();
  let targetSid: string | undefined;
  const numArg = parseInt(trimmedArgs, 10);
  if (!isNaN(numArg) && /^\d+$/.test(trimmedArgs)) {
    if (numArg < 1 || numArg > sessions.length) {
      return {
        handled: true,
        success: false,
        error: `序号无效，范围 1~${sessions.length}`,
      };
    }
    targetSid = sessions[numArg - 1];
  } else {
    const lowerArgs = trimmedArgs.toLowerCase();
    const matched = sessions.filter((sid) => {
      const { displayTitle, tag } = formatEntry(sid);
      return (
        displayTitle.toLowerCase().includes(lowerArgs) ||
        tag.toLowerCase().includes(lowerArgs) ||
        sid.toLowerCase().includes(lowerArgs)
      );
    });
    if (matched.length === 1) {
      targetSid = matched[0];
    } else if (matched.length > 1) {
      const candidates = matched
        .map((sid) => `- ${formatEntry(sid).label} [${sid}]`)
        .join('\n');
      return {
        handled: true,
        success: false,
        error: `发现多个匹配的会话，请使用序号切换：\n${candidates}`,
      };
    } else {
      return {
        handled: true,
        success: false,
        error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
      };
    }
  }

  if (!targetSid) {
    return {
      handled: true,
      success: false,
      error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
    };
  }

  const ok = sm.resumeSession(peer, targetSid);
  const { label } = formatEntry(targetSid);
  return ok
    ? {
        handled: true,
        success: true,
        reply: `已切换到会话：${label} [${targetSid}]`,
      }
    : {
        handled: true,
        success: false,
        error: '恢复失败：会话不存在或已归档',
      };
}
