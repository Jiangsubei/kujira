/**
 * kujira: 撤回 QQ 单聊消息工具 (recall_message)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { RecallMessageParams, RecallMessageResult } from '../../types/index.js';
import { parseShortMessageId } from '../../utils/short-id.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  isKujiraUserPeer,
  resolveSessionPeerFromExec,
  resolveOutboundBridge,
  resolveShortMessageRecord,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { RecallMessageParams, RecallMessageResult };

function formatRecallFailure(code: string | number | undefined, fallbackMessage?: string): string {
  const codeStr = code !== undefined ? String(code) : '';
  if (codeStr === '40064004') {
    return '撤回失败 (40064004): 已超出 QQ 官方单聊消息 2 分钟（120 秒）撤回硬时限，无法撤回该消息。';
  }
  if (codeStr === '40061002') {
    return '撤回失败 (40061002): 请求参数 message_id 无效，仅可撤回机器人自身发出的出站消息 ID（不可撤回用户发来的入站消息 ID）。';
  }
  if (codeStr === '40061001') {
    return '撤回失败 (40061001): 请求参数 message_id 非法或目标消息不存在。';
  }
  const codeTag = codeStr ? ` (${codeStr})` : '';
  return `撤回失败${codeTag}: ${fallbackMessage || '可能消息已超过 2 分钟撤回时限或非本机出站消息。'}`;
}

/**
 * 撤回 QQ 单聊出站消息 (recall_message)
 * 仅接收出站短 ID (`msg_self_<n>`)，通过 OutboundStreamBridge 查库换取真实消息 ID 后调用 DELETE /v2/users/{openid}/messages/{message_id}。
 */
export async function recallMessage(
  params: RecallMessageParams,
  context?: ToolExecutionContext
): Promise<RecallMessageResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  // 1. 参数校验：仅接收合法短出站消息 ID (msg_self_<n>)
  if (!params || typeof params.message_id !== 'string' || params.message_id.trim() === '') {
    return toLosslessJson({
      success: false,
      error: formatRecallFailure('INVALID_SHORT_ID', '请传入有效的短出站消息 ID（如 msg_self_8）'),
    });
  }
  const parsed = parseShortMessageId(params.message_id);
  if (!parsed) {
    return toLosslessJson({
      success: false,
      error: formatRecallFailure('INVALID_SHORT_ID', '请传入有效的短出站消息 ID（如 msg_self_8）'),
    });
  }
  if (parsed.direction === 'inbound') {
    return toLosslessJson({
      success: false,
      error: formatRecallFailure(
        'INBOUND_NOT_RECALLABLE',
        `只能撤回机器人自身发出的出站消息（msg_self_*），不能撤回对方发来的消息（${parsed.shortId}）。`
      ),
    });
  }

  // 2. 单聊会话校验
  const peer = ctx.peer ? normalizePeer(ctx.peer) : '';
  if (!isKujiraUserPeer(peer)) {
    return toLosslessJson({
      success: false,
      error: 'recall_message 需在 QQ 单聊会话中执行',
    });
  }

  // 3. 解析 OutboundStreamBridge
  const bridge = resolveOutboundBridge({ ...ctx, peer });
  if (!bridge) {
    return toLosslessJson({
      success: false,
      error: 'QQ Gateway 未连接',
    });
  }

  // 4. 经由 per-peer 串行队列下发，确保与发送/媒体消息的出站时序一致
  const serialSender = !ctx.outboundBridge && ctx.sender ? ctx.sender : bridge.getSender();
  const task = () =>
    bridge.recallMessage(peer, parsed.shortId, {
      ...(ctx.openid ? { openid: ctx.openid } : {}),
    });

  try {
    const res = await serialSender.enqueue(peer, task);
    if (res.ok) {
      // 幂等补记本地 db（当外层传入独立的 ctx.db 而 bridge 未绑定同一 db 时兜底）
      try {
        const record = resolveShortMessageRecord(ctx.db, peer, parsed.shortId);
        if (record?.msg_id) {
          ctx.db?.markRecalled?.(record.msg_id);
        }
      } catch {}
      return toLosslessJson({
        success: true,
        message: `消息已成功撤回 (ID: ${parsed.shortId})。`,
      });
    }

    return toLosslessJson({
      success: false,
      error: formatRecallFailure(res.code, res.message),
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `撤回失败: ${err?.message || String(err)}`,
    });
  }
}

export function createRecallMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'recall_message',
    description:
      '撤回当前 QQ 单聊会话中机器人自身发出的指定消息。适用于撤回自己发错、产生幻觉或格式错误的消息。需要传入目标出站消息的短消息 ID（仅支持 msg_self_<n>，如 msg_self_8，来自 send_qq_message / send_file / send_face 返回的 message_id 或 read_chat_history 中的 msg_id）。受 QQ 官方单聊硬性限制，仅支持在发送后 2 分钟（120 秒）内撤回机器人自身发出的消息，超时（40064004）或传入用户入站消息 ID（msg_<n>）将如实报错。',
    parameters: {
      message_id: {
        type: 'string',
        required: true,
        description:
          '需要撤回的机器人自身出站短消息 ID（仅支持 msg_self_<n>，如 msg_self_8，来自 send_qq_message / send_file / send_face 返回的 message_id 或 read_chat_history 中的 msg_id）。',
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
              text: v.message || '消息已成功撤回',
            },
          ];
        }
        return [
          {
            type: 'text',
            text: `消息撤回失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const res = await recallMessage(args as RecallMessageParams, {
        ...resolved,
        peer,
      });
      return toLosslessJson(res) as any;
    },
  });
}
