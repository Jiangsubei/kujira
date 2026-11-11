/**
 * kujira: 配置动态校验与自愈模块 (Self-Healing Configuration Engine)
 *
 * 核心设计：以 src/config/schema.ts 中的 BridgeConfigSchema 为单一真相源（SSOT），
 * 提供运行时配置清洗与物理配置文件主动自愈能力：
 *   1. getValidConfigKeys: 动态提取当前 Schema 支持的全量有效 volatile 键集合；
 *   2. sanitizeConfigPayload: 纯函数，分离有效配置与无效/过期字段；
 *   3. surgicalCleanYamlConfig / healProfileConfigFile: 物理级安全自愈，扫描并移除 profile patch 中残留的已废弃死配置。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeConfigSchema } from './schema.js';
import { resolveDshHome } from './credentials.js';
import type { BridgePluginConfig } from '../types/index.js';
import { PLUGIN_NAME, SETTINGS_NAMESPACE } from '../constants/index.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * 动态获取当前配置 Schema 定义的所有有效键集合 (单一真相源)
 */
export function getValidConfigKeys(): Set<string> {
  const dict = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
  return new Set(Object.keys(dict));
}

export interface SanitizeResult {
  valid: BridgePluginConfig;
  removed: string[];
}

/**
 * 纯函数：根据当前 Schema 清洗配置对象，分离出干净合法的配置项与无效/过期键。
 */
export function sanitizeConfigPayload<T extends Record<string, any>>(raw: T): SanitizeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: {}, removed: [] };
  }

  const validKeys = getValidConfigKeys();
  const valid: Record<string, any> = {};
  const removed: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (validKeys.has(key)) {
      valid[key] = value;
    } else {
      removed.push(key);
    }
  }

  return { valid: valid as BridgePluginConfig, removed };
}

interface ParsedEntryId {
  indent: number;
  id: string;
}

function parseEntryIdLine(line: string): ParsedEntryId | undefined {
  const match = line.match(/^(\s*)-\s+id:\s*(['"]?)([^'"#\s]+)\2\s*(?:#.*)?$/);
  if (!match) return undefined;
  return { indent: match[1].length, id: match[3] };
}

/**
 * 计算某个缩进层级多行配置块的结束行索引（不含尾部用于分隔同级/外层条目的空行）。
 */
function findChildBlockEnd(lines: string[], startIndex: number, parentIndent: number): number {
  let end = startIndex;
  let j = startIndex + 1;
  while (j < lines.length) {
    const nextLine = lines[j];
    if (nextLine.trim().length === 0) {
      j++;
      continue;
    }
    const nextIndent = nextLine.search(/\S/);
    if (nextIndent !== -1 && nextIndent > parentIndent) {
      end = j;
      j++;
    } else {
      break;
    }
  }
  return end;
}

/**
 * 共享 YAML `config:` 顶层键单趟扫描与外科手术级清洗实现。
 * 严格按精确 `- id:`（非子串匹配）定位目标插件块，避免误伤 `preset-kujira-session` 或 `kujira-tools`。
 */
function scanAndCleanPluginConfig(
  yamlContent: string,
  targetIds: Set<string>,
  isStaleKey: (key: string) => boolean
): {
  newContent: string;
  removedKeys: string[];
} {
  const eol = yamlContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = yamlContent.split(/\r?\n/);
  const removed = new Set<string>();
  const outputLines: string[] = [];

  let inTargetPlugin = false;
  let targetEntryIndent = -1;
  let inConfig = false;
  let configIndent = -1;
  let topKeyIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const entry = parseEntryIdLine(line);
    // 只有外层（未进入 config 或缩进不深于目标条目/config 节点）的 `- id:` 才切换插件作用域，避免误判配置数组内部元素
    if (entry && (!inConfig || entry.indent <= configIndent || entry.indent <= targetEntryIndent)) {
      inTargetPlugin = targetIds.has(entry.id);
      targetEntryIndent = entry.indent;
      inConfig = false;
      configIndent = -1;
      topKeyIndent = -1;
      outputLines.push(line);
      continue;
    }

    if (inTargetPlugin) {
      const lineIndent = line.search(/\S/);
      if (line.trim().length > 0 && lineIndent !== -1 && lineIndent <= targetEntryIndent) {
        inTargetPlugin = false;
        inConfig = false;
        configIndent = -1;
        topKeyIndent = -1;
        outputLines.push(line);
        continue;
      }

      const configMatch = line.match(/^(\s+)config:\s*(?:#.*)?$/);
      if (configMatch && configMatch[1].length > targetEntryIndent) {
        inConfig = true;
        configIndent = configMatch[1].length;
        topKeyIndent = -1;
        outputLines.push(line);
        continue;
      }

      if (inConfig) {
        if (line.trim().length > 0 && lineIndent !== -1 && lineIndent <= configIndent) {
          inConfig = false;
          topKeyIndent = -1;
          outputLines.push(line);
          continue;
        }

        if (line.trim().length > 0 && !line.trim().startsWith('#')) {
          if (topKeyIndent === -1) {
            const firstMatch = line.match(/^(\s+)([a-zA-Z0-9_]+):/);
            if (firstMatch && firstMatch[1].length > configIndent) {
              topKeyIndent = firstMatch[1].length;
            }
          }

          if (topKeyIndent !== -1 && lineIndent === topKeyIndent) {
            const keyMatch = line.match(/^(\s+)([a-zA-Z0-9_]+):/);
            const configKey = keyMatch?.[2];
            if (configKey && isStaleKey(configKey)) {
              removed.add(configKey);
              i = findChildBlockEnd(lines, i, lineIndent);
              continue;
            }
          }
        }
      }
    }

    outputLines.push(line);
  }

  return {
    newContent: outputLines.join(eol),
    removedKeys: Array.from(removed),
  };
}

/**
 * 外科手术式行级 YAML 清洗：
 * 仅定位指定 pluginId 下的 config 节点，精确删除其中的 staleKeys，
 * 绝不重排整个文件，严格保留用户的缩进、注释、空行与 !!js 等特殊语法。
 */
export function surgicalCleanYamlConfig(
  yamlContent: string,
  pluginId: string,
  staleKeys: Set<string>
): {
  newContent: string;
  removedKeys: string[];
} {
  if (!staleKeys.size) {
    return { newContent: yamlContent, removedKeys: [] };
  }

  return scanAndCleanPluginConfig(
    yamlContent,
    new Set([pluginId]),
    (key) => staleKeys.has(key)
  );
}

export interface HealResult {
  healed: boolean;
  removedKeys: string[];
  filePath?: string;
}

/**
 * 物理级自愈：探测并清洗 profile 目录下的 cordis.patch.yml 中残留的过期死键
 */
export function healProfileConfigFile(
  explicitDshHome?: string,
  explicitProfile?: string,
  logger?: any
): HealResult {
  const dshHome = resolveDshHome(explicitDshHome);
  const candidateProfiles = explicitProfile ? [explicitProfile] : ['desktop', 'default'];
  const validKeys = getValidConfigKeys();
  const targetIds = new Set([SETTINGS_NAMESPACE, PLUGIN_NAME]);

  for (const profile of candidateProfiles) {
    const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
    if (!fs.existsSync(patchFile)) {
      continue;
    }

    try {
      const content = fs.readFileSync(patchFile, 'utf8');
      if (!content.includes(SETTINGS_NAMESPACE) && !content.includes(PLUGIN_NAME)) {
        continue;
      }

      const cleaned = scanAndCleanPluginConfig(
        content,
        targetIds,
        (key) => !validKeys.has(key)
      );
      if (cleaned.removedKeys.length > 0) {
        atomicWriteFileSync(patchFile, cleaned.newContent, 'utf8');
        logger?.info?.(
          `[Config] 配置文件自愈成功 (${patchFile})，已物理清除失效配置项: ${cleaned.removedKeys.join(', ')}`
        );
        return {
          healed: true,
          removedKeys: cleaned.removedKeys,
          filePath: patchFile,
        };
      }
    } catch (err: any) {
      logger?.warn?.(`[Config] 物理配置文件自愈扫描异常 (非致命): ${err?.message || err}`);
    }
  }

  return { healed: false, removedKeys: [] };
}
