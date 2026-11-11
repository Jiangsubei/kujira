/**
 * kujira: 读取记忆工具 (read_memory)
 * 严格单聊强隔离：不暴露 peer / user_id 参数，强制绑定当前单聊会话。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ReadMemoryParams } from '../../types/index.js';
import { resolveContextPeer, type MemoryTools } from './common.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type ReadMemoryArgs = ReadMemoryParams;

/**
 * 创建 read_memory 工具声明
 */
export function createReadMemoryTool(tools: MemoryTools): ToolDefinition {
  return defineTool({
    name: 'read_memory',
    description:
      '读取当前单聊会话（type=\'session\'）的规则与互动约定，或当前对话用户（type=\'user\'）的个人画像（严格隔离在当前单聊内，不可跨会话查询）。适用于在日常交流或协助任务中，主动查阅以掌握用户深层偏好与习惯风格；当上下文快照提示画像未完全展示时按需查阅，或作为调用 edit_memory 精简修改前获取最新内容与唯一 old_string 的前置工具。日常对话若上下文中已有清晰背景则无需频繁调用。',
    parameters: {
      type: {
        type: 'string',
        enum: ['session', 'user'],
        required: true,
        description: "记忆类型：'session' 表示当前单聊会话规则与约定；'user' 表示当前对话用户的个人画像。",
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value?.content?.trim()
            ? `${value.message || '读取成功'}\n\n${value.content}`
            : value?.message || '记忆内容为空（当前无内容）',
        },
      ],
    },
    async execute(args: any, exec) {
      const peer = resolveContextPeer(exec);
      if (!peer) {
        return toLosslessJson({
          success: false,
          message:
            '记忆工具仅支持在 QQ 单聊会话中使用，当前无法解析有效的单聊会话标识（禁止跨会话或 default 兜底访问）。',
        }) as any;
      }
      const res = await tools.readMemory(
        { type: args?.type || 'session' },
        peer
      );
      return toLosslessJson(res) as any;
    },
  });
}
