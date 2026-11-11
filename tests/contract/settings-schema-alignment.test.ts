import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import { DEFAULT_BASE_CONFIG as CONSTANTS_DEFAULTS } from '../../src/constants/index.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_BASE_CONFIG as SERVER_DEFAULTS } from '../../src/server/routes.js';
import { DEFAULT_BASE_CONFIG as CLIENT_DEFAULTS } from '../../src/client/card.js';

describe('契约测试：设置系统与三方 17 键单一真相源一致性 (Settings Alignment Contract)', () => {
  it('Schema、Constants、服务端默认值、客户端默认值四方键严格一致（精确 17 项核心单聊配置）', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    const schemaKeys = Object.keys(schemaShape).sort();
    const constantsKeys = Object.keys(CONSTANTS_DEFAULTS).sort();
    const serverKeys = Object.keys(SERVER_DEFAULTS).sort();
    const clientKeys = Object.keys(CLIENT_DEFAULTS).sort();

    // 1. 精确 17 键
    expect(schemaKeys).toHaveLength(17);
    expect(constantsKeys).toHaveLength(17);
    expect(serverKeys).toHaveLength(17);
    expect(clientKeys).toHaveLength(17);

    // 2. 四方键集合完全恒等，且服务端与客户端直接复用 Constants SSOT
    expect(schemaKeys).toEqual(constantsKeys);
    expect(serverKeys).toEqual(constantsKeys);
    expect(clientKeys).toEqual(constantsKeys);
    expect(SERVER_DEFAULTS).toBe(CONSTANTS_DEFAULTS);
    expect(CLIENT_DEFAULTS).toBe(CONSTANTS_DEFAULTS);

    // 3. 已下线字段与凭据字段（ws_*, admins, 群聊, 主动回复, 安全矩阵, app_id/app_secret）绝不存在
    const deadKeys = [
      'app_id',
      'app_secret',
      'ws_port',
      'ws_token',
      'bot_qq',
      'admins',
      'aliases',
      'proactive_reply_enabled',
      'proactive_interval_mins',
      'proactive_buffer_size',
      'proactive_only_text',
      'proactive_random_enabled',
      'proactive_random_probability',
      'proactive_idle_enabled',
      'proactive_idle_timeout_mins',
      'proactive_cooldown_mins',
      'proactive_night_dnd',
      'group_memory_total_budget_chars',
      'face_sub_type',
      'private_blacklist',
      'group_blacklist',
      'session_permission_private_default',
      'session_permission_group_default',
      'session_permission_overrides',
      'coding_tools_private_default',
      'coding_tools_group_default',
      'coding_tools_overrides',
      'memory_budget_chars',
      'group_memory_budget_chars',
      'private_memory_budget_chars',
      'review_enabled',
      'slang_budget_chars',
    ];
    for (const deadKey of deadKeys) {
      expect(schemaKeys).not.toContain(deadKey);
      expect(serverKeys).not.toContain(deadKey);
      expect(clientKeys).not.toContain(deadKey);
    }
  });

  it('全部 17 项运行时配置字段均标记为 .volatile()，以支持 DSH 设置面板保存与热更新', () => {
    const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
    const schemaKeys = Object.keys(schemaShape);

    expect(schemaKeys).toHaveLength(17);
    for (const field of schemaKeys) {
      expect(
        schemaShape[field]?.meta?.volatile,
        `field ${field} should be marked .volatile()`
      ).toBe(true);
    }

    const parsed = BridgeConfigSchema({});
    const unwrap = (val: any) => (typeof val?.get === 'function' ? val.get() : val);
    expect(unwrap(parsed.memory_storage_dir)).toBe('.dsh/kujira/memory');
    expect(unwrap(parsed.face_store_dir)).toBe('.dsh/kujira/faces');
    expect(unwrap(parsed.slang_storage_path)).toBe('.dsh/kujira/slang/slang.md');
    expect(unwrap(parsed.markdown_enabled)).toBe(true);
    expect(unwrap(parsed.input_notify_enabled)).toBe(true);
    expect(unwrap(parsed.new_message_behavior)).toBe('steer');
  });

  it('locale 多语言资源与 package.json 规范导出对齐 kujira', () => {
    const enPath = path.resolve(process.cwd(), 'locale/en.json');
    const zhPath = path.resolve(process.cwd(), 'locale/zh.json');
    expect(fs.existsSync(enPath)).toBe(true);
    expect(fs.existsSync(zhPath)).toBe(true);

    const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
    const zh = JSON.parse(fs.readFileSync(zhPath, 'utf8'));

    expect(en.title).toContain('Kujira');
    expect(en.description).toBeTruthy();
    expect(zh.title).toContain('Kujira');
    expect(zh.description).toBeTruthy();

    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.name).toBe('kujira');
    expect(pkg.exports?.['./locale/*']).toBe('./locale/*');
    expect(pkg.exports?.['./client']).toBe('./dist/client.js');
    expect(pkg.exports?.['./tools']?.default).toBe('./dist/tools/plugin.js');
    expect(pkg.files?.includes('locale')).toBe(true);
  });
});
