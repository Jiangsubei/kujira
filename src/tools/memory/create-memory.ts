/**
 * kujira: 创建记忆工具 (create_memory)
 * 严格单聊强隔离：不暴露 peer / user_id 参数，强制绑定当前单聊会话。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CreateMemoryParams } from '../../types/index.js';
import { resolveContextPeer, type MemoryTools } from './common.js';
import { toLosslessJson } from '../../utils/lossless-json.js';

export type CreateMemoryArgs = CreateMemoryParams;

/**
 * 创建 create_memory 工具声明
 */
export function createCreateMemoryTool(tools: MemoryTools): ToolDefinition {
  return defineTool({
    name: 'create_memory',
    description:
      '首次创建当前单聊用户的个人偏好画像（type=\'user\'），或当前单聊会话专属的规则与互动约定（type=\'session\'）（严格隔离在当前单聊内，不可跨会话写入）。适用于在交流或日常闲聊中发现用户确定性事实与长期偏好（如工作风格、技术栈习惯、人设与称呼偏好），或双方长期互动约定时主动建立档案；亦在用户明确要求记住设定时调用。网络梗、词汇代称与流行黑话请使用专有黑话工具（record_slang），勿存入记忆；目标记忆已存在时勿重复创建，应使用 edit_memory 进行更新融合。严禁记录单次排查流水账、命令参数与操作手册、一次性跑分、临时报错、路过客套寒暄、以及因临时环境问题得出的负面断言。内容须保持紧凑高信号的单行陈述（如 "- 偏好：xxx" 或 "- 互动约定：xxx"），避免长篇叙事。',
    parameters: {
      type: {
        type: 'string',
        enum: ['session', 'user'],
        required: true,
        description:
          "记忆类型：'user' 表示创建当前单聊用户的个人画像；'session' 表示创建当前单聊会话专属规则与约定。",
      },
      content: {
        type: 'string',
        required: true,
        description:
          '要写入的完整记忆内容。必须为简练紧凑的 Markdown 条目（建议单条 <80 字），严禁流水账叙事。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.message || `成功创建记忆 (${value.target})`,
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
      const res = await tools.createMemory(
        {
          type: args?.type || 'session',
          content: args?.content,
        },
        peer
      );
      return toLosslessJson(res) as any;
    },
  });
}
