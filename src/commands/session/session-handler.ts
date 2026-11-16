/**
 * kujira: /会话 命令处理器
 */

import {
  resolvePeerSessionDisplayEntries,
  type PeerSessionDisplayEntry,
} from './title-display.js';
import type { CommandContext, CommandResult } from '../types.js';

function findMatchedSessionEntries(
  entries: PeerSessionDisplayEntry[],
  query: string
): PeerSessionDisplayEntry[] {
  const lowerQuery = query.toLowerCase();
  const exactLabelMatches = entries.filter(
    (entry) => entry.label.toLowerCase() === lowerQuery
  );
  if (exactLabelMatches.length > 0) {
    return exactLabelMatches;
  }

  const labelMatches = entries.filter((entry) =>
    entry.label.toLowerCase().includes(lowerQuery)
  );
  if (labelMatches.length > 0) {
    return labelMatches;
  }

  return entries.filter((entry) => entry.sid.toLowerCase().includes(lowerQuery));
}

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
  const entries = resolvePeerSessionDisplayEntries(sm, peer);
  const trimmedArgs = args.trim();

  if (!trimmedArgs) {
    if (entries.length === 0) {
      return {
        handled: true,
        success: true,
        reply: '历史会话列表：\n暂无历史会话。',
      };
    }
    const currentSid = sm.peerToSessionId(peer);
    const lines = entries.map((entry) => {
      const isCurrent = entry.sid === currentSid ? ' [当前]' : '';
      return `${entry.num}.${isCurrent} ${entry.label}`;
    });
    return {
      handled: true,
      success: true,
      reply: `历史会话列表：\n${lines.join('\n')}\n\n切换方法：\n- 按序号切换：/会话 <序号>\n- 按标题切换：/会话 <标题或关键字>`,
    };
  }

  let targetEntry: PeerSessionDisplayEntry | undefined;
  const numArg = parseInt(trimmedArgs, 10);
  if (!isNaN(numArg) && /^\d+$/.test(trimmedArgs)) {
    if (numArg < 1 || numArg > entries.length) {
      return {
        handled: true,
        success: false,
        error: `序号无效，范围 1~${entries.length}`,
      };
    }
    targetEntry = entries[numArg - 1];
  } else {
    const matched = findMatchedSessionEntries(entries, trimmedArgs);
    if (matched.length === 1) {
      targetEntry = matched[0];
    } else if (matched.length > 1) {
      const candidates = matched
        .map((entry) => `- ${entry.num}. ${entry.label}`)
        .join('\n');
      const exampleLabel = matched[0]!.label;
      return {
        handled: true,
        success: false,
        error: `发现多个匹配的会话，请使用 /会话 <序号> 或完整标题（如 /会话 ${exampleLabel}）切换：\n${candidates}`,
      };
    } else {
      return {
        handled: true,
        success: false,
        error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
      };
    }
  }

  if (!targetEntry) {
    return {
      handled: true,
      success: false,
      error: '切换失败：未找到匹配的会话，请输入 /会话 查看可用列表',
    };
  }

  const ok = sm.resumeSession(peer, targetEntry.sid);
  return ok
    ? {
        handled: true,
        success: true,
        reply: `已切换到会话：${targetEntry.label}`,
      }
    : {
        handled: true,
        success: false,
        error: '恢复失败：会话不存在或已归档',
      };
}
