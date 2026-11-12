/**
 * kujira: 单聊聊天历史检索工具 (read_chat_history)
 *
 * 严格单聊强隔离：
 * - Agent 工具 schema 与 execute 均不接受跨会话 peer、source、user_id 或 sender_name 覆盖，强制绑定当前单聊 session 归一化后的 user_<hash16>；
 * - 仅检索 source='qq' 的真实单聊收发消息，输出短消息 ID (`msg_<n>` / `msg_self_<n>`)。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ReadChatHistoryParams, ReadChatHistoryResult } from '../../types/index.js';
import type { MessageDatabase } from '../../storage/database.js';
import {
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  isKujiraUserPeer,
  resolveSessionPeerFromExec,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';
import { normalizeLimit, normalizeOffset } from '../pagination.js';

export type { ReadChatHistoryParams, ReadChatHistoryResult };
export { normalizePeer };

/**
 * 检索当前单聊会话历史聊天记录，支持多维度组合筛选。
 */
export async function readChatHistory(
  peerOrParams: string | (ReadChatHistoryParams & { peer?: string }),
  paramsOrDb?: ReadChatHistoryParams | MessageDatabase,
  maybeDb?: MessageDatabase
): Promise<ReadChatHistoryResult> {
  let peer = '';
  let params: ReadChatHistoryParams = {};
  let db = maybeDb || getGlobalToolContext().db;

  if (typeof peerOrParams === 'string') {
    peer = normalizePeer(peerOrParams);
    if (paramsOrDb && typeof (paramsOrDb as any).readHistory === 'function') {
      db = paramsOrDb as MessageDatabase;
    } else {
      params = (paramsOrDb as ReadChatHistoryParams) || {};
    }
  } else if (typeof peerOrParams === 'object' && peerOrParams !== null) {
    peer = normalizePeer(peerOrParams.peer || getGlobalToolContext().peer || '');
    params = peerOrParams;
    if (paramsOrDb && typeof (paramsOrDb as any).readHistory === 'function') {
      db = paramsOrDb as MessageDatabase;
    }
  }

  if (!db) {
    return toLosslessJson({
      messages: [],
      total: 0,
      total_matched: 0,
      offset: normalizeOffset(params.offset),
      limit: normalizeLimit(params.limit, 20, 100),
      has_more: false,
      message: '数据库不可用，暂时无法读取聊天记录。',
    });
  }

  if (!isKujiraUserPeer(peer)) {
    return toLosslessJson({
      messages: [],
      total: 0,
      total_matched: 0,
      offset: normalizeOffset(params.offset),
      limit: normalizeLimit(params.limit, 20, 100),
      has_more: false,
      message: 'read_chat_history 仅支持在 QQ 单聊会话中查询当前会话历史记录。',
    });
  }

  const sanitizedParams: ReadChatHistoryParams = {
    ...params,
    source: 'qq',
  };

  return toLosslessJson(db.readHistory(peer, sanitizedParams));
}

/**
 * 格式化单聊聊天记录为带跨页连续序号的 Markdown 文本
 */
export function renderChatHistoryText(result: ReadChatHistoryResult): string {
  if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
    return result?.message || '未查询到符合条件的聊天记录。';
  }
  const offset = result.offset ?? 0;
  const totalMatched = result.total_matched ?? result.total;
  const lines: string[] = [
    `共匹配 ${totalMatched} 条消息（序号 ${offset + 1}~${offset + result.messages.length}，本次返回 ${result.messages.length} 条）:`,
  ];
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i]!;
    const recalledTag = m.recalled ? ' [已撤回]' : '';
    const replyTag = m.reply_to ? ` [回复 ${m.reply_to}]` : '';
    const timeStr = m.formatted_time || '';
    lines.push(`${offset + i + 1}. [${m.msg_id}] [${timeStr}]${recalledTag}${replyTag} ${m.type}`);
    if (m.content) lines.push(`   ${m.content}`);
  }
  if (result.has_more) {
    lines.push(
      `\n> 还有 ${totalMatched - offset - result.messages.length} 条未展示。继续浏览请传入 \`offset: ${offset + result.messages.length}\`。`
    );
  } else if (result.message) {
    lines.push(`\n> ${result.message}`);
  }
  return lines.join('\n');
}

export function createReadChatHistoryTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'read_chat_history',
    description:
      '检索当前 QQ 单聊会话的本地历史聊天记录（严格隔离在当前会话内）。用于指代不明追溯前情、响应用户查询/复述历史发言，或为消息撤回、收藏表情等下游工具获取目标消息的短消息 ID（msg_id，如 msg_12 或 msg_self_8）；只有需要引用较早或用户明确指代某条消息时，才用取到的 ID 传 reply_to。',
    parameters: {
      keyword: { type: 'string', description: '按消息文本内容关键词模糊搜索' },
      type: {
        type: 'string',
        description:
          "按消息类型筛选，如 'text'(文本), 'image'(图片), 'sticker'(表情包), 'file'(文件), 'forward'(合并转发), 'record'(语音), 'video'(视频), 'reply'(引用回复), 'card'(卡片消息)",
      },
      since: {
        type: 'string',
        description:
          "起始时间：支持毫秒时间戳数字、相对时间 (如 '30m', '2h', '1d', '7d')、裸时间 (如 '19:00', '19:00:00') 或自然日期时间字符串 (如 '10-30 19:00', '2026-10-30 19:00')",
      },
      until: {
        type: 'string',
        description: "截止时间：支持毫秒时间戳数字、相对时间、裸时间 (如 '20:00') 或自然日期时间字符串",
      },
      relative: {
        type: 'string',
        description: "快捷相对时间窗口：检索过去指定时间段内的消息 (如 '1h', '6h', '1d', '7d')",
      },
      has_file: { type: 'boolean', description: '是否仅筛选带有文件/图片/媒体附件的消息' },
      reply_to: {
        type: 'string',
        description: '查询引用了指定短消息 ID 的直接回复消息（如 msg_12 或 msg_self_8）',
      },
      exclude_self: { type: 'boolean', description: '是否排除机器人自身的发言 (默认 false)' },
      self_only: { type: 'boolean', description: '是否仅查询机器人自身的发言 (默认 false)' },
      limit: { type: 'number', description: '返回最大条数 (默认 20，上限 100)' },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（0 表示第 1 条）。翻页时按已展示条数自行推算。',
      },
      order: { type: 'string', enum: ['asc', 'desc'], description: "时间排序 (默认 'desc' 倒序，取最新消息)" },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        { type: 'text', text: renderChatHistoryText(value as unknown as ReadChatHistoryResult) },
      ],
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const currentPeer = resolveSessionPeerFromExec(exec, resolved.peer);
      if (!isKujiraUserPeer(currentPeer)) {
        return toLosslessJson({
          messages: [],
          total: 0,
          total_matched: 0,
          offset: normalizeOffset((args as any)?.offset),
          limit: normalizeLimit((args as any)?.limit, 20, 100),
          has_more: false,
          message: 'read_chat_history 仅支持在 QQ 单聊会话中查询当前会话历史记录。',
        }) as any;
      }

      // 单聊强隔离：强制剔除任何潜在的跨会话参数，锁死当前会话 peer 与 source='qq'
      const {
        peer: _ignoredPeer,
        source: _ignoredSource,
        user_id: _ignoredUserId,
        sender_name: _ignoredSenderName,
        ...safeParams
      } = (args || {}) as Record<string, any>;

      const res = await readChatHistory(
        currentPeer,
        { ...safeParams, source: 'qq' } as ReadChatHistoryParams,
        resolved.db || undefined
      );
      return toLosslessJson(res) as any;
    },
  });
}
