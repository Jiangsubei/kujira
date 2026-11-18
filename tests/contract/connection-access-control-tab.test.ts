import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import { openidToPeer } from '../../src/utils/peer.js';
import { KujiraFormModel } from '../../src/client/model.js';
import { KujiraSettingsCard, DEFAULT_BASE_CONFIG } from '../../src/client/card.js';
import {
  ConnectionTab,
  hasCustomPrivacyToolsFilterConfig,
  type ConnectionTabProps,
} from '../../src/client/tabs/ConnectionTab.js';
import {
  PEERS_ENDPOINT,
  PEERS_POLL_MS,
  formatPeerDropdownLabel,
  formatRelativeSpeakTime,
  startPeerListPolling,
  type KnownPeerSummary,
} from '../../src/client/components/PeerListEditor.js';
import type { CredentialStatusSummary } from '../../src/types/index.js';

const OPENID_A = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
const OPENID_B = 'B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7';
const OPENID_C = 'C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8';

const PEER_A = openidToPeer(OPENID_A);
const PEER_B = openidToPeer(OPENID_B);
const PEER_C = openidToPeer(OPENID_C);

const DEFAULT_CRED_STATUS: CredentialStatusSummary = {
  appId: { configured: true, source: 'file', writable: true },
  appSecret: { configured: true, source: 'file', writable: true },
  ready: true,
};

function renderConnectionTab(overrides: Partial<ConnectionTabProps> = {}): string {
  const model =
    overrides.model ??
    new KujiraFormModel({
      initialValues: overrides.draft ?? {},
      baseDefaults: DEFAULT_BASE_CONFIG,
    });

  return renderToStaticMarkup(
    React.createElement(ConnectionTab, {
      active: true,
      draft: model.getDraft(),
      model,
      saving: false,
      credentialsStatus: DEFAULT_CRED_STATUS,
      appIdInput: '',
      appSecretInput: '',
      onAppIdChange: vi.fn(),
      onAppSecretChange: vi.fn(),
      onFieldChange: vi.fn(),
      onResetField: vi.fn(),
      ...overrides,
    })
  );
}

describe('契约测试: 常规 Tab 管理员名单与隐私工具隔离开关配置区 (ConnectionTab Access Control)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const knownPeers: KnownPeerSummary[] = [
    {
      peer: PEER_A,
      short_openid: 'A1B2C3D4',
      last_message_time: Date.now() - 120_000,
      last_message_preview: '你好测试',
    },
    {
      peer: PEER_B,
      short_openid: 'B2C3D4E5',
      last_message_time: Date.now() - 3_600_000,
      last_message_preview: '晚安',
    },
    {
      peer: PEER_C,
      short_openid: 'C3D4E5F6',
      last_message_time: null,
      last_message_preview: '',
    },
  ];

  describe('1. 顶层平铺布局（不折叠）与总开关未勾选态契约', () => {
    it('默认配置下，「常规」Tab 直接平铺展示管理员名单与隐私工具隔离总开关（不折叠），未勾选总开关时不显示更多选项，且整个 HTML 不含 security', () => {
      const cardHtml = renderToStaticMarkup(
        React.createElement(KujiraSettingsCard, {
          initialExpanded: true,
          initialTab: 'connection',
          credentialsStatus: DEFAULT_CRED_STATUS,
          onSaveSettings: vi.fn(),
        })
      );

      expect(cardHtml.toLowerCase()).not.toContain('security');

      const connectionPanel = cardHtml.match(
        /id="kujira-tabpanel-connection"[\s\S]*?(?=<div[^>]*id="kujira-tabpanel-reply")/
      )![0];

      // 排序：多媒体缓存 TTL → 管理员名单 → 隔离可能泄露隐私的工具总开关
      const posTtl = connectionPanel.indexOf('id="kujira-image-ttl"');
      const posAdmins = connectionPanel.indexOf('id="kujira-admins-add"');
      const posPrivacySwitch = connectionPanel.indexOf('id="kujira-privacy-tools-enabled"');
      expect(posTtl).toBeGreaterThan(-1);
      expect(posAdmins).toBeGreaterThan(posTtl);
      expect(posPrivacySwitch).toBeGreaterThan(posAdmins);

      // 管理员名单直接可见
      expect(connectionPanel).toContain('管理员名单 (admins)');
      expect(connectionPanel).toContain('暂未配置，默认按 1 对 1 场景对所有单聊用户开放完整权限。');
      expect(connectionPanel).toContain('/权限');
      expect(connectionPanel).toContain('/模型 -默认');
      expect(connectionPanel).toContain('/思考 -默认');

      // 隔离可能泄露隐私的工具总开关（默认关闭）
      expect(connectionPanel).toContain('隔离可能泄露隐私的工具 (privacy_tools_enabled)');
      expect(connectionPanel).toMatch(/id="kujira-privacy-tools-enabled"[^>]*type="checkbox"/);
      expect(connectionPanel).not.toMatch(/id="kujira-privacy-tools-enabled"[^>]*checked/);

      // 总开关关闭时，不渲染「更多选项」和黑白名单区
      expect(connectionPanel).not.toContain('kujira-privacy-tools-more-section');
      expect(connectionPanel).not.toContain('kujira-privacy-tools-peer-filter');
      expect(connectionPanel).not.toContain('privacy_tools_list_mode');
    });
  });

  describe('2. 勾选总开关后的默认折叠「更多选项」与 hasCustomPrivacyToolsFilterConfig 自动展开契约', () => {
    it('勾选 privacy_tools_enabled 但未自定义名单时，显示默认折叠的「更多选项」按钮', () => {
      const html = renderConnectionTab({
        draft: { privacy_tools_enabled: true },
        initialKnownPeers: knownPeers,
      });

      expect(html.toLowerCase()).not.toContain('security');
      expect(html).toMatch(/id="kujira-privacy-tools-enabled"[^>]*checked/);
      expect(html).toContain('id="kujira-privacy-tools-more-section"');
      expect(html).toContain('id="kujira-privacy-tools-more-toggle"');
      expect(html).toContain('更多选项');
      expect(html).toMatch(
        /id="kujira-privacy-tools-more-toggle"[^>]*aria-expanded="false"/
      );
      expect(html).toMatch(
        /id="kujira-privacy-tools-more-toggle"[^>]*aria-controls="kujira-privacy-tools-peer-filter"/
      );
      expect(html).not.toContain('id="kujira-privacy-tools-peer-filter"');
    });

    it('仅默认空配置（白名单空表）返回 false，切黑名单或配置任一名单返回 true 且打开设置自动展开', () => {
      expect(hasCustomPrivacyToolsFilterConfig({})).toBe(false);
      expect(
        hasCustomPrivacyToolsFilterConfig({
          privacy_tools_list_mode: 'whitelist',
          privacy_tools_blacklist: [],
          privacy_tools_whitelist: [],
        })
      ).toBe(false);
      expect(
        hasCustomPrivacyToolsFilterConfig({
          privacy_tools_blacklist: [''],
          privacy_tools_whitelist: ['  '],
        })
      ).toBe(false);

      expect(hasCustomPrivacyToolsFilterConfig({ privacy_tools_list_mode: 'blacklist' })).toBe(true);
      expect(hasCustomPrivacyToolsFilterConfig({ privacy_tools_blacklist: [PEER_A] })).toBe(true);
      expect(hasCustomPrivacyToolsFilterConfig({ privacy_tools_whitelist: [PEER_B] })).toBe(true);

      const cases = [
        { privacy_tools_enabled: true, privacy_tools_list_mode: 'blacklist' as const },
        { privacy_tools_enabled: true, privacy_tools_blacklist: [PEER_A] },
        { privacy_tools_enabled: true, privacy_tools_whitelist: [PEER_B] },
      ];

      for (const draft of cases) {
        const html = renderConnectionTab({
          draft,
          initialKnownPeers: knownPeers,
        });
        expect(html).toMatch(/id="kujira-privacy-tools-more-toggle"[^>]*aria-expanded="true"/);
        expect(html).toContain('id="kujira-privacy-tools-peer-filter"');
        expect(html.toLowerCase()).not.toContain('security');
      }
    });
  });

  describe('3. 展开态脱敏用户选择器、内联添加态与黑白名单独立互斥契约', () => {
    it('开启总开关并展开「更多选项」后，默认展示白名单模式与空态提示', () => {
      const html = renderConnectionTab({
        draft: { privacy_tools_enabled: true },
        initialPrivacyFilterExpanded: true,
        initialKnownPeers: knownPeers,
      });

      expect(html.toLowerCase()).not.toContain('security');
      expect(html).toContain('id="kujira-privacy-tools-list-mode"');
      expect(html).toContain('隔离名单模式 (privacy_tools_list_mode)');
      expect(html).toContain('白名单模式');
      expect(html).toContain('黑名单模式');
      expect(html).toMatch(
        /id="kujira-privacy-tools-list-mode-option-whitelist"[^>]*aria-checked="true"/
      );
      expect(html).toContain('白名单用户 (privacy_tools_whitelist)');
      expect(html).toContain('暂未配置，所有单聊会话都会隔离可能泄露隐私的工具。');
      expect(html).not.toContain('id="kujira-privacy-tools-peer-editor"');
    });

    it('已选管理员与隐私名单内联添加态：展示短 OpenID + 相对时间 + 消息摘要与删除按钮，下拉框排除已选且绝不泄漏完整 OpenID', () => {
      const model = new KujiraFormModel({
        initialValues: {
          admins: [PEER_A],
          privacy_tools_enabled: true,
          privacy_tools_list_mode: 'whitelist',
          privacy_tools_whitelist: [PEER_B],
          privacy_tools_blacklist: [PEER_C],
        },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      const html = renderConnectionTab({
        model,
        draft: model.getDraft(),
        initialKnownPeers: knownPeers,
        initialAddingAdmin: true,
        initialAddingPrivacyPeer: true,
      });

      expect(html.toLowerCase()).not.toContain('security');
      expect(html).not.toContain(OPENID_A);
      expect(html).not.toContain(OPENID_B);
      expect(html).not.toContain(OPENID_C);

      // 管理员已选条目展示与内联编辑器
      expect(html).toContain(`data-testid="kujira-admins-item-${PEER_A}"`);
      expect(html).toContain(`data-testid="kujira-admins-remove-${PEER_A}"`);
      expect(html).toContain('A1B2C3D4…');
      expect(html).toContain('你好测试');
      expect(html).toMatch(/id="kujira-admins-add"[^>]*disabled/);
      expect(html).toContain('id="kujira-admins-editor"');
      const adminSelect = html.match(
        /<select[^>]*id="kujira-admins-select"[\s\S]*?<\/select>/
      )![0];
      expect(adminSelect).not.toContain(`value="${PEER_A}"`);
      expect(adminSelect).toContain(`value="${PEER_B}"`);
      expect(adminSelect).toContain(`value="${PEER_C}"`);

      // 白名单模式仅展示白名单成员 PEER_B，不混入黑名单成员 PEER_C
      expect(html).toContain(`data-testid="kujira-privacy-tools-peer-item-${PEER_B}"`);
      expect(html).not.toContain(`data-testid="kujira-privacy-tools-peer-item-${PEER_C}"`);
      const privacySelect = html.match(
        /<select[^>]*id="kujira-privacy-tools-peer-select"[\s\S]*?<\/select>/
      )![0];
      expect(privacySelect).not.toContain(`value="${PEER_B}"`);
      expect(privacySelect).toContain(`value="${PEER_A}"`);
      expect(privacySelect).toContain(`value="${PEER_C}"`);
    });

    it('黑名单模式独立读取 privacy_tools_blacklist，空态提示清晰区分', () => {
      const emptyBlacklistHtml = renderConnectionTab({
        draft: {
          privacy_tools_enabled: true,
          privacy_tools_list_mode: 'blacklist',
          privacy_tools_blacklist: [],
          privacy_tools_whitelist: [PEER_A],
        },
        initialKnownPeers: knownPeers,
      });

      expect(emptyBlacklistHtml).toMatch(
        /id="kujira-privacy-tools-list-mode-option-blacklist"[^>]*aria-checked="true"/
      );
      expect(emptyBlacklistHtml).toContain('黑名单用户 (privacy_tools_blacklist)');
      expect(emptyBlacklistHtml).toContain('暂未配置，所有单聊会话均保留完整工具。');
      expect(emptyBlacklistHtml).not.toContain(`data-testid="kujira-privacy-tools-peer-item-${PEER_A}"`);
    });
  });

  describe('4. KujiraFormModel 脏态与脱敏用户轮询契约', () => {
    it('KujiraFormModel 正确追踪 privacy_tools_enabled 等 5 项配置的 overridden / isDirty 与重置', () => {
      const model = new KujiraFormModel({
        initialValues: { ...DEFAULT_BASE_CONFIG },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      expect(model.isDirty()).toBe(false);
      expect(model.isOverridden('privacy_tools_enabled')).toBe(false);
      expect(model.isOverridden('admins')).toBe(false);

      model.setField('admins', [PEER_A]);
      model.setField('privacy_tools_enabled', true);
      model.setField('privacy_tools_list_mode', 'blacklist');
      model.setField('privacy_tools_blacklist', [PEER_B]);

      expect(model.isDirty()).toBe(true);
      expect(model.isOverridden('admins')).toBe(true);
      expect(model.isOverridden('privacy_tools_enabled')).toBe(true);
      expect(model.isOverridden('privacy_tools_list_mode')).toBe(true);
      expect(model.isOverridden('privacy_tools_blacklist')).toBe(true);

      model.resetField('admins');
      model.resetField('privacy_tools_enabled');
      model.resetField('privacy_tools_list_mode');
      model.resetField('privacy_tools_blacklist');
      expect(model.isDirty()).toBe(false);
    });

    it('startPeerListPolling 启动即拉取一次并每 5 秒轮询，卸载停止', () => {
      vi.useFakeTimers();
      const fetcher = vi.fn();

      expect(PEERS_ENDPOINT).toBe('/plugins/kujira/peers');
      expect(PEERS_POLL_MS).toBe(5_000);
      expect(formatRelativeSpeakTime(null)).toBe('暂无发言');
      expect(formatPeerDropdownLabel(knownPeers[0]!)).toContain('A1B2C3D4…');

      const stop = startPeerListPolling(fetcher, PEERS_POLL_MS);
      expect(fetcher).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(PEERS_POLL_MS);
      expect(fetcher).toHaveBeenCalledTimes(2);

      stop();
      vi.advanceTimersByTime(PEERS_POLL_MS * 2);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});
