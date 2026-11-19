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

describe('契约测试: Web UI 设置卡 6 分区 Tab、只写凭据表单与跨 Tab 保存 (Settings Tabs Contract)', () => {
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

  describe('1. 7 分区 Tab 渲染与已下线 Tab 排他契约', () => {
    it('卡片展开后必须渲染且仅渲染 7 个官方 Tab，包含更多配置 Tab，彻底移除已废弃 Tab', () => {
      const html = renderCard();

      expect(html).toContain('role="tablist"');
      expect(html).toContain('aria-label="设置分区"');

      expect(html).toContain('id="kujira-tab-connection"');
      expect(html).toContain('常规');

      expect(html).toContain('id="kujira-tab-reply"');
      expect(html).toContain('回复节奏');

      expect(html).toContain('id="kujira-tab-persona"');
      expect(html).toContain('人格与准则');

      expect(html).toContain('id="kujira-tab-memory"');
      expect(html).toContain('记忆');

      expect(html).toContain('id="kujira-tab-face"');
      expect(html).toContain('表情包');

      expect(html).toContain('id="kujira-tab-slang"');
      expect(html).toContain('黑话学习');

      expect(html).toContain('id="kujira-tab-more"');
      expect(html).toContain('更多配置');

      expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
        'connection',
        'reply',
        'persona',
        'memory',
        'face',
        'slang',
        'more',
      ]);
      expect(SETTINGS_TABS).toHaveLength(7);

      expect(html).not.toContain('kujira-tab-proactive');
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

  describe('2. 默认展示 Tab 1 (常规) 及只写凭据表单契约', () => {
    it('默认 activeTab 为 connection，对应 panel 可见且其他 5 个 panel 隐藏', () => {
      const html = renderCard();

      expect(html).toMatch(/id="kujira-tab-connection"[^>]*aria-selected="true"/);
      expect(html).toMatch(/id="kujira-tab-connection"[^>]*kujira_tabActive/);

      expect(html).toMatch(/id="kujira-tab-reply"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-persona"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-memory"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-face"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-slang"[^>]*aria-selected="false"/);
      expect(html).toMatch(/id="kujira-tab-more"[^>]*aria-selected="false"/);

      expect(html).toMatch(/id="kujira-tabpanel-connection"[^>]*role="tabpanel"/);
      expect(html).not.toMatch(/id="kujira-tabpanel-connection"[^>]*hidden/);

      expect(html).toMatch(/id="kujira-tabpanel-reply"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-persona"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-memory"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-face"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-slang"[^>]*hidden/);
      expect(html).toMatch(/id="kujira-tabpanel-more"[^>]*hidden/);
    });

    it('Tab 1 包含 2 个只写凭据框（不回显明文）与 1 个媒体保留天数配置项，管理员与隐私隔离已迁至更多配置 Tab', () => {
      const credStatus: CredentialStatusSummary = {
        appId: { configured: true, source: 'file', writable: true },
        appSecret: { configured: false, writable: true },
        ready: false,
      };
      const html = renderCard({ credentialsStatus: credStatus });

      const connectionPanelMatch = html.match(
        /id="kujira-tabpanel-connection"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-reply")/
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

      // 3. image_ttl_days 保留在 Tab 1，但管理员名单与隐私工具隔离已迁至 Tab 7
      expect(connectionHtml).toContain('id="kujira-image-ttl"');
      expect(connectionHtml).toContain('image_ttl_days');
      expect(connectionHtml).not.toContain('admins');
      expect(connectionHtml).not.toContain('kujira-admins');
      expect(connectionHtml).not.toContain('kujira-privacy-tools-enabled');
      expect(connectionHtml).not.toContain('privacy_tools_enabled');

      // 4. 已迁入 Tab 2 的 new_message_behavior 与仿生回复配置项不在 Tab 1
      expect(connectionHtml).not.toContain('kujira-new-message-behavior');
      expect(connectionHtml).not.toContain('new_message_behavior');
      expect(connectionHtml).not.toContain('kujira-aggregation-enabled');
      expect(connectionHtml).not.toContain('aggregation_enabled');
      expect(connectionHtml).not.toContain('kujira-idle-reply-enabled');
      expect(connectionHtml).not.toContain('idle_reply_enabled');

      // 5. 已固化为默认开启而移除的开关与历史字段不存在
      expect(connectionHtml).not.toContain('kujira-markdown-enabled');
      expect(connectionHtml).not.toContain('markdown_enabled');
      expect(connectionHtml).not.toContain('kujira-input-notify-enabled');
      expect(connectionHtml).not.toContain('input_notify_enabled');
      expect(connectionHtml).not.toContain('ws_port');
      expect(connectionHtml).not.toContain('ws_token');
      expect(connectionHtml).not.toContain('bot_qq');
      expect(connectionHtml).not.toContain('aliases');
    });

    it('Tab 2 (回复节奏) 置顶展示 new_message_behavior，并展示聚合/搭话/仿生互动各项及联动禁用', () => {
      const html = renderCard({ initialTab: 'reply' });
      const replyPanelMatch = html.match(
        /id="kujira-tabpanel-reply"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-persona")/
      );
      expect(replyPanelMatch).not.toBeNull();
      const replyHtml = replyPanelMatch![0];

      // 1. 置顶项 new_message_behavior
      expect(replyHtml).toContain('id="kujira-new-message-behavior"');
      expect(replyHtml).toContain('value="steer"');
      expect(replyHtml).toContain('value="queue"');

      // 严格验证 new_message_behavior 位于 aggregation_enabled 之前（严格置顶）
      const newMsgPos = replyHtml.indexOf('id="kujira-new-message-behavior"');
      const aggPos = replyHtml.indexOf('id="kujira-aggregation-enabled"');
      expect(newMsgPos).toBeLessThan(aggPos);

      // 2. 仿生主动能力控件齐全
      expect(replyHtml).toContain('id="kujira-aggregation-enabled"');
      expect(replyHtml).toContain('id="kujira-aggregation-min-seconds"');
      expect(replyHtml).toContain('id="kujira-aggregation-max-seconds"');
      expect(replyHtml).toContain('id="kujira-instant-reply-enabled"');
      expect(replyHtml).toContain('id="kujira-idle-reply-enabled"');
      expect(replyHtml).toContain('id="kujira-idle-reply-min-mins"');
      expect(replyHtml).toContain('id="kujira-idle-reply-max-mins"');
      expect(replyHtml).toContain('id="kujira-proactive-attitude"');

      // 3. 默认全关时，区间与秒回项均被联动禁用
      expect(replyHtml).toMatch(/id="kujira-aggregation-min-seconds"[^>]*disabled/);
      expect(replyHtml).toMatch(/id="kujira-aggregation-max-seconds"[^>]*disabled/);
      expect(replyHtml).toMatch(/id="kujira-instant-reply-enabled"[^>]*disabled/);
      expect(replyHtml).toMatch(/id="kujira-idle-reply-min-mins"[^>]*disabled/);
      expect(replyHtml).toMatch(/id="kujira-idle-reply-max-mins"[^>]*disabled/);

      // 4. 默认值渲染（聚合 10s~60s / 搭话 30m~120m / 偏好 balanced）
      expect(replyHtml).toMatch(/id="kujira-aggregation-min-seconds"[^>]*value="10"/);
      expect(replyHtml).toMatch(/id="kujira-aggregation-max-seconds"[^>]*value="60"/);
      expect(replyHtml).toMatch(/id="kujira-idle-reply-min-mins"[^>]*value="30"/);
      expect(replyHtml).toMatch(/id="kujira-idle-reply-max-mins"[^>]*value="120"/);
      expect(replyHtml).toContain('id="kujira-proactive-attitude-option-balanced"');
      expect(replyHtml).toMatch(/id="kujira-proactive-attitude-option-balanced"[^>]*aria-checked="true"/);

      // 5. 开启后对应数值项解禁
      const enabledHtml = renderCard({
        initialTab: 'reply',
        initialConfig: { aggregation_enabled: true, idle_reply_enabled: true },
      });
      const enabledPanel = enabledHtml.match(
        /id="kujira-tabpanel-reply"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-persona")/
      )![0];
      expect(enabledPanel).not.toMatch(/id="kujira-aggregation-min-seconds"[^>]*disabled/);
      expect(enabledPanel).not.toMatch(/id="kujira-aggregation-max-seconds"[^>]*disabled/);
      expect(enabledPanel).not.toMatch(/id="kujira-instant-reply-enabled"[^>]*disabled/);
      expect(enabledPanel).not.toMatch(/id="kujira-idle-reply-min-mins"[^>]*disabled/);
      expect(enabledPanel).not.toMatch(/id="kujira-idle-reply-max-mins"[^>]*disabled/);

      // 6. 绝不复用已废弃的旧键名
      expect(replyHtml).not.toContain('aggregation_interval_mins');
      expect(replyHtml).not.toContain('idle_reply_timeout_mins');
      expect(replyHtml).not.toContain('proactive_reply_enabled');
      expect(replyHtml).not.toContain('proactive_idle_timeout_mins');
      expect(replyHtml).not.toContain('proactive_buffer_size');
    });
  });

  describe('3. 各 Tab 控件完整性契约', () => {
    it('切换到 Tab 3 (人格与准则) 时展示对应 2 个 TextArea 字段', () => {
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

    it('切换到 Tab 4 (记忆) 时仅展示 3 个单聊核心记忆配置项，绝不包含群聊预算', () => {
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

    it('切换到 Tab 7 (更多配置) 时平铺展示管理员名单、隐私工具隔离与冷场主动搭话名单开关', () => {
      const html = renderCard({ initialTab: 'more' });

      expect(html).toMatch(/id="kujira-tab-more"[^>]*aria-selected="true"/);
      expect(html).not.toMatch(/id="kujira-tabpanel-more"[^>]*hidden/);

      const panelMatch = html.match(
        /id="kujira-tabpanel-more"[\s\S]*?(?=<div class="[^"]*footer)/
      );
      expect(panelMatch).not.toBeNull();
      const moreHtml = panelMatch![0];

      // 1. 管理员名单
      expect(moreHtml).toContain('管理员名单 (admins)');
      expect(moreHtml).toContain('id="kujira-admins-add"');

      // 2. 隔离可能泄露隐私的工具总开关
      expect(moreHtml).toContain('隔离可能泄露隐私的工具 (privacy_tools_enabled)');
      expect(moreHtml).toContain('id="kujira-privacy-tools-enabled"');

      // 3. 冷场主动搭话名单总开关
      expect(moreHtml).toContain('冷场主动搭话名单');
      expect(moreHtml).toContain('id="kujira-idle-reply-filter-enabled"');

      // 4. 勾选冷场搭话名单或有数据时展示模式与添加按钮
      const enabledCardHtml = renderCard({
        initialTab: 'more',
        initialConfig: { idle_reply_list_mode: 'whitelist' },
      });
      expect(enabledCardHtml).toContain('搭话名单模式 (idle_reply_list_mode)');
      expect(enabledCardHtml).toContain('id="kujira-idle-reply-list-mode"');
      expect(enabledCardHtml).toContain('id="kujira-idle-reply-peer-add"');
    });

    it('setActiveTab 正确触发 onTabChange 回调通知', () => {
      const onTabChange = vi.fn();
      renderCard({ onTabChange });

      controller.setActiveTab('reply');
      expect(onTabChange).toHaveBeenCalledWith('reply');

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

    it('在 Tab 1 与 Tab 2/Tab 3/Tab 4 跨 Tab 修改时草稿保留且未保存标识持续生效', () => {
      renderCard({
        initialConfig: {
          new_message_behavior: 'steer',
          image_ttl_days: 7,
          persona: '默认人格',
        },
      });

      expect(controller.isDirty).toBe(false);

      controller.handleFieldChange('image_ttl_days', 14);
      expect(controller.isDirty).toBe(true);

      controller.setActiveTab('reply');
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
      expect(finalDraft.image_ttl_days).toBe(14);
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

  describe('7. 人格与行为准则清空重置与保存回填契约 (方案三)', () => {
    it('清空 persona / behavior 输入框（变成空白字符）时，isOverridden 即刻转为 false 且不显示已自定义徽章', () => {
      renderCard({
        baseDefaults: DEFAULT_BASE_CONFIG,
        initialConfig: {
          persona: '自定义旧人设',
          behavior: '自定义旧准则',
        },
        initialTab: 'persona',
      });

      // 初始自定义状态
      expect(controller.model.isOverridden('persona')).toBe(true);
      expect(controller.model.isOverridden('behavior')).toBe(true);

      // 清空 persona（纯空白）
      controller.handleFieldChange('persona', '   ');
      // 方案三核心断言：清空时立刻视为未自定义
      expect(controller.model.isOverridden('persona')).toBe(false);
      // 输入框内容保持用户编辑的空白（方便切窗口复制粘贴，不强行塞入文字打扰用户）
      expect(controller.model.getDraft().persona).toBe('   ');

      // 清空 behavior
      controller.handleFieldChange('behavior', '');
      expect(controller.model.isOverridden('behavior')).toBe(false);
      expect(controller.model.getDraft().behavior).toBe('');
    });

    it('清空 persona / behavior 后点击保存更改，提交载荷与 draft 自动回填为默认提示词，状态维持未自定义', async () => {
      renderCard({
        baseDefaults: DEFAULT_BASE_CONFIG,
        initialConfig: {
          persona: '自定义旧人设',
          behavior: '自定义旧准则',
        },
        initialTab: 'persona',
      });

      // 用户把人设和行为准则清理掉
      controller.handleFieldChange('persona', '');
      controller.handleFieldChange('behavior', '  ');
      expect(controller.isDirty).toBe(true);

      // 点击保存
      await controller.handleSave();

      // 1. 提交给后端/onSaveSettings 的必须是 DEFAULT_BASE_CONFIG，绝非空字符串
      expect(mockSaveSettings).toHaveBeenCalledTimes(1);
      const [savedPayload] = mockSaveSettings.mock.calls[0];
      expect(savedPayload.persona).toBe(DEFAULT_BASE_CONFIG.persona);
      expect(savedPayload.behavior).toBe(DEFAULT_BASE_CONFIG.behavior);

      // 2. 保存后，前端 draft 必须自动回填为默认提示词，不再是空的
      expect(controller.model.getDraft().persona).toBe(DEFAULT_BASE_CONFIG.persona);
      expect(controller.model.getDraft().behavior).toBe(DEFAULT_BASE_CONFIG.behavior);

      // 3. 状态恢复为未自定义
      expect(controller.model.isOverridden('persona')).toBe(false);
      expect(controller.model.isOverridden('behavior')).toBe(false);
      expect(controller.isDirty).toBe(false);
    });

    it('打开设置时若外部配置存在历史残留空字符串 persona / behavior，前端自动自愈回退为默认提示词且显示为未自定义', () => {
      renderCard({
        baseDefaults: DEFAULT_BASE_CONFIG,
        initialConfig: {
          persona: '',
          behavior: '   ',
        },
        initialTab: 'persona',
      });

      expect(controller.model.getDraft().persona).toBe(DEFAULT_BASE_CONFIG.persona);
      expect(controller.model.getDraft().behavior).toBe(DEFAULT_BASE_CONFIG.behavior);
      expect(controller.model.isOverridden('persona')).toBe(false);
      expect(controller.model.isOverridden('behavior')).toBe(false);
    });
  });
});
