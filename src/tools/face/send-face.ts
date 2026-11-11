/**
 * kujira: 发送表情包工具 (send_face)
 *
 * 适配 QQ 官方 Bot API v2 C2C 单聊：
 * - 移除群聊、sub_type、file:/// URI 与 .dsh/napcat 路径；
 * - 经 OutboundStreamBridge.sendMediaReply 完成四步分片上传 + msg_type=7 下发，
 *   配合 buildOutboundFaceAttachment 在本地精准标注 kind: 'sticker' + face 元信息；
 * - 记录使用频次并返回短出站 ID message_id（msg_self_<n>）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { QQMediaFileType, SendFaceParams, SendFaceResult } from '../../types/index.js';
import { DEFAULT_FACE_STORE_DIR, QQ_FILE_TYPE_IMAGE } from '../../constants/index.js';
import { resolveDshPath } from '../../utils/path.js';
import { buildOutboundFaceAttachment } from '../../attachment/outbound.js';
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

export type { SendFaceParams, SendFaceResult };

/**
 * 凭 face_id 读取本地表情包图片并通过 OutboundStreamBridge 出站（msg_type=7）。
 */
export async function sendFace(
  params: SendFaceParams,
  context?: ToolExecutionContext
): Promise<SendFaceResult> {
  const ctx = { ...getGlobalToolContext(), ...context };
  if (!params || typeof params.face_id !== 'string' || !params.face_id.trim()) {
    return toLosslessJson({ success: false, error: '缺少 face_id 参数' });
  }
  if (!ctx.db) {
    return toLosslessJson({ success: false, error: '数据库不可用' });
  }

  const faceId = params.face_id.trim();
  const face = ctx.db.getFaceById(faceId);
  if (!face) {
    return toLosslessJson({ success: false, error: `表情 ID "${faceId}" 不存在或已被删除` });
  }
  if (!face.enabled) {
    return toLosslessJson({ success: false, error: `表情 ID "${faceId}" 已禁用，不可发送` });
  }

  const peer = ctx.peer ? normalizePeer(ctx.peer) : '';
  if (!isKujiraUserPeer(peer)) {
    return toLosslessJson({ success: false, error: 'send_face 需在 QQ 单聊会话中执行' });
  }

  const bridge = resolveOutboundBridge({ ...ctx, peer });
  if (!bridge) {
    return toLosslessJson({ success: false, error: 'QQ 网关未连接，无法发送表情' });
  }

  const rawPath = face.file_path;
  let localPath = path.isAbsolute(rawPath)
    ? rawPath
    : resolveDshPath(ctx.dshHome, rawPath, DEFAULT_FACE_STORE_DIR);

  // 物理文件存在性校验与 Kujira 规范目录自愈回退
  if (!fs.existsSync(localPath)) {
    const canonicalDir = resolveDshPath(ctx.dshHome, ctx.faceDir, DEFAULT_FACE_STORE_DIR);
    const canonicalPath = path.resolve(canonicalDir, `${face.md5}.${face.format}`);
    if (fs.existsSync(canonicalPath)) {
      localPath = canonicalPath;
      ctx.db.updateFaceFilePath(face.id, canonicalPath);
    } else {
      const candidate = path.resolve(process.cwd(), rawPath);
      if (fs.existsSync(candidate)) {
        try {
          fs.mkdirSync(canonicalDir, { recursive: true });
          fs.copyFileSync(candidate, canonicalPath);
          localPath = canonicalPath;
          ctx.db.updateFaceFilePath(face.id, canonicalPath);
        } catch {}
      }
    }
  }

  if (!fs.existsSync(localPath)) {
    return toLosslessJson({ success: false, error: `表情包本地文件不存在: ${localPath}` });
  }

  const attachment = buildOutboundFaceAttachment(face, localPath);
  const fileName = path.basename(localPath) || `${face.id}.${face.format || 'png'}`;
  const mediaInput = {
    filePath: localPath,
    fileType: QQ_FILE_TYPE_IMAGE as QQMediaFileType,
    fileName,
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
        error: `发送表情失败: ${res.message || `HTTP ${res.status}`}${codePart}`,
      });
    }

    ctx.db.recordFaceUsage(face.id);

    const rawMessageId =
      typeof res.body?.id === 'string' && res.body.id.trim() !== ''
        ? res.body.id.trim()
        : undefined;
    const shortId = resolveOutboundShortId(ctx, bridge, peer, rawMessageId);

    return toLosslessJson({
      success: true,
      ...(shortId ? { message_id: shortId } : {}),
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `发送表情异常: ${err?.message || '未知错误'}`,
    });
  }
}

export function createSendFaceTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'send_face',
    description:
      '根据表情 ID 将一张本地表情包作为独立表情消息发送到当前单聊中。用于聊天中需要精准表达情绪、接梗斗图时；表情 ID 可直接从系统上下文中的本地表情库存清单中选取，亦可来自 list_faces 检索结果。业务图片产物请使用 send_file。',
    parameters: {
      face_id: {
        type: 'string',
        required: true,
        description: '要发送的目标表情 ID (必填，可直接从上下文表情库清单获取或通过 list_faces 检索)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        return [
          {
            type: 'text',
            text: v?.success
              ? `已成功发送表情包${v.message_id ? ` (ID: ${v.message_id})` : ''}`
              : `发送表情包失败: ${v?.error}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const cfg =
        typeof (resolved as any).config === 'function'
          ? (resolved as any).config()
          : (resolved as any).config || {};
      const res = await sendFace(args as SendFaceParams, {
        ...resolved,
        peer,
        faceDir: resolveDshPath(resolved.dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
      });
      return toLosslessJson(res) as any;
    },
  });
}
