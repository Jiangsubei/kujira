import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getValidConfigKeys,
  sanitizeConfigPayload,
  surgicalCleanYamlConfig,
  healProfileConfigFile,
} from '../../src/config/heal.js';
import { BridgeConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_BASE_CONFIG, PLUGIN_NAME, SETTINGS_NAMESPACE } from '../../src/constants/index.js';

const EXPECTED_15_KEYS = [
  'image_ttl_days',
  'new_message_behavior',
  'persona',
  'behavior',
  'memory_storage_dir',
  'user_profile_budget_chars',
  'session_memory_budget_chars',
  'face_enabled',
  'face_store_max',
  'face_store_dir',
  'face_evict_policy',
  'slang_enabled',
  'slang_max_entries',
  'slang_evict_policy',
  'slang_storage_path',
] as const;

describe('契约测试: Kujira 15 项配置 Schema 与物理自愈引擎 (Config Self-Healing Contract)', () => {
  let testTmpDir: string;

  beforeEach(() => {
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kujira-config-heal-'));
  });

  afterEach(() => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  describe('1. 单一真相源与 15 项 Schema 契约', () => {
    it('插件标识统一为 kujira，且 getValidConfigKeys 返回严格收敛的 15 项合法键', () => {
      expect(PLUGIN_NAME).toBe('kujira');
      expect(SETTINGS_NAMESPACE).toBe('kujira');

      const validKeys = getValidConfigKeys();
      expect(validKeys.size).toBe(15);
      expect(Array.from(validKeys).sort()).toEqual([...EXPECTED_15_KEYS].sort());
      expect(Object.keys(DEFAULT_BASE_CONFIG).sort()).toEqual([...EXPECTED_15_KEYS].sort());

      const schemaShape = (BridgeConfigSchema as any).dict || (BridgeConfigSchema as any).shape || {};
      for (const field of EXPECTED_15_KEYS) {
        expect(schemaShape[field]?.meta?.volatile, `field ${field} must be .volatile()`).toBe(true);
      }

      const resolvedDefaults = (BridgeConfigSchema as any)({});
      for (const field of EXPECTED_15_KEYS) {
        const rawDefault = schemaShape[field]?.meta?.default;
        const volatileVal =
          typeof resolvedDefaults[field]?.get === 'function'
            ? resolvedDefaults[field].get()
            : resolvedDefaults[field];
        const expected = (DEFAULT_BASE_CONFIG as Record<string, unknown>)[field];
        expect(rawDefault).toEqual(expected);
        expect(volatileVal).toEqual(expected);
      }
    });

    it('已废弃的 NapCat / 群聊 / 主动插话 / 安全权限 / 凭据 / 历史迁移键严禁存在于 Schema 中', () => {
      const validKeys = getValidConfigKeys();
      const deadKeys = [
        // 已固化为默认开启而废除的配置开关
        'markdown_enabled',
        'input_notify_enabled',
        // 旧 NapCat & 凭据键
        'ws_port',
        'ws_token',
        'bot_qq',
        'app_id',
        'app_secret',
        'admins',
        'aliases',
        // 旧群聊 & 主动回复 & 免打扰键
        'proactive_reply_enabled',
        'proactive_only_text',
        'proactive_interval_mins',
        'proactive_buffer_size',
        'proactive_random_enabled',
        'proactive_random_probability',
        'proactive_idle_enabled',
        'proactive_idle_timeout_mins',
        'proactive_cooldown_mins',
        'proactive_night_dnd',
        'group_memory_total_budget_chars',
        'group_blacklist',
        'session_permission_group_default',
        'coding_tools_group_default',
        // 旧安全覆盖 & 早期废弃键
        'private_blacklist',
        'session_permission_private_default',
        'session_permission_overrides',
        'coding_tools_private_default',
        'coding_tools_overrides',
        'face_sub_type',
        'at_questioner',
        'quote_original',
        'review_enabled',
        'face_auto_curate',
        'memory_budget_chars',
        'group_memory_budget_chars',
        'private_memory_budget_chars',
        'slang_budget_chars',
      ];

      for (const deadKey of deadKeys) {
        expect(validKeys.has(deadKey), `${deadKey} should be removed`).toBe(false);
      }
    });
  });

  describe('2. 纯函数自愈清洗契约 (sanitizeConfigPayload)', () => {
    it('分离 15 项合法字段与 markdown_enabled / input_notify_enabled / 旧 NapCat / 群聊 / 凭据死键，且不再执行 0.1.5 历史键搬运', () => {
      const dirtyInput = {
        image_ttl_days: 14,
        new_message_behavior: 'queue',
        persona: '测试单聊人格',
        // 以下均为已废除键，必须全部剔除（含 markdown_enabled 与 input_notify_enabled）
        markdown_enabled: false,
        input_notify_enabled: true,
        ws_port: 3001,
        ws_token: 'legacy-ws-token',
        bot_qq: '1000000021',
        app_id: '1000000001',
        app_secret: 'mock-secret-never-persist-in-config',
        admins: ['1000000002'],
        proactive_reply_enabled: true,
        proactive_night_dnd: true,
        group_memory_total_budget_chars: 8000,
        private_memory_budget_chars: 1900,
        memory_budget_chars: 3300,
        session_permission_overrides: [],
        some_unknown_key: 'stale',
      };

      const result = sanitizeConfigPayload(dirtyInput);
      expect(result.valid).toEqual({
        image_ttl_days: 14,
        new_message_behavior: 'queue',
        persona: '测试单聊人格',
      });
      expect(result.removed.sort()).toEqual(
        [
          'markdown_enabled',
          'input_notify_enabled',
          'ws_port',
          'ws_token',
          'bot_qq',
          'app_id',
          'app_secret',
          'admins',
          'proactive_reply_enabled',
          'proactive_night_dnd',
          'group_memory_total_budget_chars',
          'private_memory_budget_chars',
          'memory_budget_chars',
          'session_permission_overrides',
          'some_unknown_key',
        ].sort()
      );
    });

    it('输入仅含合法键时 removed 为空；异常非对象输入安全返回空结果', () => {
      const cleanInput = {
        image_ttl_days: 14,
        new_message_behavior: 'steer' as const,
        face_enabled: true,
        slang_evict_policy: 'evict_lru' as const,
      };
      const cleanRes = sanitizeConfigPayload(cleanInput);
      expect(cleanRes.valid).toEqual(cleanInput);
      expect(cleanRes.removed).toEqual([]);

      expect(sanitizeConfigPayload(null as any)).toEqual({ valid: {}, removed: [] });
      expect(sanitizeConfigPayload(['bad'] as any)).toEqual({ valid: {}, removed: [] });
    });

    it('清洗结果直接提交 DSH settings.mutate volatile 白名单校验绝不抛出 is not volatile', () => {
      const schema = BridgeConfigSchema as any;
      const validKeys = new Set(Object.keys(schema.dict || {}));
      const { valid } = sanitizeConfigPayload({
        image_ttl_days: 7,
        new_message_behavior: 'steer',
        face_enabled: true,
        markdown_enabled: true,
        input_notify_enabled: false,
        ws_port: 8080,
        proactive_reply_enabled: true,
        app_secret: 'mock-secret',
      });

      expect(valid).toEqual({
        image_ttl_days: 7,
        new_message_behavior: 'steer',
        face_enabled: true,
      });

      const ops = Object.entries(valid).map(([key, value]) => ({ op: 'set' as const, path: [key], value }));
      expect(() => {
        for (const op of ops) {
          const key = op.path[0];
          if (!validKeys.has(key) || !schema.dict[key]?.meta?.volatile) {
            throw new Error(`Config field "${key}" is not volatile`);
          }
        }
      }).not.toThrow();
    });
  });

  describe('3. 物理配置文件自愈契约 (healProfileConfigFile & surgicalCleanYamlConfig)', () => {
    it('精确清理 kujira 块中的已废除开关及旧 NapCat / 群聊 / 安全覆盖多行脏键，绝不误伤兄弟条目 preset-kujira-session 与 kujira-tools', () => {
      const profileDir = path.join(testTmpDir, 'profiles/desktop');
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');

      const mockYaml = [
        '- id: ui-theme',
        '  name: "@deepseek-ai/dsh-client-ui-theme"',
        '  config:',
        '    preference: system',
        '- id: kujira',
        '  name: kujira',
        '  config:',
        '    image_ttl_days: 7',
        '    markdown_enabled: true',
        '    input_notify_enabled: false',
        '    ws_port: 3001',
        '    ws_token: "legacy-token"',
        '    bot_qq: "1000000000"',
        '    app_id: "1000000001"',
        '    app_secret: "mock-secret-remove"',
        '    admins:',
        '      - "1000000002"',
        '    proactive_reply_enabled: true',
        '    proactive_night_dnd: true',
        '    group_memory_total_budget_chars: 8000',
        '    session_permission_overrides:',
        '      - id: "8000000001"',
        '        type: group',
        '        permission: read-only',
        '    persona: "保留的合法单聊人格"',
        '- id: preset-kujira-session',
        '  name: "@deepseek-ai/dsh-agent-preset"',
        '  config:',
        '    id: kujira-session',
        '    order: 10',
        '    plugins:',
        '      - id: kujira-tools',
        '        name: "kujira/tools"',
        '',
      ].join('\n');
      fs.writeFileSync(patchPath, mockYaml, 'utf8');

      const healResult = healProfileConfigFile(testTmpDir, 'desktop');
      expect(healResult.healed).toBe(true);
      expect(healResult.filePath).toBe(patchPath);
      expect(healResult.removedKeys.sort()).toEqual(
        [
          'markdown_enabled',
          'input_notify_enabled',
          'ws_port',
          'ws_token',
          'bot_qq',
          'app_id',
          'app_secret',
          'admins',
          'proactive_reply_enabled',
          'proactive_night_dnd',
          'group_memory_total_budget_chars',
          'session_permission_overrides',
        ].sort()
      );

      const updated = fs.readFileSync(patchPath, 'utf8');
      expect(updated).toContain('image_ttl_days: 7');
      expect(updated).toContain('persona: "保留的合法单聊人格"');

      // 所有死键（含 markdown_enabled / input_notify_enabled）及其多行子块已物理删除
      expect(updated).not.toContain('markdown_enabled');
      expect(updated).not.toContain('input_notify_enabled');
      expect(updated).not.toContain('ws_port');
      expect(updated).not.toContain('ws_token');
      expect(updated).not.toContain('bot_qq');
      expect(updated).not.toContain('app_secret');
      expect(updated).not.toContain('1000000002');
      expect(updated).not.toContain('8000000001');
      expect(updated).not.toContain('proactive_reply_enabled');
      expect(updated).not.toContain('group_memory_total_budget_chars');

      // 名字包含 kujira 子串的兄弟插件条目必须完好无损
      expect(updated).toContain('- id: ui-theme');
      expect(updated).toContain('- id: preset-kujira-session');
      expect(updated).toContain('id: kujira-session');
      expect(updated).toContain('- id: kujira-tools');
    });

    it('当 cordis.patch.yml 仅含合法配置键时，保持文件内容不变且 healed 为 false', () => {
      const profileDir = path.join(testTmpDir, 'profiles/desktop');
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');

      const cleanYaml = [
        '- id: kujira',
        '  name: kujira',
        '  config:',
        '    image_ttl_days: 7',
        '    new_message_behavior: steer',
        '    face_evict_policy: evict_lru',
        '    slang_enabled: true',
        '',
      ].join('\n');
      fs.writeFileSync(patchPath, cleanYaml, 'utf8');

      const healResult = healProfileConfigFile(testTmpDir, 'desktop');
      expect(healResult.healed).toBe(false);
      expect(healResult.removedKeys).toEqual([]);
      expect(fs.readFileSync(patchPath, 'utf8')).toBe(cleanYaml);
    });

    it('仅包含旧 dsh-napcat-bridge 条目或无 config 块时不会误操作', () => {
      const profileDir = path.join(testTmpDir, 'profiles/default');
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');

      const legacyOnlyYaml = [
        '- id: dsh-napcat-bridge',
        '  name: dsh-napcat-bridge',
        '  config:',
        '    ws_port: 8080',
        '',
      ].join('\n');
      fs.writeFileSync(patchPath, legacyOnlyYaml, 'utf8');

      const healResult = healProfileConfigFile(testTmpDir, 'default');
      expect(healResult.healed).toBe(false);
      expect(healResult.removedKeys).toEqual([]);
      expect(fs.readFileSync(patchPath, 'utf8')).toBe(legacyOnlyYaml);
    });

    it('surgicalCleanYamlConfig 在精确删除指定过期键时保留注释与 CRLF 换行风格', () => {
      const input = [
        '- id: kujira',
        '  config:',
        '    # 保留注释',
        '    image_ttl_days: 7',
        '    markdown_enabled: true',
        '    ws_port: 8080',
        '    persona: "助手"',
        '',
      ].join('\r\n');

      const cleaned = surgicalCleanYamlConfig(input, 'kujira', new Set(['ws_port', 'markdown_enabled']));
      expect(cleaned.removedKeys.sort()).toEqual(['markdown_enabled', 'ws_port']);
      expect(cleaned.newContent).toBe(
        ['- id: kujira', '  config:', '    # 保留注释', '    image_ttl_days: 7', '    persona: "助手"', ''].join(
          '\r\n'
        )
      );
    });
  });
});
