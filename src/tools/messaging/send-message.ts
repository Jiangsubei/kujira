/**
 * kujira: 发送 QQ 单聊消息工具 (send_qq_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SendQqMessageParams, SendQqMessageResult } from '../../types/index.js';
import { QQ_MESSAGE_MAX_BYTES } from '../../constants/index.js';
import { splitByUtf8Bytes } from '../../outbound/render.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  isKujiraUserPeer,
  resolveSessionPeerFromExec,
  resolveOutboundBridge,
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
 * 经由 OutboundStreamBridge 统一完成 Markdown 分流、16 KiB UTF-8 分片、msg_seq 重试与主动降级。
 */
export async function sendQqMessage(
  params: SendQqMessageParams,
  context?: ToolExecutionContext
): Promise<SendQqMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. 参数非空校验
  if (!params || typeof params.text !== 'string' || params.text.trim() === '') {
    return toLosslessJson({ success: false, error: '发送内容不能为空。' });
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

  const replyTo =
    typeof params.reply_to === 'string' && params.reply_to.trim() !== ''
      ? params.reply_to.trim()
      : undefined;

  const sendOptions = {
    ...(replyTo ? { replyTo } : {}),
    ...(params.markdown !== undefined ? { markdown: params.markdown } : {}),
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

    const msgId =
      typeof res.body?.id === 'string' && res.body.id.trim() !== ''
        ? res.body.id.trim()
        : undefined;
    const refIdx =
      typeof res.body?.ext_info?.ref_idx === 'string' && res.body.ext_info.ref_idx.trim() !== ''
        ? res.body.ext_info.ref_idx.trim()
        : undefined;

    const previewBase = params.text.trim();
    const sentPreview =
      previewBase.length > 60 ? `${previewBase.slice(0, 60)}...` : previewBase;

    return toLosslessJson({
      success: true,
      ...(msgId ? { message_id: msgId } : {}),
      ...(refIdx ? { ref_idx: refIdx } : {}),
      sent_preview: sentPreview,
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
      '向当前 QQ 单聊会话发送文本或 Markdown 消息。注意：你的直接文本回复是内部日志，用户不可见；若要向用户发言、回答问题、同步进展或输出结论，必须调用本工具传入 text 参数。单聊原生完整支持 Markdown 富文本格式（包括标题、列表、表格、加粗、引用、代码块与链接等，使用 `#` 标题时建议保留空格）。若要发送的内容较长，或包含多个不同要点、转折与独立意思，可以拆分成多条简短消息，多次调用本工具分开发送。如需引用消息，请显式传入其字符串 reply_to（优先 REFIDX_... 引用索引，或本地历史消息 ID）。发送图片、音视频或文件请使用 send_file，发送表情包请使用 send_face，向用户提问或抉择可使用 ask_user_question。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          '要发送给用户的聊天正文（支持 Markdown 排版）。直接填写展示给用户的原始文本，禁止附加任何 XML/HTML 标签、标签闭合符或外层包裹标记。',
      },
      reply_to: {
        type: 'string',
        description:
          '需要引用的目标消息索引或消息 ID（优先传入 REFIDX_... 引用索引，或来自入站消息/read_chat_history 的 msg_id 字符串）。',
      },
      markdown: {
        type: 'boolean',
        description:
          '可选：显式指定是否按原生 Markdown (msg_type=2) 发送；省略时遵循插件配置 markdown_enabled。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        if (v?.success) {
          const idPart = v.message_id ? ` (ID: ${v.message_id})` : '';
          const refPart = v.ref_idx ? ` [ref_idx: ${v.ref_idx}]` : '';
          return [
            {
              type: 'text',
              text: `消息已发出${idPart}${refPart}`,
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
