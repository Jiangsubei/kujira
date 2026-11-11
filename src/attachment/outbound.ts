/**
 * kujira: 出站附件描述符构造（QQ 官方 Bot API v2 合规单聊）。
 *
 * 官方单聊无 `sub_type` 与群聊维度：
 * - 普通图片/文件/视频/语音统一经四步上传后以 `msg_type=7` 发出；
 * - 已收藏表情包本地精准标注 `kind: 'sticker'` + `face` 元信息，无需 `subType`。
 */

import * as path from 'node:path';
import type { FaceRecord } from '../types/index.js';
import { resolveLocalMediaPath, sanitizeAttachmentFileName } from './classify.js';
import type {
  AttachmentDescriptor,
  AttachmentKind,
  AttachmentLocalMeta,
  AttachmentRemoteMeta,
} from './types.js';

export interface BuildOutboundMediaAttachmentOptions {
  kind: 'image' | 'sticker' | 'file' | 'record' | 'video' | 'voice';
  localPath?: string;
  fileName?: string;
  format?: string;
  size?: number;
  md5?: string;
  fingerprint?: string;
  fileUuid?: string;
  fileInfo?: string;
  fileId?: string;
  contentType?: string;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 构造出站富媒体（图片/文件/语音/视频）附件描述符，保证不含 `undefined` 键。 */
export function buildOutboundMediaAttachment(
  options: BuildOutboundMediaAttachmentOptions
): AttachmentDescriptor {
  const kind: AttachmentKind = options.kind === 'voice' ? 'record' : options.kind;
  const resolvedPath =
    resolveLocalMediaPath(options.localPath) ?? nonEmpty(options.localPath);

  const explicitFileName = sanitizeAttachmentFileName(options.fileName);
  const derivedFileName =
    explicitFileName ??
    (resolvedPath && (kind === 'file' || kind === 'video' || kind === 'record')
      ? sanitizeAttachmentFileName(path.basename(resolvedPath))
      : undefined);

  const format = nonEmpty(options.format);
  const md5 = nonEmpty(options.md5);
  const fingerprint = nonEmpty(options.fingerprint);
  const hasSize = options.size !== undefined && Number.isFinite(options.size);

  const local: AttachmentLocalMeta | undefined = resolvedPath
    ? {
        path: resolvedPath,
        ...(format ? { format } : {}),
        ...(hasSize ? { size: Number(options.size) } : {}),
        ...(md5 ? { md5 } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      }
    : undefined;

  const fileUuid = nonEmpty(options.fileUuid);
  const fileInfo = nonEmpty(options.fileInfo);
  const fileId = nonEmpty(options.fileId);
  const contentType = nonEmpty(options.contentType);

  const remote: AttachmentRemoteMeta | undefined =
    fileUuid || fileInfo || fileId || contentType
      ? {
          ...(fileUuid ? { fileUuid } : {}),
          ...(fileInfo ? { fileInfo } : {}),
          ...(fileId ? { fileId } : {}),
          ...(contentType ? { contentType } : {}),
        }
      : undefined;

  return {
    kind,
    origin: 'outbound',
    ...(remote ? { remote } : {}),
    ...(local ? { local } : {}),
    ...(derivedFileName ? { fileName: derivedFileName } : {}),
  };
}

/** 由已收藏表情构造出站描述符（官方单聊无 `sub_type`，本地直接精准标注 `kind: 'sticker'` + `face`）。 */
export function buildOutboundFaceAttachment(
  face: FaceRecord,
  localPath: string,
  remote?: AttachmentRemoteMeta
): AttachmentDescriptor {
  const resolvedPath = resolveLocalMediaPath(localPath) ?? localPath;
  const tags = Array.isArray(face.tags) && face.tags.length > 0 ? face.tags : undefined;

  const cleanRemote: AttachmentRemoteMeta | undefined = remote
    ? {
        ...(nonEmpty(remote.fileUuid) ? { fileUuid: nonEmpty(remote.fileUuid) } : {}),
        ...(nonEmpty(remote.fileInfo) ? { fileInfo: nonEmpty(remote.fileInfo) } : {}),
        ...(nonEmpty(remote.fileId) ? { fileId: nonEmpty(remote.fileId) } : {}),
        ...(nonEmpty(remote.contentType) ? { contentType: nonEmpty(remote.contentType) } : {}),
      }
    : undefined;

  return {
    kind: 'sticker',
    origin: 'outbound',
    ...(cleanRemote && Object.keys(cleanRemote).length > 0 ? { remote: cleanRemote } : {}),
    local: {
      path: resolvedPath,
      ...(face.format ? { format: face.format } : {}),
      ...(face.size ? { size: face.size } : {}),
      ...(face.md5 ? { md5: face.md5 } : {}),
    },
    face: {
      id: face.id,
      ...(face.mood ? { mood: face.mood } : {}),
      ...(tags ? { tags } : {}),
    },
  };
}
