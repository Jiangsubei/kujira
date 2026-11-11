import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import {
  KujiraSettingsCard,
  SETTINGS_TABS,
  DEFAULT_BASE_CONFIG,
  type CardProps,
  type CardController,
} from '../../src/client/card.js';
import type { CredentialStatusSummary } from '../../src/types/index.js';

describe('契约测试: Web UI 设置卡 5 分区 Tab、只写凭据表单与跨 Tab 保存 (Settings Tabs Contract)', () => {
  let controller: CardController;
  let mockSaveSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSaveSettings = vi.fn().mockResolvedValue({ revision: 2 });
  });

  function renderCard(props: Partial<CardProps> = {}) {
    let captured: CardController | null = null;
    const html = renderToStaticMarkup(
      React.createElement(KujiraSettingsCard, {
        initialExpanded: true,
        controllerRef: (ctrl) => {
          captured = ctrl;
        },
        onSaveSettings: mockSaveSettings,
        ...props,
      })
    );
    if (captured) {
      controller = captured;
    }
    return html;
  }

  describe('1. 5 分区 Tab 渲染与已下线 Tab 排他契约', () => {
    it('卡片展开后必须渲染且仅渲染 5 个官方 Tab，彻底移除主动回复与权限安全 Tab', () => {
      const html = renderCard();

      expect(html).toContain('role="tablist"');
      expect(html).toContain('aria-label="设置分区"');

      expect(html).toContain('id="kujira-tab-connection"');
      expect(html).toContain('连接与对话');

      expect(html).toContain('id="kujira-tab-persona"');
      expect(html).toContain('人格与准则');

      expect(html).toContain('id="kujira-tab-memory"');
      expect(html).toContain('记忆');

      expect(html).toContain('id="kujira-tab-face"');
      expect(html).toContain('表情包');

      expect(html).toContain('id="kujira-tab-slang"');
      expect(html).toContain('黑话学习');

      expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
        'connection',
        'persona',
        'memory',
        'face',
        'slang',
      ]);
      expect(SETTINGS_TABS).toHaveLength(5);

      expect(html).not.toContain('proactive');
      expect(html).not.toContain('security');
      expect(html).not.toContain('kujira-tab-tools');
      expect(html).not.toContain('napcat');
    });

    it('默认未展开 (initialExpanded=false) 时不渲染 Tab 栏与表单字段', () => {
      const html = renderCard({ initialExpanded: false });
      expect(html).toContain('QQ Kujira 机器人 (kujira)');
      expect(html).not.toContain('role="tablist"');
      expect(html).not.toContain('kujira-tab-connection');
    });
  });

  describe('2. 默认展示 Tab 1 (连接与对话) 及只写凭据表单契约', () => {
    it('默认 activeTab 为 connection，对应 panel 可见且其他 4 个 panel 隐藏', () => {
      const html = renderCard();

      expect(html).toMatch(/id="kujira-tab-connection"[^>]*aria-selected="true"/);
      expect(html).toMatch(/id="kujira-tab-connection"[^>]*kujira_tabActive/);

      expect(html).toMatch(/id="kujira-tab-persona"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-memory"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-face"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-slang"[^>]*aria-selected="false"/);

      expect(html).toMatch(/id="kujira-tabpanel-connection"[^>]*role="tabpanel"/);
      expect(html).not.toMatch(/id="kujira-tabpanel-connection"[^>]*hidden/);

      expect(html).toMatch(/id="kujira-tabpanel-persona"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-memory"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-face"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-slang"[^>]*hidden/);
    });

    it('Tab 1 包含 2 个只写凭据框（不回显明文）与 2 个对话/媒体配置项，不再暴露已固化的 markdown_enabled / input_notify_enabled 开关', () => {
      const credStatus: CredentialStatusSummary = {
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: false, writable: true },
        ready: false,
      };
      const html = renderCard({ credentialsStatus: credStatus });

      const connectionPanelMatch = html.match(
        /id="kujira-tabpanel-connection"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-persona")/
      );
      expect(connectionPanelMatch).not.toBeNull();
      const connectionHtml = connectionPanelMatch![0];

      // 1. AppID 只写输入框 + 已配置来源徽章
      expect(connectionHtml).toContain('id="kujira-cred-app-id"');
      expect(connectionHtml).toContain('Bot AppID (QQ_BOT_APP_ID)');
      expect(connectionHtml).toContain('已配置 (来源: file)');
      expect(connectionHtml).toMatch(/id="kujira-cred-app-id"[^>]*value=""/);

      // 2. AppSecret 只写 password 输入框 + 未配置徽章
      expect(connectionHtml).toContain('id="kujira-cred-app-secret"');
      expect(connectionHtml).toContain('Bot AppSecret (QQ_BOT_SECRET)');
      expect(connectionHtml).toMatch(/id="kujira-cred-app-secret"[^>]*type="password"/);
      expect(connectionHtml).toMatch(/id="kujira-cred-app-secret"[^>]*value=""/);
      expect(connectionHtml).toContain('未配置');

      // 3. new_message_behavior
      expect(connectionHtml).toContain('id="kujira-new-message-behavior"');
      expect(connectionHtml).toContain('value="steer"');
      expect(connectionHtml).toContain('value="queue"');

      // 4. image_ttl_days
      expect(connectionHtml).toContain('id="kujira-image-ttl"');
      expect(connectionHtml).toContain('image_ttl_days');

      // 5. 已固化为默认开启而移除的开关与历史字段不存在
      expect(connectionHtml).not.toContain('kujira-markdown-enabled');
      expect(connectionHtml).not.toContain('markdown_enabled');
      expect(connectionHtml).not.toContain('kujira-input-notify-enabled');
      expect(connectionHtml).not.toContain('input_notify_enabled');
      expect(connectionHtml).not.toContain('ws_port');
      expect(connectionHtml).not.toContain('ws_token');
      expect(connectionHtml).not.toContain('bot_qq');
      expect(connectionHtml).not.toContain('admins');
      expect(connectionHtml).not.toContain('aliases');
    });
  });

  describe('3. 各 Tab 控件完整性契约', () => {
    it('切换到 Tab 2 (人格与准则) 时展示对应 2 个 TextArea 字段', () => {
      const html = renderCard({ initialTab: 'persona' });

      expect(html).toMatch(/id="kujira-tab-persona"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="kujira-tabpanel-persona"[^>]*hidden/);

      const panelMatch = html.match(
        /id="kujira-tabpanel-persona"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-memory")/
      );
      const personaHtml = panelMatch![0];
      expect(personaHtml).toContain('id="kujira-persona"');
      expect(personaHtml).toContain('助手人格设定 (persona)');
      expect(personaHtml).toContain('id="kujira-behavior"');
      expect(personaHtml).toContain('行为准则 (behavior)');
    });

    it('切换到 Tab 3 (记忆) 时仅展示 3 个单聊核心记忆配置项，绝不包含群聊预算', () => {
      const html = renderCard({ initialTab: 'memory' });

      expect(html).toMatch(/id="kujira-tab-memory"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="kujira-tabpanel-memory"[^>]*hidden/);

      const panelMatch = html.match(
        /id="kujira-tabpanel-memory"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-face")/
      );
      const memoryHtml = panelMatch![0];

      expect(memoryHtml).toContain('id="kujira-memory-storage-dir"');
      expect(memoryHtml).toContain('.dsh/kujira/memory');
      expect(memoryHtml).toContain('id="kujira-user-profile-budget-chars"');
      expect(memoryHtml).toContain('id="kujira-session-memory-budget-chars"');

      expect(memoryHtml).not.toContain('group_memory_total_budget_chars');
      expect(memoryHtml).not.toContain('群聊');
    });

    it('setActiveTab 正确触发 onTabChange 回调通知', () => {
      const onTabChange = vi.fn();
      renderCard({ onTabChange });

      controller.setActiveTab('memory');
      expect(onTabChange).toHaveBeenCalledWith('memory');

      controller.setActiveTab('persona');
      expect(onTabChange).toHaveBeenCalledWith('persona');
    });
  });

  describe('4. 跨 Tab 修改、只写凭据激活保存与提交清空契约', () => {
    it('仅填写只写凭据草稿时，isDirty 必须为 true，提交后清空凭据输入草稿并刷新凭据状态', async () => {
      const nextStatus: CredentialStatusSummary = {
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: true, source: 'file', writable: true },
        ready: true,
      };
      mockSaveSettings.mockResolvedValueOnce({ revision: 3, credentials: nextStatus });

      renderCard({
        initialConfig: {
          new_message_behavior: 'steer',
          image_ttl_days: 7,
        },
        credentialsStatus: {
          appId: { configured: false, writable: true },
          appSecret: { configured: false, writable: true },
          ready: false,
        },
      });

      expect(controller.isDirty).toBe(false);

      controller.handleAppIdChange('1000000077');
      controller.handleAppSecretChange('secret-draft-77');
      expect(controller.isDirty).toBe(true);
      expect(controller.appIdInput).toBe('1000000077');
      expect(controller.appSecretInput).toBe('secret-draft-77');

      await controller.handleSave();

      expect(mockSaveSettings).toHaveBeenCalledTimes(1);
      const [payload] = mockSaveSettings.mock.calls[0];
      expect(payload.credentials).toEqual({
        app_id: '1000000077',
        app_secret: 'secret-draft-77',
      });

      // 保存成功后立刻清空明文草稿，防止明文留存前端
      expect(controller.appIdInput).toBe('');
      expect(controller.appSecretInput).toBe('');
      expect(controller.isDirty).toBe(false);
      expect(controller.credentialsStatus).toEqual(nextStatus);
    });

    it('在 Tab 1 与 Tab 2/Tab 3 跨 Tab 修改时草稿保留且未保存标识持续生效', () => {
      renderCard({
        initialConfig: {
          new_message_behavior: 'steer',
          image_ttl_days: 7,
          persona: '默认人格',
        },
      });

      expect(controller.isDirty).toBe(false);

      controller.handleFieldChange('new_message_behavior', 'queue');
      expect(controller.isDirty).toBe(true);
      expect(controller.model.getDraft().new_message_behavior).toBe('queue');

      controller.setActiveTab('persona');
      expect(controller.isDirty).toBe(true);
      expect(controller.model.getDraft().new_message_behavior).toBe('queue');

      controller.handleFieldChange('persona', '单聊助手');
      expect(controller.model.getDraft().persona).toBe('单聊助手');

      controller.setActiveTab('memory');
      controller.handleFieldChange('user_profile_budget_chars', 3000);

      controller.setActiveTab('connection');
      const finalDraft = controller.model.getDraft();
      expect(finalDraft.new_message_behavior).toBe('queue');
      expect(finalDraft.persona).toBe('单聊助手');
      expect(finalDraft.user_profile_budget_chars).toBe(3000);
      expect(controller.isDirty).toBe(true);
    });
  });

  describe('5. 全局单次保存 (跨 Tab 一并提交) 契约', () => {
    it('点击「保存更改」时，一次性向 onSaveSettings 提交包含所有 Tab 修改的完整 draft', async () => {
      renderCard({
        revision: 5,
        initialConfig: {
          image_ttl_days: 7,
          new_message_behavior: 'steer',
          persona: '旧人设',
          user_profile_budget_chars: 2200,
        },
      });

      controller.handleFieldChange('image_ttl_days', 14);
      controller.handleFieldChange('new_message_behavior', 'queue');
      controller.handleFieldChange('persona', '新人设');
      controller.handleFieldChange('user_profile_budget_chars', 2300);
      controller.handleFieldChange('session_memory_budget_chars', 2400);

      expect(controller.isDirty).toBe(true);

      await controller.handleSave();

      expect(mockSaveSettings).toHaveBeenCalledTimes(1);
      const [savedDraft, options] = mockSaveSettings.mock.calls[0];
      expect(options).toEqual({ expectedRevision: 5 });
      expect(savedDraft.image_ttl_days).toBe(14);
      expect(savedDraft.new_message_behavior).toBe('queue');
      expect(savedDraft.persona).toBe('新人设');
      expect(savedDraft.user_profile_budget_chars).toBe(2300);
      expect(savedDraft.session_memory_budget_chars).toBe(2400);
      expect(savedDraft.credentials).toBeUndefined();

      expect(controller.isDirty).toBe(false);
      expect(controller.model.getRevision()).toBe(2);
    });

    it('保存被拒绝或冲突时正确设置 errorMessage 且保留修改与凭据草稿', async () => {
      mockSaveSettings.mockRejectedValueOnce(new Error('网络超时或鉴权失败'));

      renderCard({
        initialConfig: { image_ttl_days: 7 },
      });

      controller.handleFieldChange('image_ttl_days', 14);
      controller.handleAppIdChange('1000000088');
      await controller.handleSave();

      expect(controller.errorMessage).toBe('网络超时或鉴权失败');
      expect(controller.isDirty).toBe(true);
      expect(controller.model.getDraft().image_ttl_days).toBe(14);
      expect(controller.appIdInput).toBe('1000000088');
    });
  });

  describe('6. 放弃修改与字段重置契约', () => {
    it('点击「放弃修改」时，跨 Tab 修改与只写凭据草稿全部撤回', () => {
      renderCard({
        initialConfig: {
          new_message_behavior: 'steer',
          image_ttl_days: 7,
          persona: '原始人格',
        },
      });

      controller.handleFieldChange('new_message_behavior', 'queue');
      controller.handleFieldChange('image_ttl_days', 30);
      controller.handleFieldChange('persona', '修改后的人格');
      controller.handleAppIdChange('1000000099');
      controller.handleAppSecretChange('temp-secret');

      expect(controller.isDirty).toBe(true);

      controller.handleDiscard();

      const draft = controller.model.getDraft();
      expect(draft.new_message_behavior).toBe('steer');
      expect(draft.image_ttl_days).toBe(7);
      expect(draft.persona).toBe('原始人格');
      expect(controller.appIdInput).toBe('');
      expect(controller.appSecretInput).toBe('');
      expect(controller.isDirty).toBe(false);
    });

    it('单字段重置 (handleResetField) 正确重置该字段至 baseDefault，不影响其他修改', () => {
      renderCard({
        baseDefaults: DEFAULT_BASE_CONFIG,
        initialConfig: {
          new_message_behavior: DEFAULT_BASE_CONFIG.new_message_behavior,
          image_ttl_days: DEFAULT_BASE_CONFIG.image_ttl_days,
        },
      });

      controller.handleFieldChange('new_message_behavior', 'queue');
      controller.handleFieldChange('image_ttl_days', 30);

      expect(controller.model.isOverridden('new_message_behavior')).toBe(true);
      expect(controller.model.isOverridden('image_ttl_days')).toBe(true);

      controller.handleResetField('new_message_behavior');

      expect(controller.model.getDraft().new_message_behavior).toBe(DEFAULT_BASE_CONFIG.new_message_behavior);
      expect(controller.model.isOverridden('new_message_behavior')).toBe(false);

      expect(controller.model.getDraft().image_ttl_days).toBe(30);
      expect(controller.model.isOverridden('image_ttl_days')).toBe(true);
      expect(controller.isDirty).toBe(true);
    });
  });
});
