/**
 * kujira: 展开合并转发工具 (expand_forward_message)
 *
 * 适配 QQ 官方 Bot API v2 `message_type = 102` 已展开合并转发文本：
 * - 彻底移除 OneBot `get_forward_msg` 与段 JSON 数组解析；
 * - 按 msg_id / forward_id / message_id 从本地消息库查找持久化的合并转发记录（或直接解析传入的 content）；
 * - 若含 `multimedia.nt.qq.com.cn` 等内嵌凭证图片 URL，调用 `resolveEmbeddedForwardImages` 裸 GET 限量落盘（上限 10 张）
 *   并通过 `sanitizeForwardContentUrls` 彻底脱敏（绝不返回明文 rkey / token）；
 * - 解析 `=== 消息 N ===`、`[发送者]`、`[消息内容]`、`[附件k]` 为结构化 ForwardNode 列表返回。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ExpandForwardMessageParams,
  ExpandForwardMessageResult,
  ForwardEmbeddedAttachment,
  ForwardNode,
  MessageRecord,
} from '../../types/index.js';
import {
  resolveEmbeddedForwardImages,
  sanitizeForwardContentUrls,
} from '../../gateway/inbound-media.js';
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
  ExpandForwardMessageParams,
  ExpandForwardMessageResult,
  ForwardEmbeddedAttachment,
  ForwardNode,
};

export type ExpandForwardToolResult = ExpandForwardMessageResult & { content?: string };
export type ExpandForwardInput = ExpandForwardMessageParams & { message_id?: string };

const MAX_FORWARD_IMAGE_DOWNLOADS = 10;
const NODE_HEADER_RE = /^===\s*消息\s*(\d+)\s*===$/;
const SENDER_LINE_RE = /^\[发送者\]\s*(.*)$/;
const CONTENT_LINE_RE = /^\[消息内容\]\s*(.*)$/;
const ATTACHMENT_LINE_RE = /^\[附件\d+\]\s*(.*)$/;

function parseAttachmentLine(body: string): ForwardEmbeddedAttachment {
  const typeMatch = /类型\s*:\s*([^\s]+)/.exec(body);
  const nameMatch = /文件名\s*:\s*([^\s]+)/.exec(body);
  const dimMatch = /尺寸\s*:\s*([^\s]+)/.exec(body);
  const sizeMatch = /大小\s*:\s*([^\s]+)/.exec(body);
  const localPathMatch = /\[图片:([^\]]+)\]/.exec(body);

  return {
    ...(typeMatch?.[1] ? { type: typeMatch[1].trim() } : {}),
    ...(nameMatch?.[1] ? { filename: nameMatch[1].trim() } : {}),
    ...(dimMatch?.[1] ? { dimensions: dimMatch[1].trim() } : {}),
    ...(sizeMatch?.[1] ? { size_text: sizeMatch[1].trim() } : {}),
    ...(localPathMatch?.[1] ? { local_path: localPathMatch[1].trim() } : {}),
  };
}

/**
 * 将已脱敏的 `message_type=102` 合并转发文本解析为标题与结构化节点列表
 */
export function parseOfficialForwardContent(sanitizedContent: string): {
  title?: string;
  messages: ForwardNode[];
} {
  if (!sanitizedContent || !sanitizedContent.trim()) {
    return { messages: [] };
  }

  const lines = sanitizedContent.split(/\r?\n/);
  const titleLines: string[] = [];
  const nodes: ForwardNode[] = [];

  let current: {
    index: number;
    sender_name?: string;
    contentLines: string[];
    attachments: ForwardEmbeddedAttachment[];
  } | null = null;

  const flushCurrent = () => {
    if (!current) return;
    while (current.contentLines.length > 0 && current.contentLines[0] === '') {
      current.contentLines.shift();
    }
    while (
      current.contentLines.length > 0 &&
      current.contentLines[current.contentLines.length - 1] === ''
    ) {
      current.contentLines.pop();
    }
    nodes.push({
      index: current.index,
      ...(current.sender_name ? { sender_name: current.sender_name } : {}),
      content: current.contentLines.join('\n'),
      ...(current.attachments.length > 0 ? { attachments: current.attachments } : {}),
    });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headerMatch = NODE_HEADER_RE.exec(line.trim());
    if (headerMatch) {
      flushCurrent();
      current = {
        index: Number(headerMatch[1]),
        contentLines: [],
        attachments: [],
      };
      continue;
    }

    if (!current) {
      if (line.trim()) {
        titleLines.push(line.trim());
      }
      continue;
    }

    const senderMatch = SENDER_LINE_RE.exec(line);
    if (senderMatch) {
      const name = senderMatch[1]?.trim();
      if (name) {
        current.sender_name = name;
      }
      continue;
    }

    const contentMatch = CONTENT_LINE_RE.exec(line);
    if (contentMatch) {
      current.contentLines.push(contentMatch[1] ?? '');
      continue;
    }

    const attMatch = ATTACHMENT_LINE_RE.exec(line);
    if (attMatch) {
      const parsedAtt = parseAttachmentLine(attMatch[1] ?? '');
      current.attachments.push(parsedAtt);
      current.contentLines.push(line);
      continue;
    }

    current.contentLines.push(line);
  }

  flushCurrent();

  if (nodes.length === 0) {
    const clean = sanitizedContent.trim();
    return {
      messages: clean ? [{ index: 1, content: clean }] : [],
    };
  }

  const title = titleLines.length > 0 ? titleLines.join('\n') : undefined;
  return {
    ...(title ? { title } : {}),
    messages: nodes,
  };
}

function selectRawForwardText(record: MessageRecord): string {
  const storedContent = typeof record.content === 'string' ? record.content : '';
  if (typeof record.raw === 'string' && record.raw.trim() !== '') {
    try {
      const parsed = JSON.parse(record.raw);
      const rawContent = typeof parsed?.content === 'string' ? parsed.content : '';
      if (
        rawContent.trim() !== '' &&
        (/https?:\/\//i.test(rawContent) && !/\[图片:[^\]]+\]/.test(storedContent))
      ) {
        return rawContent;
      }
      if (!storedContent.trim() && rawContent.trim() !== '') {
        return rawContent;
      }
    } catch {
      // ignore non-JSON raw
    }
  }
  return storedContent;
}

/**
 * 展开官方 `message_type=102` 合并转发消息并限量落盘内嵌图片（绝不泄漏 rkey 凭证 URL）
 */
export async function expandForwardMessage(
  params: ExpandForwardInput,
  context?: ToolExecutionContext
): Promise<ExpandForwardToolResult> {
  const ctx = { ...getGlobalToolContext(), ...context };
  const targetId = (
    (typeof params?.msg_id === 'string' ? params.msg_id : '') ||
    (typeof params?.forward_id === 'string' ? params.forward_id : '') ||
    (typeof params?.message_id === 'string' ? params.message_id : '')
  ).trim();
  const directContent = typeof params?.content === 'string' ? params.content.trim() : '';

  if (!targetId && !directContent) {
    return toLosslessJson({
      success: false,
      error: '你需要指定 msg_id（或 forward_id / content）',
    });
  }

  let rawForwardText = directContent;
  let peer = ctx.peer ? normalizePeer(ctx.peer) : '';

  if (!rawForwardText && targetId) {
    if (!ctx.db) {
      return toLosslessJson({
        success: false,
        error: '展开合并转发失败: 数据库不可用，无法查询合并转发消息记录',
      });
    }

    const record =
      ctx.db.getMessage?.(targetId) ??
      ctx.db.getMessageByRefIdx?.(targetId) ??
      ctx.db.getByFileId?.(targetId) ??
      null;

    if (!record) {
      return toLosslessJson({
        success: false,
        error: `展开合并转发失败: 未找到合并转发消息记录 (${targetId})`,
      });
    }

    if (!peer && record.peer) {
      peer = normalizePeer(record.peer);
    }
    rawForwardText = selectRawForwardText(record);
  }

  if (!rawForwardText || rawForwardText.trim() === '') {
    return toLosslessJson({
      success: false,
      error: '展开合并转发失败: 目标消息没有可展开的文本内容',
    });
  }

  try {
    const resolved = await resolveEmbeddedForwardImages(
      rawForwardText,
      peer || 'common',
      ctx.mediaManager || undefined,
      MAX_FORWARD_IMAGE_DOWNLOADS
    );
    const safeContent = sanitizeForwardContentUrls(
      resolved.sanitizedContent,
      resolved.replacements
    );
    const parsed = parseOfficialForwardContent(safeContent);
    const imagesDownloaded = resolved.localPaths.length;

    return toLosslessJson({
      success: true,
      ...(parsed.title ? { title: parsed.title } : {}),
      content: safeContent,
      messages: parsed.messages,
      ...(imagesDownloaded > 0 ? { images_downloaded: imagesDownloaded } : {}),
    });
  } catch (err: any) {
    return toLosslessJson({
      success: false,
      error: `展开合并转发失败: ${err?.message || '未知错误'}`,
    });
  }
}

export function createExpandForwardMessageTool(context?: ContextSource): ToolDefinition {
  return defineTool({
    name: 'expand_forward_message',
    description:
      '解析并整理单聊收到的聊天记录合并转发（official message_type=102 已展开文本）的结构化节点，并将其中内嵌的图片附件限量下载落盘（最多 10 张）且替换为安全本地路径。传入合并转发消息的 msg_id（或 forward_id / content）即可使用。',
    parameters: {
      msg_id: {
        type: 'string',
        description: '入站合并转发消息的 msg_id（优先查库读取 message_type=102 原文并落盘内嵌图片）',
      },
      forward_id: {
        type: 'string',
        description: '可选兼容参数，等价于 msg_id',
      },
      message_id: {
        type: 'string',
        description: '可选兼容参数，等价于 msg_id',
      },
      content: {
        type: 'string',
        description: '可选：直接传入合并转发展开原文进行解析与图片脱敏落盘',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as any;
        if (!v?.success) {
          return [{ type: 'text', text: `展开合并转发失败: ${v?.error}` }];
        }
        return [
          {
            type: 'text',
            text: v.content || JSON.stringify(v.messages || [], null, 2),
          },
        ];
      },
    },
    async execute(args, exec) {
      const resolved = resolveToolContext(context);
      const peer = resolveSessionPeerFromExec(exec, resolved.peer);
      const res = await expandForwardMessage(args as ExpandForwardInput, {
        ...resolved,
        ...(peer ? { peer } : {}),
      });
      if (res && res.success === false) {
        throw new Error(res.error || 'expand_forward_message 失败');
      }
      return toLosslessJson(res) as any;
    },
  });
}
