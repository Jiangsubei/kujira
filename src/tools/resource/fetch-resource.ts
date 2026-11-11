/**
 * kujira: 单聊资源抓取工具 (fetch_chat_resource)
 *
 * 适配 QQ 官方 Bot API v2 C2C 单聊：
 * - 彻底移除 busid / group_id / group-file-resolve / private-file / WSL 翻译 / OneBot get_file；
 * - 按 file_id / msg_id 查库复用已有 local_path，或从 attachments 描述符提取直链裸 GET 落盘；
 * - 无可用直链时明确提示官方 API 不支持按 file_id 事后刷新旧资源链接；
 * - 任何错误信息与结果严禁泄漏带 query 凭证的 URL。
 */

import * as fs from 'node:fs';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  FetchChatResourceParams,
  FetchChatResourceResult,
  FetchResourceItem,
  FetchChatResourceItemResult,
  MessageRecord,
} from '../../types/index.js';
import type { AttachmentDescriptor } from '../../attachment/types.js';
import { sanitizeAttachmentFileName } from '../../attachment/classify.js';
import { descriptorsFromRaw, deserializeAttachments } from '../../attachment/store.js';
import { sanitizeUrlForLog, type MediaResourceType } from '../../storage/media.js';
import { sanitizeErrorMessage } from '../../gateway/inbound-media.js';
import { isShortMessageId } from '../../utils/short-id.js';
import {
  type ToolExecutionContext,
  type ContextSource,
  getGlobalToolContext,
  resolveToolContext,
  normalizePeer,
  resolveSessionPeerFromExec,
} from '../common/context.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type {
  FetchChatResourceParams,
  FetchChatResourceResult,
  FetchResourceItem,
  FetchChatResourceItemResult,
};

/**
 * 飞行中下载任务去重 Map：相同 file_id 在拉取期间共享同一个 Promise，
 * 防止并发击穿、重复拉取与文件覆盖竞争。
 */
export const inFlightDownloads = new Map<string, Promise<FetchChatResourceItemResult>>();

const isHttpUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value.trim());

function mapDescriptorKindToMediaType(kind?: string): MediaResourceType {
  switch (kind) {
    case 'record':
      return 'voice';
    case 'image':
      return 'image';
    case 'sticker':
      return 'sticker';
    case 'video':
      return 'video';
    default:
      return 'files';
  }
}

function findMatchingDescriptor(
  descriptors: AttachmentDescriptor[],
  fileId: string
): AttachmentDescriptor | undefined {
  if (descriptors.length === 0) return undefined;
  return (
    descriptors.find(
      (d) =>
        d.remote?.fileId === fileId ||
        d.remote?.fileUuid === fileId ||
        d.remote?.fileInfo === fileId
    ) ?? descriptors[0]
  );
}

function collectCandidateUrls(
  item: FetchResourceItem,
  matched: AttachmentDescriptor | undefined,
  fileId: string
): Array<{ url: string; isVoiceWav: boolean }> {
  const candidates: Array<{ url: string; isVoiceWav: boolean }> = [];
  const seen = new Set<string>();

  const push = (raw: unknown, isVoiceWav = false) => {
    if (!isHttpUrl(raw)) return;
    const trimmed = raw.trim();
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ url: trimmed, isVoiceWav });
  };

  push(item.url, false);

  if (matched?.remote) {
    if (matched.kind === 'record') {
      push(matched.remote.voiceWavUrl, true);
      push(matched.remote.url, false);
    } else {
      push(matched.remote.url, false);
      push(matched.remote.voiceWavUrl, true);
    }
  }

  push(fileId, false);
  return candidates;
}

/**
 * 内部单文件拉取执行单元（支持 Single-Flight 去重）
 */
export async function fetchSingleChatResourceItem(
  item: FetchResourceItem,
  ctx: ToolExecutionContext
): Promise<FetchChatResourceItemResult> {
  const rawFileId = typeof item?.file_id === 'string' ? item.file_id.trim() : '';
  const directItemUrl = isHttpUrl(item?.url) ? item.url.trim() : '';
  const dedupeKey = rawFileId || directItemUrl;

  if (!dedupeKey) {
    return toLosslessJson({ file_id: '', success: false, error: '缺少有效的 file_id' });
  }

  const ongoing = inFlightDownloads.get(dedupeKey);
  if (ongoing) {
    return ongoing;
  }

  const safeDisplayId = isHttpUrl(dedupeKey) ? sanitizeUrlForLog(dedupeKey) : dedupeKey;
  const requestedName = sanitizeAttachmentFileName(item.file_name);

  const downloadPromise = (async (): Promise<FetchChatResourceItemResult> => {
    const sessionPeer = ctx.peer ? normalizePeer(ctx.peer) : '';

    // 1. 查库：若传入短消息 ID 严格走 getMessageByShortId，否则保留 getByFileId（绝不按长 ROBOT1.0_... 兜底 getMessage）
    let dbRecord: MessageRecord | null = null;
    if (ctx.db && rawFileId && !isHttpUrl(rawFileId)) {
      if (isShortMessageId(rawFileId)) {
        if (sessionPeer) {
          try {
            dbRecord = ctx.db.getMessageByShortId?.(sessionPeer, rawFileId) ?? null;
          } catch {}
        }
      }
      if (!dbRecord) {
        try {
          dbRecord = ctx.db.getByFileId?.(rawFileId) ?? null;
        } catch {}
      }
    }

    // 2. 一级缓存命中：messages.local_path 存在且磁盘文件仍在
    if (dbRecord?.local_path && fs.existsSync(dbRecord.local_path)) {
      return toLosslessJson({
        file_id: safeDisplayId,
        ...(requestedName ? { file_name: requestedName } : {}),
        success: true,
        local_path: dbRecord.local_path,
      });
    }

    // 3. 解析附件描述符 JSON（缺失时尝试从 raw 事件反解）
    let descriptors = deserializeAttachments(dbRecord?.attachments);
    if (descriptors.length === 0 && dbRecord?.raw) {
      descriptors = descriptorsFromRaw(dbRecord.raw);
    }
    const matched = findMatchingDescriptor(descriptors, rawFileId);
    const resolvedFileName = requestedName || sanitizeAttachmentFileName(matched?.fileName);

    if (matched?.local?.path && fs.existsSync(matched.local.path)) {
      return toLosslessJson({
        file_id: safeDisplayId,
        ...(resolvedFileName ? { file_name: resolvedFileName } : {}),
        success: true,
        local_path: matched.local.path,
      });
    }

    // 4. 提取带协议直链（voice 优先 voiceWavUrl）
    const candidates = collectCandidateUrls(item, matched, rawFileId);
    if (candidates.length === 0) {
      return toLosslessJson({
        file_id: safeDisplayId,
        ...(resolvedFileName ? { file_name: resolvedFileName } : {}),
        success: false,
        error: `资源直链不存在或已过期，QQ 官方 Bot API 不支持按 file_id 事后刷新旧资源链接 (file_id: ${safeDisplayId})`,
      });
    }

    if (!ctx.mediaManager) {
      return toLosslessJson({
        file_id: safeDisplayId,
        ...(resolvedFileName ? { file_name: resolvedFileName } : {}),
        success: false,
        error: '下载失败: 媒体存储服务不可用，无法落盘',
      });
    }

    // 5. 裸 GET 落盘并回写本地路径
    const mediaType = mapDescriptorKindToMediaType(matched?.kind);
    const isUrlAsId = isHttpUrl(rawFileId);
    let lastError = '下载失败';

    for (const candidate of candidates) {
      try {
        const saved = await ctx.mediaManager.downloadAndSave(candidate.url, {
          type: mediaType,
          ...(sessionPeer ? { sessionId: sessionPeer } : {}),
          ...(rawFileId && !isUrlAsId ? { fileId: rawFileId } : {}),
          ...(resolvedFileName ? { filename: resolvedFileName } : {}),
          ...(candidate.isVoiceWav ? { ext: 'wav' } : {}),
        });
        if (saved?.localPath) {
          if (dbRecord?.msg_id && ctx.db?.updateLocalPath) {
            try {
              ctx.db.updateLocalPath(dbRecord.msg_id, saved.localPath, saved.fingerprint);
            } catch {}
          }
          return toLosslessJson({
            file_id: safeDisplayId,
            ...(resolvedFileName ? { file_name: resolvedFileName } : {}),
            success: true,
            local_path: saved.localPath,
          });
        }
      } catch (err) {
        lastError = sanitizeErrorMessage(err);
      }
    }

    return toLosslessJson({
      file_id: safeDisplayId,
      ...(resolvedFileName ? { file_name: resolvedFileName } : {}),
      success: false,
      error: `下载失败: ${lastError}`,
    });
  })();

  inFlightDownloads.set(dedupeKey, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    inFlightDownloads.delete(dedupeKey);
  }
}

export async function fetchChatResource(
  params: FetchChatResourceParams,
  context?: ToolExecutionContext
): Promise<FetchChatResourceResult> {
  const ctx = { ...getGlobalToolContext(), ...context };

  const hasFilesArray = Array.isArray(params?.files) && params.files.length > 0;
  const trimmedExplicitMsgId = typeof params?.msg_id === 'string' ? params.msg_id.trim() : '';
  if (!hasFilesArray && trimmedExplicitMsgId && !params?.file_id?.trim() && !isShortMessageId(trimmedExplicitMsgId)) {
    return toLosslessJson({
      success: false,
      error: `无效的 msg_id "${trimmedExplicitMsgId}"，请传入短消息 ID（如 msg_12 或 msg_self_8）`,
    });
  }

  const singleFileId =
    (typeof params?.file_id === 'string' && params.file_id.trim()) ||
    trimmedExplicitMsgId ||
    (isHttpUrl(params?.url) ? params.url!.trim() : '');

  if (!hasFilesArray && !singleFileId) {
    return toLosslessJson({
      success: false,
      error: '你需要指定 file_id、msg_id 或 files 列表',
    });
  }

  const isSingleMode = !hasFilesArray;
  const targetItems: FetchResourceItem[] = isSingleMode
    ? [
        {
          file_id: singleFileId,
          ...(params?.file_name ? { file_name: params.file_name } : {}),
          ...(params?.url ? { url: params.url } : {}),
        },
      ]
    : params!.files!;

  const results: FetchChatResourceItemResult[] = [];
  for (const item of targetItems) {
    const itemRes = await fetchSingleChatResourceItem(item, ctx);
    results.push(itemRes);
  }

  const downloadedCount = results.filter((r) => r.success).length;
  const total = results.length;

  if (isSingleMode) {
    const single = results[0]!;
    if (single.success) {
      return toLosslessJson({
        success: true,
        ...(single.local_path ? { local_path: single.local_path } : {}),
        total: 1,
        downloaded_count: 1,
        results,
      });
    }
    return toLosslessJson({
      success: false,
      error: single.error || '下载失败',
      total: 1,
      downloaded_count: 0,
      results,
    });
  }

  const isOverallSuccess = downloadedCount > 0;
  const firstSuccessPath = results.find((r) => r.success)?.local_path;
  const batchErrors = results
    .filter((r) => !r.success && r.error)
    .map((r) => r.error)
    .join('; ');

  return toLosslessJson({
    success: isOverallSuccess,
    ...(firstSuccessPath ? { local_path: firstSuccessPath } : {}),
    ...(!isOverallSuccess
      ? { error: `批量下载失败: ${batchErrors || '未知原因'}` }
      : {}),
    total,
    downloaded_count: downloadedCount,
    results,
  });
}

export function createFetchChatResourceTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'fetch_chat_resource',
    description:
      '根据资源 file_id、msg_id 或缓存直链将单聊聊天中的附件（图片、语音、视频、文档）拉取到本地磁盘。用于复查本地缓存缺失的入站媒体；下载完成后返回本地物理路径（local_path），供后续文件或图片读取工具消费。如需拉取多个文件，请在单次调用中使用 files 参数批量传入。注意：QQ 官方 Bot API 不支持按 file_id 事后刷新已过期的旧资源链接。',
    parameters: {
      file_id: { type: 'string', description: '单个资源 file_id 或短消息 ID（如 msg_12）(单文件模式填写)' },
      msg_id: { type: 'string', description: '可选：通过短消息 ID（如 msg_12 或 msg_self_8）定位该消息关联的附件并补全落盘' },
      file_name: { type: 'string', description: '保存文件名建议' },
      url: { type: 'string', description: '可选：已知的媒体下载直链（裸 GET 拉取，结果不回显凭证）' },
      files: {
        type: 'array',
        description: '批量拉取文件列表 (多文件模式一次性传入，包含 file_id 与可选 file_name / url)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_id: { type: 'string', required: true, description: '资源 ID 或短消息 ID（如 msg_12）' },
            file_name: { type: 'string', description: '保存文件名建议' },
            url: { type: 'string', description: '可选下载直链' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const res = value as any;
        if (Array.isArray(res?.results) && res.results.length > 1) {
          const lines = [`批量下载结果 (${res.downloaded_count || 0}/${res.total || 0}):`];
          for (const item of res.results) {
            lines.push(
              item.success
                ? `  • ${item.file_name || item.file_id}: 就绪 (${item.local_path})`
                : `  • ${item.file_name || item.file_id}: 失败 (${item.error || '未知错误'})`
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }
        return [
          {
            type: 'text',
            text: res?.success
              ? `资源已就绪: ${res?.local_path}`
              : `资源抓取失败: ${res?.error || '未知原因'}`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const res = await fetchChatResource(args as FetchChatResourceParams, {
        ...resolved,
        peer,
      });
      if (res && res.success === false) {
        throw new Error(res.error || 'fetch_chat_resource 失败');
      }
      return toLosslessJson(res) as any;
    },
  });
}
