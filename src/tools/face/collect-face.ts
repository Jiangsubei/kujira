/**
 * kujira: 偷表情/收藏工具 (collect_face)
 *
 * 适配 QQ 官方 Bot API v2 C2C 单聊：
 * - message_id 仅认短消息 ID（如 msg_12 或 msg_self_8），不兼容长 ID；
 * - 图片判定兼容 targetMsg.attachments 描述符 JSON（kind === 'image' || 'sticker'）与 type；
 * - 使用 DEFAULT_FACE_STORE_DIR (.dsh/kujira/faces) 作为默认存储目录。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CollectFaceParams, CollectFaceResult, MessageRecord } from '../../types/index.js';
import { DEFAULT_FACE_STORE_DIR } from '../../constants/index.js';
import { resolveDshPath } from '../../utils/path.js';
import { isShortMessageId } from '../../utils/short-id.js';
import { isImageFileExt } from '../../attachment/classify.js';
import { descriptorsFromRaw, deserializeAttachments } from '../../attachment/store.js';
import { detectBufferExt } from '../../storage/media.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  resolveSessionPeerFromExec,
  resolveShortMessageRecord,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { CollectFaceParams, CollectFaceResult };

function findImageLocalPathFromRecord(record: MessageRecord): {
  hasImage: boolean;
  localPath: string | null;
} {
  let descriptors = deserializeAttachments(record.attachments);
  if (descriptors.length === 0 && record.raw) {
    descriptors = descriptorsFromRaw(record.raw);
  }

  const imageDesc = descriptors.find(
    (d) =>
      d.kind === 'image' ||
      d.kind === 'sticker' ||
      (d.kind === 'file' && isImageFileExt(d.local?.path || d.fileName))
  );

  const hasImage =
    record.type === 'image' ||
    record.type === 'sticker' ||
    Boolean(imageDesc) ||
    (record.type === 'file' && isImageFileExt(record.local_path));

  if (!hasImage) {
    return { hasImage: false, localPath: null };
  }

  if (record.local_path && fs.existsSync(record.local_path)) {
    return { hasImage: true, localPath: record.local_path };
  }
  if (imageDesc?.local?.path && fs.existsSync(imageDesc.local.path)) {
    return { hasImage: true, localPath: imageDesc.local.path };
  }
  return { hasImage: true, localPath: record.local_path || imageDesc?.local?.path || null };
}

/**
 * 从指定消息（或当前正在回复的入站消息）中提取图片并收录进本地表情库。
 * 修改已有表情标签或删除表情请使用 manage_faces。
 */
export async function collectFace(
  params: CollectFaceParams,
  context?: ToolExecutionContext & { faceDir?: string }
): Promise<CollectFaceResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  if (!params || !params.tags || !Array.isArray(params.tags) || params.tags.length === 0) {
    return toLosslessJson({
      success: false,
      error: '缺少必填参数 tags (内容画面标签，如 ["猫猫", "叹气"])',
    });
  }
  if (!params.mood || typeof params.mood !== 'string' || !params.mood.trim()) {
    return toLosslessJson({
      success: false,
      error: '缺少必填参数 mood (情绪语境意图，如 "嘲讽" / "卖萌" / "感谢")',
    });
  }
  if (!ctx.db) {
    return toLosslessJson({ success: false, error: '数据库不可用' });
  }

  const sessionPeer = ctx.peer ? normalizePeer(ctx.peer) : '';
  const explicitId =
    typeof params.message_id === 'string' && params.message_id.trim() !== ''
      ? params.message_id.trim()
      : undefined;

  let targetMsg: MessageRecord | null = null;
  if (explicitId) {
    if (!isShortMessageId(explicitId)) {
      return toLosslessJson({
        success: false,
        error: `无效的 message_id "${explicitId}"，请传入短消息 ID（如 msg_12 或 msg_self_8）`,
      });
    }
    targetMsg = resolveShortMessageRecord(ctx.db, sessionPeer, explicitId);
  } else if (sessionPeer) {
    const inboundId = ctx.inboundMsgIdGetter?.(sessionPeer);
    const cleanInboundId = typeof inboundId === 'string' ? inboundId.trim() : '';
    if (cleanInboundId) {
      targetMsg = isShortMessageId(cleanInboundId)
        ? resolveShortMessageRecord(ctx.db, sessionPeer, cleanInboundId)
        : (ctx.db.getMessage?.(cleanInboundId) ?? null);
    }
    if (!targetMsg) {
      const recent = ctx.db.readHistory(sessionPeer, { has_file: true, limit: 1 });
      if (recent.messages.length > 0) {
        targetMsg = ctx.db.getMessageByShortId(sessionPeer, recent.messages[0]!.msg_id);
      }
    }
  }

  if (!targetMsg) {
    return toLosslessJson({ success: false, error: '未找到指定的消息记录' });
  }

  const { hasImage, localPath } = findImageLocalPathFromRecord(targetMsg);
  if (!hasImage) {
    return toLosslessJson({ success: false, error: '目标消息中未找到图片或表情附件' });
  }

  if (!localPath || !fs.existsSync(localPath)) {
    return toLosslessJson({
      success: false,
      error: '目标消息的图片本地缓存文件不存在，无法转存',
    });
  }

  try {
    const fileBuf = fs.readFileSync(localPath);
    const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
    const ext =
      detectBufferExt(fileBuf) ||
      path.extname(localPath).replace(/^\./, '').toLowerCase() ||
      'png';
    const size = fileBuf.length;

    const rawStoreDir = context?.faceDir || ctx.faceDir || DEFAULT_FACE_STORE_DIR;
    const storeDir = resolveDshPath(
      context?.dshHome || ctx.dshHome,
      rawStoreDir,
      DEFAULT_FACE_STORE_DIR
    );
    fs.mkdirSync(storeDir, { recursive: true });
    const targetFile = path.resolve(storeDir, `${md5}.${ext}`);

    if (!fs.existsSync(targetFile)) {
      fs.copyFileSync(localPath, targetFile);
    }

    const faceId = `face_${md5.slice(0, 8)}`;
    const safeTags = params.tags;
    const safeMood = params.mood.trim();

    const res = ctx.db.insertFace(
      {
        id: faceId,
        file_path: targetFile,
        md5,
        source: 'collect',
        tags: safeTags,
        mood: safeMood,
        enabled: true,
        size,
        format: ext,
      },
      {
        max: ctx.faceStoreMax,
        evictPolicy: ctx.faceEvictPolicy,
      }
    );

    if (res.duplicated) {
      return toLosslessJson({
        success: true,
        duplicated: true,
        face_id: res.id,
        message: `该表情包已在你的表情库中存在（已有标签: [${res.tags.join(', ')}]，情绪: ${res.mood || '未设置'}）`,
      });
    }

    return toLosslessJson({
      success: true,
      face_id: res.id,
      message: `已成功收藏表情包，标签: [${safeTags.join(', ')}]，情绪: ${safeMood}`,
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `表情入库失败: ${err?.message || '未知错误'}`,
    });
  }
}

export function createCollectFaceTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'collect_face',
    description:
      '将聊天中的图片收录入本地表情库，并打上初始标签与情绪。用于用户要求“把这图存成表情”、聊天中出现值得收藏的好梗图时。修改已有表情标签或删除表情请使用 manage_faces。',
    parameters: {
      tags: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '画面内容与文字标签（如 ["猫猫", "叹气", "生活不易"]，必填）',
      },
      mood: {
        type: 'string',
        required: true,
        description: '情绪与语境意图（如 "嘲讽", "卖萌", "感谢", "无奈", "破防"，必填）',
      },
      message_id: {
        type: 'string',
        description:
          '收藏新表情时的目标短消息 ID（如 msg_12 或 msg_self_8，来自入站消息头或 read_chat_history 中的 msg_id）。若省略则自动绑定当前回合正在回复的入站消息',
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
              ? v.duplicated
                ? `[表情已存在] ${v.message}`
                : `[成功] ${v.message} (face_id: ${v.face_id})`
              : `操作表情失败: ${v?.error}`,
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
      const res = await collectFace(args as CollectFaceParams, {
        ...resolved,
        peer,
        faceDir: resolveDshPath(resolved.dshHome, cfg.face_store_dir, DEFAULT_FACE_STORE_DIR),
        faceStoreMax: cfg.face_store_max ?? resolved.faceStoreMax,
        faceEvictPolicy: cfg.face_evict_policy ?? resolved.faceEvictPolicy,
      });
      return toLosslessJson(res) as any;
    },
  });
}
