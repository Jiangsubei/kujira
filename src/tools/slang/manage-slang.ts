/**
 * kujira: 管理黑话工具 (manage_slang)
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SlangStorage } from '../../slang/storage.js';
import {
  buildOffsetMessage,
  normalizeLimit,
  normalizeOffset,
} from '../pagination.js';
import type {
  ManageSlangParams,
  ManageSlangResult,
} from '../../types/index.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type { ManageSlangParams, ManageSlangResult };

/**
 * 管理黑话核心函数 (list / edit / delete)
 */
export async function manageSlang(
  params: ManageSlangParams,
  storage: SlangStorage
): Promise<ManageSlangResult> {
  const action = params.action;
  const stats = storage.getStats();

  if (action === 'list') {
    const keyword = params.keyword || params.term;
    const inTrash = Boolean(params.in_trash);
    const offset = normalizeOffset(params.offset);
    const limit = normalizeLimit(params.limit, 20, 100);
    const { entries: allEntries, total: totalMatched } = await storage.listEntriesPage(
      keyword,
      offset,
      limit,
      inTrash
    );

    const unitName = inTrash ? '条回收站黑话词条' : '条黑话词条';
    const emptyMsg = inTrash ? '回收站中未查询到任何匹配的黑话词条。' : '未查询到任何匹配的黑话词条。';
    const message =
      totalMatched === 0
        ? emptyMsg
        : buildOffsetMessage({
            offset,
            returned: allEntries.length,
            totalMatched,
            hasMore: offset + allEntries.length < totalMatched,
            ...(offset + allEntries.length < totalMatched
              ? { nextOffset: offset + allEntries.length }
              : {}),
            unit: unitName,
          });

    return toLosslessJson({
      success: true,
      action: 'list',
      entries: allEntries,
      total: allEntries.length,
      total_matched: totalMatched,
      offset,
      limit,
      has_more: offset + allEntries.length < totalMatched,
      max_entries: stats.maxEntries,
      ...(message ? { message } : {}),
    });
  }

  if (action === 'edit') {
    if (!params.term || !params.term.trim()) {
      return toLosslessJson({
        success: false,
        action: 'edit',
        error: '执行 edit 操作必须提供目标黑话词条名称 (term)',
      });
    }
    try {
      const updated = await storage.editEntry(params.term, {
        ...(params.new_term !== undefined ? { new_term: params.new_term } : {}),
        ...(params.tags !== undefined ? { tags: params.tags } : {}),
        ...(params.definition !== undefined ? { definition: params.definition } : {}),
        ...(params.example !== undefined ? { example: params.example } : {}),
      });
      const newStats = storage.getStats();
      return toLosslessJson({
        success: true,
        action: 'edit',
        entry: updated,
        total: newStats.total,
        max_entries: newStats.maxEntries,
        message: `成功更新黑话词条 "${updated.term}" (当前总容量 ${newStats.total}/${newStats.maxEntries} 条)`,
      });
    } catch (err: any) {
      return toLosslessJson({
        success: false,
        action: 'edit',
        error: err?.message || '编辑黑话词条失败',
      });
    }
  }

  if (action === 'delete') {
    if (!params.term || !params.term.trim()) {
      return toLosslessJson({
        success: false,
        action: 'delete',
        error: '执行 delete 操作必须提供目标黑话词条名称 (term)',
      });
    }
    const deleted = await storage.deleteEntry(params.term);
    if (!deleted) {
      return toLosslessJson({
        success: false,
        action: 'delete',
        error: `未找到黑话词条 "${params.term}"，无法删除`,
      });
    }
    const newStats = storage.getStats();
    return toLosslessJson({
      success: true,
      action: 'delete',
      total: newStats.total,
      max_entries: newStats.maxEntries,
      message: `成功删除黑话词条 "${params.term}" (当前总容量 ${newStats.total}/${newStats.maxEntries} 条)`,
    });
  }

  if (action === 'restore') {
    if (!params.term || !params.term.trim()) {
      return toLosslessJson({
        success: false,
        action: 'restore',
        error: '执行 restore 操作必须提供目标黑话词条名称 (term)',
      });
    }
    try {
      const restored = await storage.restoreEntry(params.term);
      const newStats = storage.getStats();
      return toLosslessJson({
        success: true,
        action: 'restore',
        entry: restored,
        total: newStats.total,
        max_entries: newStats.maxEntries,
        message: `成功从回收站复原黑话词条 "${restored.term}" (当前总容量 ${newStats.total}/${newStats.maxEntries} 条)`,
      });
    } catch (err: any) {
      return toLosslessJson({
        success: false,
        action: 'restore',
        error: err?.message || '复原黑话词条失败',
      });
    }
  }

  return toLosslessJson({
    success: false,
    action: action as any,
    error: `不支持的操作类型 "${action}"`,
  });
}

/**
 * 创建 manage_slang 工具声明
 */
export function createManageSlangTool(storage: SlangStorage): ToolDefinition {
  return defineTool({
    name: 'manage_slang',
    description:
      '【知识库管理维护专用】管理与修缮全局黑话知识库（支持检索 list、修改 edit、删除 delete、从 7 天后悔期回收站复原 restore）。模型在准备修改 (edit) 或删除 (delete) 某个词条前，应先通过 list 检索查看其当前内容与已有标签。keyword 支持按标题、标签特征词或释义关键词进行检索与反查；in_trash 可专门检索已淘汰/已删除词条并使用 restore 捞回。日常首次收录新黑话请直接使用 record_slang。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'edit', 'delete', 'restore'],
        description:
          '操作类型：list (检索/列出已有黑话条目内容), edit (修改已有黑话的标签、释义或例句), delete (删除指定黑话), restore (从回收站复原已淘汰或删除的黑话)',
      },
      term: {
        type: 'string',
        description:
          '目标黑话词条名称（action 为 edit, delete 或 restore 时必填；action 为 list 时可选填用于匹配特定词条）',
      },
      new_term: {
        type: 'string',
        description: '修改后的词条名称（仅当 action 为 edit 时生效）',
      },
      tags: {
        type: 'string',
        description:
          '修改或补齐后的触发情境与招牌句式（记录标志句式、口癖或触发情境，严禁写抽象分类）',
      },
      definition: {
        type: 'string',
        description: '修改后的核心释义（仅当 action 为 edit 时提供；若不修改释义可留空）',
      },
      example: {
        type: 'string',
        description: '修改后的典型例句与语境（仅当 action 为 edit 时提供；若不修改例句可留空）',
      },
      keyword: {
        type: 'string',
        description:
          '模糊搜索关键词（仅当 action 为 list 时生效，支持按标题、标签特征词或释义/例句关键词全文反查）',
      },
      in_trash: {
        type: 'boolean',
        description:
          '是否仅检索处于 7 天后悔期（回收站/已淘汰/已删除）的黑话条目（仅当 action 为 list 时生效，默认 false）。设为 true 时可查看被淘汰条目以便调用 restore 捞回。',
      },
      offset: {
        type: 'number',
        description: '起始序号偏移，从 0 开始（仅当 action 为 list 时生效）。翻页时按已展示条数自行推算。',
      },
      limit: {
        type: 'number',
        description: '本次检索返回的最大条目数量（仅当 action 为 list 时生效，默认 20，上限 100）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => {
        if (!value?.success) {
          return [{ type: 'text', text: `操作失败: ${value?.error || '未知错误'}` }];
        }

        if (value?.action === 'list' && Array.isArray(value?.entries)) {
          if (value.entries.length === 0) {
            return [{ type: 'text', text: value?.message || '未查询到任何匹配的黑话词条' }];
          }
          const lines: string[] = [
            value?.message || `查询到 ${value.entries.length} 条黑话词条：`,
            '',
          ];
          const baseOffset = typeof value.offset === 'number' ? value.offset : 0;
          for (let i = 0; i < value.entries.length; i++) {
            const item = value.entries[i];
            const tagStr = item.tags ? ` [标签: ${item.tags}]` : '';
            const exStr = item.example ? `\n   - 例句: ${item.example}` : '';
            lines.push(
              `${baseOffset + i + 1}. 【${item.term}】${tagStr}\n   - 释义: ${item.definition}${exStr}`
            );
          }
          if (value.has_more) {
            const totalMatched =
              typeof value.total_matched === 'number'
                ? value.total_matched
                : value.entries.length;
            lines.push(
              `\n> 还有 ${totalMatched - baseOffset - value.entries.length} 条未展示。继续浏览请传入 \`offset: ${baseOffset + value.entries.length}\`。`
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }

        return [{ type: 'text', text: value?.message || '操作成功' }];
      },
    },
    async execute(args: any) {
      const res = await manageSlang(
        {
          action: args.action,
          ...(args.term !== undefined ? { term: String(args.term) } : {}),
          ...(args.new_term !== undefined ? { new_term: String(args.new_term) } : {}),
          ...(args.tags !== undefined ? { tags: String(args.tags) } : {}),
          ...(args.definition !== undefined ? { definition: String(args.definition) } : {}),
          ...(args.example !== undefined ? { example: String(args.example) } : {}),
          ...(args.keyword !== undefined ? { keyword: String(args.keyword) } : {}),
          ...(typeof args.in_trash === 'boolean' ? { in_trash: args.in_trash } : {}),
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        },
        storage
      );
      return toLosslessJson(res) as any;
    },
  });
}
