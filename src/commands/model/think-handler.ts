/**
 * kujira: /思考 命令处理器
 */

import { safeGetService } from '../../gateway/session/agent-runner.js';
import type { CommandContext, CommandResult } from '../types.js';
import { safeSyncSessionModel } from './sync.js';
import { getModelReasoningInfo } from './reasoning.js';

export async function handleThinkCommand(
  args: string,
  context: CommandContext
): Promise<CommandResult> {
  let isSetDefault = false;
  const rawArgs = (args || '').trim();
  const tokens = rawArgs.split(/\s+/).filter(Boolean);
  const filteredTokens: string[] = [];
  for (const tok of tokens) {
    if (tok === '-默认') {
      isSetDefault = true;
    } else {
      filteredTokens.push(tok);
    }
  }
  let thinkArg = filteredTokens.join(' ').trim();
  const zhEffortMap: Record<string, string> = {
    关: 'off',
    关闭: 'off',
    低: 'low',
    高: 'high',
    最大: 'max',
    极高: 'max',
    默认: 'default',
    重置: 'reset',
  };
  if (zhEffortMap[thinkArg]) {
    thinkArg = zhEffortMap[thinkArg];
  }

  const agents = safeGetService(context.ctx, 'agents');
  const agent = agents?.get(context.session.id);
  const curSel =
    context.sessionManager?.getModelSelection(context.session.id) ||
    (agent as any)?.modelSelection?.current;
  const curProv = curSel?.provider || (agent as any)?.options?.provider || 'deepseek-official';
  const curMod = curSel?.model || (agent as any)?.options?.model || 'deepseek-v4-flash';
  const explicitEffort = curSel?.reasoningEffort;
  const configuredDefault = context.sessionManager?.getConfiguredDefaultModel?.();

  const reasoningInfo = await getModelReasoningInfo(context.ctx, curProv, curMod, explicitEffort);

  if (!thinkArg) {
    if (!reasoningInfo.supported) {
      return {
        handled: true,
        success: true,
        reply: '当前模型不支持思考强度设置（该模型无深度思考能力或被提供商禁用）',
      };
    }

    const curName =
      reasoningInfo.efforts.find((e) => e.id === reasoningInfo.currentEffort)?.name ||
      reasoningInfo.currentEffort;
    const currentLine = `当前思考强度：${reasoningInfo.currentEffort}${
      curName && curName !== reasoningInfo.currentEffort ? ` (${curName})` : ''
    }${reasoningInfo.isDefault ? ' [默认]' : ''}`;

    const headerLines: string[] = [`当前模型：${curProv} / ${curMod}`, currentLine];
    if (configuredDefault) {
      headerLines.push(
        `新建会话默认：${configuredDefault.provider} / ${configuredDefault.model} (思考: ${
          configuredDefault.reasoningEffort || '模型默认'
        })`
      );
    }

    const listLines = reasoningInfo.efforts.map((e) => {
      const isDef = e.id === reasoningInfo.defaultEffort ? ' [默认]' : '';
      const isCur = e.id === reasoningInfo.currentEffort ? ' (当前)' : '';
      const desc = e.description ? ` - ${e.description}` : '';
      return `- ${e.id} (${e.name})${isDef}${isCur}${desc}`;
    });

    const reply = [
      ...headerLines,
      '',
      '支持的思考档位：',
      listLines.join('\n'),
      '',
      '切换说明：',
      '- 仅当前会话：/思考 <档位>（例如：/思考 low 或 /思考 max）',
      '- 恢复模型默认：/思考 default',
      '- 设为新建会话默认：在末尾追加 -默认',
    ].join('\n');

    return {
      handled: true,
      success: true,
      reply,
    };
  }

  if (!reasoningInfo.supported) {
    return {
      handled: true,
      success: false,
      error: `切换失败: 当前模型 [${curProv} / ${curMod}] 不支持思考强度设置`,
    };
  }

  const lowerArg = thinkArg.toLowerCase();
  let targetEffort: string | undefined;
  let targetName = '';

  if (lowerArg === 'default' || lowerArg === 'reset') {
    targetEffort = undefined;
    targetName = `模型默认 (${reasoningInfo.defaultEffort})`;
  } else {
    const matched = reasoningInfo.efforts.find(
      (e) => e.id.toLowerCase() === lowerArg || e.name.toLowerCase() === lowerArg
    );
    if (!matched) {
      const validList = reasoningInfo.efforts
        .map((e) => `${e.id} (${e.name})`)
        .join(', ');
      return {
        handled: true,
        success: false,
        error: `无效的思考深度: [${thinkArg}]\n当前模型 [${curProv} / ${curMod}] 实际支持的档位为: ${validList}`,
      };
    }
    targetEffort = matched.id;
    targetName = `${matched.id} (${matched.name})`;
  }

  // 当带 -默认 且已配置不同的新建会话默认模型时，先校验默认模型兼容性，绝不偷偷覆盖默认模型
  let targetDefaultProv = configuredDefault?.provider || curProv;
  let targetDefaultMod = configuredDefault?.model || curMod;
  let preservedDifferentDefault = false;

  if (
    isSetDefault &&
    configuredDefault &&
    (configuredDefault.provider !== curProv || configuredDefault.model !== curMod)
  ) {
    const defaultReasoning = await getModelReasoningInfo(
      context.ctx,
      configuredDefault.provider,
      configuredDefault.model,
      configuredDefault.reasoningEffort
    );

    if (!defaultReasoning.supported) {
      return {
        handled: true,
        success: false,
        error: `设置默认思考深度失败：当前新建会话默认模型 [${configuredDefault.provider} / ${configuredDefault.model}] 不支持深度思考（可先执行 /模型 <模型> -默认 更换默认模型，或去掉 -默认 仅切换当前会话）`,
      };
    }

    if (
      targetEffort !== undefined &&
      !defaultReasoning.efforts.some((e) => e.id === targetEffort)
    ) {
      const validDefaultList = defaultReasoning.efforts
        .map((e) => `${e.id} (${e.name})`)
        .join(', ');
      return {
        handled: true,
        success: false,
        error: `设置默认思考深度失败：当前新建会话默认模型 [${configuredDefault.provider} / ${configuredDefault.model}] 不支持思考档位 [${targetEffort}]（支持档位：${validDefaultList}；可先执行 /模型 <模型> -默认 更换默认模型，或去掉 -默认 仅切换当前会话）`,
      };
    }

    targetDefaultProv = configuredDefault.provider;
    targetDefaultMod = configuredDefault.model;
    preservedDifferentDefault = true;
  }

  try {
    // 无论是否带 -默认，先切换当前会话的思考深度并仅同步当前会话
    context.sessionManager?.setModelSelection(
      context.session.id,
      curProv,
      curMod,
      targetEffort
    );
    if (agent && (agent as any).modelSelection?.current) {
      (agent as any).modelSelection.current.reasoningEffort = targetEffort;
    }
    await safeSyncSessionModel(
      context.ctx,
      context.session.id,
      curProv,
      curMod,
      targetEffort
    );

    if (isSetDefault) {
      if (typeof context.sessionManager?.setConfiguredDefaultModel === 'function') {
        context.sessionManager.setConfiguredDefaultModel(
          targetDefaultProv,
          targetDefaultMod,
          targetEffort
        );
      } else if (typeof context.sessionManager?.setKujiraDefaultModel === 'function') {
        context.sessionManager.setKujiraDefaultModel(
          targetDefaultProv,
          targetDefaultMod,
          targetEffort
        );
      }

      const defaultHint = preservedDifferentDefault
        ? `已设为新建会话默认思考深度（作用于默认模型 ${targetDefaultProv} / ${targetDefaultMod}，下一次开启新会话将默认生效）。`
        : '已设为新建会话默认思考深度（下一次开启新会话将默认生效）。';

      return {
        handled: true,
        success: true,
        reply: [`当前会话思考深度已切换为：${targetName}`, defaultHint].join('\n'),
      };
    }

    return {
      handled: true,
      success: true,
      reply: [
        `当前会话思考深度已切换为：${targetName}`,
        '提示：仅对当前会话生效；设为新建会话默认请追加 -默认。',
      ].join('\n'),
    };
  } catch (err: any) {
    return {
      handled: true,
      success: false,
      error: `设置思考深度失败: ${err?.message || String(err)}`,
    };
  }
}
