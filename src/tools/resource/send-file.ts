/**
 * kujira: 主动发送富媒体/文件工具 (send_file)
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { QQMediaFileType, SendFileParams, SendFileResult } from '../../types/index.js';
import {
  QQ_FILE_TYPE_AUDIO,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  QQ_FILE_TYPE_VIDEO,
} from '../../constants/index.js';
import { buildOutboundMediaAttachment } from '../../attachment/outbound.js';
import { computeBufferMd5, detectBufferExt } from '../../storage/media.js';
import {
  classifySendFileSource,
  detectSendFileType,
  readSendFileBytes,
  type SendFileMediaKind,
} from '../file-source.js';
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

export type { SendFileParams, SendFileResult };

function mapToQqFileType(kind: SendFileMediaKind): QQMediaFileType {
  switch (kind) {
    case 'image':
      return QQ_FILE_TYPE_IMAGE;
    case 'video':
      return QQ_FILE_TYPE_VIDEO;
    case 'voice':
      return QQ_FILE_TYPE_AUDIO;
    case 'file':
    default:
      return QQ_FILE_TYPE_FILE;
  }
}

/**
 * 主动向 QQ 官方 Bot 单聊发送本地图片、视频、语音或文件。
 * 经由 OutboundStreamBridge.sendMediaReply 完成四步分片上传 + msg_type=7 下发。
 */
export async function sendFile(
  params: SendFileParams,
  context?: ToolExecutionContext & { fetchFn?: typeof fetch }
): Promise<SendFileResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || typeof params.file_path !== 'string' || params.file_path.trim() === '') {
    return toLosslessJson({ success: false, error: '你需要指定 file_path' });
  }

  // 1. 归一化文件源（本地绝对路径 / file:// URI / http(s) URL / base64）
  const classified = classifySendFileSource(params.file_path);
  if ('error' in classified) {
    return toLosslessJson({ success: false, error: classified.error });
  }
  const src = classified.source;

  // 2. 校验单聊 peer 与 OutboundStreamBridge
  const peer = ctx.peer ? normalizePeer(ctx.peer) : '';
  if (!isKujiraUserPeer(peer)) {
    return toLosslessJson({
      success: false,
      error: '发送文件失败: 未绑定有效的 QQ 单聊会话 (peer)，无法下发文件',
    });
  }

  const bridge = resolveOutboundBridge({ ...ctx, peer });
  if (!bridge) {
    return toLosslessJson({
      success: false,
      error: '发送文件失败: QQ Gateway 未连接，无法下发文件',
    });
  }

  // 3. 校验存在性/可读性并读取字节流（HTTP 错误日志严格去 query 脱敏）
  const loaded = await readSendFileBytes(src, context?.fetchFn);
  if ('error' in loaded) {
    return toLosslessJson({ success: false, error: loaded.error });
  }

  const fileKind = detectSendFileType(
    params.file_type,
    src.kind === 'url' ? src.value : loaded.fileName,
    src.mimeType
  );
  const fileType = mapToQqFileType(fileKind);
  const md5 = computeBufferMd5(loaded.buffer);
  const fingerprint = crypto.createHash('sha256').update(loaded.buffer).digest('hex');
  const format =
    detectBufferExt(loaded.buffer) ||
    path.extname(loaded.fileName).replace(/^\./, '').toLowerCase() ||
    undefined;

  const attachment = buildOutboundMediaAttachment({
    kind: fileKind,
    ...(src.localPath ? { localPath: src.localPath } : {}),
    fileName: loaded.fileName,
    ...(format ? { format } : {}),
    size: loaded.buffer.length,
    md5,
    fingerprint,
  });

  const mediaInput = {
    buffer: loaded.buffer,
    ...(src.localPath ? { filePath: src.localPath } : {}),
    fileType,
    fileName: loaded.fileName,
    attachments: [attachment],
  };

  const sendOptions = {
    ...(ctx.openid ? { openid: ctx.openid } : {}),
  };

  try {
    const res =
      !ctx.outboundBridge && ctx.sender
        ? await ctx.sender.enqueue(peer, () => bridge.sendMediaReply(peer, mediaInput, sendOptions))
        : await bridge.sendMediaReply(peer, mediaInput, sendOptions);

    if (!res.ok) {
      const codePart = res.code !== undefined ? ` (code=${res.code})` : '';
      return toLosslessJson({
        success: false,
        error: `发送文件失败: ${res.message || `HTTP ${res.status}`}${codePart}`,
      });
    }

    const messageId =
      typeof res.body?.id === 'string' && res.body.id.trim() !== ''
        ? res.body.id.trim()
        : undefined;
    if (!messageId) {
      return toLosslessJson({
        success: false,
        error: '发送结果未知: QQ 网关未返回 message_id，请确认文件已成功下发',
      });
    }

    const refIdx =
      typeof res.body?.ext_info?.ref_idx === 'string' && res.body.ext_info.ref_idx.trim() !== ''
        ? res.body.ext_info.ref_idx.trim()
        : undefined;

    return toLosslessJson({
      success: true,
      message_id: messageId,
      ...(refIdx ? { ref_idx: refIdx } : {}),
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `发送文件失败: ${err?.message || '未知错误'}`,
    });
  }
}

export function createSendFileTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'send_file',
    description:
      '向当前 QQ 单聊发送本地磁盘上的图片、视频、语音或文件产物。用于向用户交付具体的媒体或文件实体；系统会自动执行四步分片上传并通过官方单聊富媒体消息下发。切勿用于发送普通文本聊天消息。',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '本地绝对路径、file:// URI、http(s):// URL 或 base64:// 内容 (必填)',
      },
      file_type: {
        type: 'string',
        enum: ['image', 'file', 'video', 'voice'],
        description:
          '可选显式指定发送的富媒体类型：image(图片)、file(文件)、video(视频)、voice(语音)；省略时按文件扩展名或 MIME 自动推导',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        {
          type: 'text',
          text: (value as any)?.success
            ? `文件发送成功 (message_id: ${(value as any).message_id})`
            : `文件发送失败: ${(value as any)?.error}`,
        },
      ],
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const res = await sendFile(args as SendFileParams, {
        ...resolved,
        peer,
      });
      if (res && res.success === false) {
        throw new Error(res.error || 'send_file 失败');
      }
      return toLosslessJson(res) as any;
    },
  });
}
