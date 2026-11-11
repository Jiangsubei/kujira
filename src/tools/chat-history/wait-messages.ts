/**
 * kujira: 等待用户消息工具 (wait_for_user_messages)
 *
 * 适配 QQ 官方 Bot API v2 C2C 单聊：
 * - 校验当前会话为 `user_` 单聊；
 * - 移除 `user_id` 参数与 `QQ_ID_RE` 校验（单聊天然单用户）；
 * - 返回收集消息含短消息 ID (`msg_<n>`)、正文、时间戳与可选引用快照。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { WaitCollectedMessage } from '../../gateway/server.js';
import type { WaitForUserMessagesParams } from '../../types/index.js';
import { formatDateTime } from '../../storage/database.js';
import { formatQuotedString } from '../../gateway/external-prompt.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  isKujiraUserPeer,
  resolveSessionPeerFromExec,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { WaitForUserMessagesParams };

export type WaitForUserMessagesResult =
  | { messages: WaitCollectedMessage[]; total: number }
  | { success: false; error: string };

/**
 * wait_for_user_messages 工具：
 * Agent 在一轮内挂起，收集一段时间内到达的当前单聊会话新消息后返回，实现单轮多消息交互。
 */
export async function waitForUserMessages(
  params: WaitForUserMessagesParams,
  context?: ToolExecutionContext
): Promise<WaitForUserMessagesResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. timeout 参数校验
  const timeout = params?.timeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return toLosslessJson({
      success: false,
      error: '你需要指定有效的 timeout（等待秒数，>0）',
    });
  }

  // 2. 单聊会话 peer 校验（必须为 user_<hash>）
  const peer = normalizePeer(ctx.peer || '');
  if (!isKujiraUserPeer(peer)) {
    return toLosslessJson({
      success: false,
      error: '当前会话不是 QQ 单聊会话，无法等待用户消息',
    });
  }

  // 3. registry 未装配 → 明确报错
  if (!ctx.waitRegistry) {
    return toLosslessJson({
      success: false,
      error: '消息等待服务不可用（waitRegistry 未装配），无法等待用户消息',
    });
  }

  // 4. 挂起等待
  const result = await ctx.waitRegistry.wait(peer, {
    timeoutMs: Math.round(timeout * 1000),
    signal: ctx.signal,
  });

  if (result.ok) {
    return toLosslessJson({
      messages: result.messages,
      total: result.messages.length,
    });
  }
  return toLosslessJson({
    success: false,
    error: result.message,
  });
}

/** 等待结果渲染文本 */
export function renderWaitResultText(value: WaitForUserMessagesResult): string {
  if (!('messages' in value)) {
    return `等待用户消息失败: ${value.error}`;
  }
  const messages = value.messages;
  if (messages.length === 0) {
    return '未收集到新消息。';
  }
  const lines = messages.map((m, i) => {
    const timeStr = m.time ? formatDateTime(m.time) : '';
    const quotedText = formatQuotedString(
      m.quoted ? { ...m.quoted, text: m.quoted.text ?? '' } : undefined
    );
    const quoteStr = quotedText ? ` ${quotedText}` : '';
    return `${i + 1}. [${m.msg_id}]${timeStr ? ` [${timeStr}]` : ''}${quoteStr} ${m.content}`;
  });
  return `已收集 ${messages.length} 条新消息:\n${lines.join('\n')}`;
}

export function createWaitForUserMessagesTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'wait_for_user_messages',
    description:
      '临时挂起当前 QQ 单聊会话并等待用户继续发送消息，在指定窗口时间内收集到达的新消息后统一恢复执行。适用于纯图片或截图消息尚无文字说明、用户话只说了半句、明确提示“等等还有”、连续多段发言等确实需要等待对方输入下文的场景（注意：斗图、刷表情包或常规闲聊对话绝不属于此类，切勿滥用）；在调用本工具挂起等待前，通常应首先调用 send_qq_message 向用户发送一条消息给予及时反馈，告知对方你已收到并正在等待其补充或稍作等待，切勿无声挂起；建议优先采用较短的等待时间，例如先等待 30 秒左右，若等待超时后用户仍未继续发送消息，而你判断仍需要等待时，应在再次调用本工具前先发送一条消息主动跟进询问或提醒用户，确认情况后再继续等待，从而保持良好的交互反馈；窗口内收集到消息后将一次性返回供你综合研判和答复。',
    parameters: {
      timeout: {
        type: 'number',
        required: true,
        description:
          '等待秒数（正数），由你自行决定，推荐优先使用 30 秒左右的较短时长，以便在未收到消息时能及时向用户发送消息跟进互动，避免一次性过长挂起导致用户缺少反馈。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderWaitResultText(value as any) }],
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const res = await waitForUserMessages(args as WaitForUserMessagesParams, {
        ...resolved,
        peer,
        signal: exec.signal,
      });
      return toLosslessJson(res) as any;
    },
  });
}
