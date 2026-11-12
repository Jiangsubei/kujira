/**
 * kujira: 发送 QQ 单聊消息工具 (send_qq_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SendQqMessageParams, SendQqMessageResult } from '../../types/index.js';
import { QQ_MESSAGE_MAX_BYTES, QQ_SEND_MESSAGE_MAX_CHARS } from '../../constants/index.js';
import { splitByUtf8Bytes } from '../../outbound/render.js';
import { isShortMessageId } from '../../utils/short-id.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  isKujiraUserPeer,
  resolveSessionPeerFromExec,
  resolveOutboundBridge,
  resolveOutboundShortId,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { SendQqMessageParams, SendQqMessageResult };

/**
 * 严格按 UTF-8 字节上限切分消息文本（默认 16 KiB，封装自 splitByUtf8Bytes）。
 * 优先换行断句，次之空格断句，单词超限按 Unicode 码点边界切分，绝不静默截断丢字。
 */
export function splitMessageText(
  text: string,
  maxBytes: number = QQ_MESSAGE_MAX_BYTES
): string[] {
  if (!text || typeof text !== 'string') return [];
  return splitByUtf8Bytes(text, maxBytes);
}

/**
 * 发送 QQ 单聊消息工具 (send_qq_message)
 * 经由 OutboundStreamBridge 统一完成原生 Markdown 发送、6000 字符本地拦截、16 KiB UTF-8 分片、msg_seq 重试与主动降级。
 */
export async function sendQqMessage(
  params: SendQqMessageParams,
  context?: ToolExecutionContext
): Promise<SendQqMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. 参数非空与 6000 字符硬拦截校验
  if (!params || typeof params.text !== 'string' || params.text.trim() === '') {
    return toLosslessJson({ success: false, error: '发送内容不能为空。' });
  }

  const charCount = [...params.text].length;
  if (charCount > QQ_SEND_MESSAGE_MAX_CHARS) {
    return toLosslessJson({
      success: false,
      error: `消息过长（当前 ${charCount} 字符，单次发送上限 ${QQ_SEND_MESSAGE_MAX_CHARS} 字符），请拆分成多条较短的 send_qq_message 分开发送，避免超出 QQ 单条消息限制被客户端截断或静默丢弃。`,
    });
  }

  // 2. QQ 单聊会话上下文校验
  const rawPeer = ctx.peer || '';
  const peer = normalizePeer(rawPeer);
  if (!isKujiraUserPeer(peer)) {
    return toLosslessJson({
      success: false,
      error: 'send_qq_message 需在 QQ 聊天会话中执行（仅支持单聊）',
    });
  }

  // 3. 解析 OutboundStreamBridge
  const bridge = resolveOutboundBridge({ ...ctx, peer });
  if (!bridge) {
    return toLosslessJson({ success: false, error: 'QQ Gateway 未连接' });
  }

  // 4. 校验可选 reply_to 短消息 ID
  let replyTo: string | undefined;
  if (params.reply_to !== undefined && params.reply_to !== null) {
    if (typeof params.reply_to !== 'string') {
      return toLosslessJson({
        success: false,
        error: `无效的 reply_to 短消息 ID "${String(params.reply_to)}"，请传入如 msg_12 或 msg_self_8`,
      });
    }
    const trimmedReplyTo = params.reply_to.trim();
    if (trimmedReplyTo !== '') {
      if (!isShortMessageId(trimmedReplyTo)) {
        return toLosslessJson({
          success: false,
          error: `无效的 reply_to 短消息 ID "${trimmedReplyTo}"，请传入如 msg_12 或 msg_self_8`,
        });
      }
      replyTo = trimmedReplyTo;
    }
  }

  const sendOptions = {
    ...(replyTo ? { replyTo } : {}),
    ...(ctx.openid ? { openid: ctx.openid } : {}),
  };

  try {
    const res =
      !ctx.outboundBridge && ctx.sender
        ? await ctx.sender.enqueue(peer, () => bridge.sendTextReply(peer, params.text, sendOptions))
        : await bridge.sendTextReply(peer, params.text, sendOptions);

    if (!res.ok) {
      const codePart = res.code !== undefined ? ` (code=${res.code})` : '';
      return toLosslessJson({
        success: false,
        error: `消息发送失败: ${res.message || `HTTP ${res.status}`}${codePart}`,
      });
    }

    const rawMsgId =
      typeof res.body?.id === 'string' && res.body.id.trim() !== ''
        ? res.body.id.trim()
        : undefined;
    const shortId = resolveOutboundShortId(ctx, bridge, peer, rawMsgId);

    const previewBase = params.text.trim();
    const previewChars = [...previewBase];
    const sentPreview =
      previewChars.length > 60 ? `${previewChars.slice(0, 60).join('')}...` : previewBase;

    return toLosslessJson({
      success: true,
      ...(shortId ? { message_id: shortId } : {}),
      ...(sentPreview ? { sent_preview: sentPreview } : {}),
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `消息发送失败: ${err?.message || String(err)}`,
    });
  }
}

export function createSendQqMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'send_qq_message',
    description:
      `向当前 QQ 单聊会话发送文本或 Markdown 消息。注意：你的直接文本回复是内部日志，用户不可见；若要向用户发言、回答问题、同步进展或输出结论，必须调用本工具传入 text 参数。单聊原生完整支持 Markdown 富文本格式（包括标题、列表、表格、加粗、引用、代码块与链接等，使用 \`#\` 标题时建议保留空格）。单次发送上限 ${QQ_SEND_MESSAGE_MAX_CHARS} 字符；若要发送的内容较长，或包含多个不同要点、转折与独立意思，可以拆分成多条简短消息，多次调用本工具分开发送。引用回复默认不使用 reply_to：私聊中逐条引用很不自然，日常一问一答、连续短对话、回复刚收到的那条消息都直接传 text 即可，省略 reply_to。仅当需要锚定某条具体消息时才传入其短消息 ID（如 msg_12 或 msg_self_8）——被回复的那条已隔了较久、被后面的消息冲散；用户明确要求引用或回复某条；用户一次发来多条并列问题或图片需逐条对应；或明确指代某条更早的历史消息。发送图片、音视频或文件请使用 send_file，发送表情包请使用 send_face，向用户提问或抉择可使用 ask_user_question。`,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          `要发送给用户的聊天正文（原生支持 Markdown 排版，单次上限 ${QQ_SEND_MESSAGE_MAX_CHARS} 字符，超长请分条发送）。直接填写展示给用户的原始文本，禁止附加任何 XML/HTML 标签、标签闭合符或外层包裹标记。`,
      },
      reply_to: {
        type: 'string',
        description:
          '通常应省略：默认不引用（私聊中逐条引用不自然）。仅当需要锚定某条具体消息时才传入目标短消息 ID（如 msg_12 或 msg_self_8，来自入站消息头、wait_for_user_messages 或 read_chat_history 中的 msg_id）——如被回复的那条已隔较久被后续消息冲散、用户明确要求引用或回复某条、需对多条并列消息逐条对应、或明确指代某条更早的历史消息。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        if (v?.success) {
          return [
            {
              type: 'text',
              text: `消息已发送${v.message_id ? ` (ID: ${v.message_id})` : ''}`,
            },
          ];
        }
        return [
          {
            type: 'text',
            text: `消息发送失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const res = await sendQqMessage(args as SendQqMessageParams, {
        ...resolved,
        peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
