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
  hasCustomAccessControlConfig,
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

describe('契约测试: 常规 Tab 管理员权限与隐私工具隔离配置区 (ConnectionTab Access Control)', () => {
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

  describe('1. 默认折叠态与不含禁用关键词契约', () => {
    it('默认全空配置时，「常规」Tab 下「更多选项」默认折叠、不渲染内部面板，且整个 HTML 不含 security', () => {
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

      // 「更多选项」位于多媒体缓存 TTL 下方
      const posTtl = connectionPanel.indexOf('id="kujira-image-ttl"');
      const posMoreSection = connectionPanel.indexOf('id="kujira-access-control-more-section"');
      expect(posTtl).toBeGreaterThan(-1);
      expect(posMoreSection).toBeGreaterThan(posTtl);

      expect(connectionPanel).toContain('data-testid="kujira-access-control-more-section"');
      expect(connectionPanel).toContain('id="kujira-access-control-more-toggle"');
      expect(connectionPanel).toContain('更多选项');
      expect(connectionPanel).toMatch(
        /id="kujira-access-control-more-toggle"[^>]*aria-expanded="false"/
      );
      expect(connectionPanel).toMatch(
        /id="kujira-access-control-more-toggle"[^>]*aria-controls="kujira-access-control-panel"/
      );
      expect(connectionPanel).not.toContain('id="kujira-access-control-panel"');
      expect(connectionPanel).not.toContain('admins');
      expect(connectionPanel).not.toContain('privacy_tools_list_mode');
    });
  });

  describe('2. hasCustomAccessControlConfig 判定与自动展开契约', () => {
    it('仅默认空配置返回 false，配置任一项即返回 true 且打开常规 Tab 时自动展开', () => {
      expect(hasCustomAccessControlConfig({})).toBe(false);
      expect(
        hasCustomAccessControlConfig({
          admins: [],
          privacy_tools_list_mode: 'blacklist',
          privacy_tools_blacklist: [],
          privacy_tools_whitelist: [],
        })
      ).toBe(false);
      expect(
        hasCustomAccessControlConfig({
          admins: ['   '],
          privacy_tools_blacklist: [''],
          privacy_tools_whitelist: ['  '],
        })
      ).toBe(false);

      expect(hasCustomAccessControlConfig({ admins: [PEER_A] })).toBe(true);
      expect(hasCustomAccessControlConfig({ privacy_tools_list_mode: 'whitelist' })).toBe(true);
      expect(hasCustomAccessControlConfig({ privacy_tools_blacklist: [PEER_A] })).toBe(true);
      expect(hasCustomAccessControlConfig({ privacy_tools_whitelist: [PEER_B] })).toBe(true);

      // 逐项验证自动展开
      const cases = [
        { admins: [PEER_A] },
        { privacy_tools_list_mode: 'whitelist' as const },
        { privacy_tools_blacklist: [PEER_A] },
        { privacy_tools_whitelist: [PEER_B] },
      ];

      for (const draft of cases) {
        const html = renderConnectionTab({
          draft,
          initialKnownPeers: knownPeers,
        });
        expect(html).toMatch(/id="kujira-access-control-more-toggle"[^>]*aria-expanded="true"/);
        expect(html).toContain('id="kujira-access-control-panel"');
        expect(html.toLowerCase()).not.toContain('security');
      }
    });
  });

  describe('3. 展开态管理员名单与隐私工具隔离选择器、编辑态与已选展示契约', () => {
    it('展开态默认空配置下展示管理员名单与隐私工具隔离说明、黑名单默认态与空态提示，且不含 security', () => {
      const html = renderConnectionTab({
        initialAccessControlExpanded: true,
        initialKnownPeers: knownPeers,
      });

      expect(html.toLowerCase()).not.toContain('security');
      expect(html).toMatch(/id="kujira-access-control-more-toggle"[^>]*aria-expanded="true"/);
      expect(html).toContain('id="kujira-access-control-panel"');
      expect(html).toContain('data-testid="kujira-access-control-panel"');

      // 管理员名单
      expect(html).toContain('管理员名单 (admins)');
      expect(html).toContain('id="kujira-admins-add"');
      expect(html).toContain('暂未配置，默认按 1 对 1 场景对所有单聊用户开放完整权限。');
      expect(html).toContain('/权限');
      expect(html).toContain('/模型 -默认');
      expect(html).toContain('/思考 -默认');
      expect(html).not.toContain('id="kujira-admins-editor"');

      // 隔离可能泄露隐私的工具
      expect(html).toContain('id="kujira-privacy-tools-list-mode"');
      expect(html).toContain('隔离可能泄露隐私的工具 (privacy_tools_list_mode)');
      expect(html).toContain('黑名单模式');
      expect(html).toContain('白名单模式');
      expect(html).toMatch(
        /id="kujira-privacy-tools-list-mode-option-blacklist"[^>]*aria-checked="true"/
      );
      expect(html).toContain('黑名单用户 (privacy_tools_blacklist)');
      expect(html).toContain('id="kujira-privacy-tools-peer-add"');
      expect(html).toContain('暂未配置，所有单聊会话均保留完整工具。');
      expect(html).not.toContain('id="kujira-privacy-tools-peer-editor"');
    });

    it('已选管理员与内联添加态：展示短 OpenID + 相对时间 + 消息摘要与删除按钮，下拉框排除已选且绝不泄漏完整 OpenID', () => {
      const model = new KujiraFormModel({
        initialValues: {
          admins: [PEER_A],
          privacy_tools_list_mode: 'blacklist',
          privacy_tools_blacklist: [PEER_B],
          privacy_tools_whitelist: [],
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

      // 管理员已选条目展示（短 OpenID + 相对时间 + 消息摘要 + 移出按钮）
      expect(html).toContain(`data-testid="kujira-admins-item-${PEER_A}"`);
      expect(html).toContain(`data-testid="kujira-admins-remove-${PEER_A}"`);
      expect(html).toContain('A1B2C3D4…');
      expect(html).toContain('你好测试');

      // 管理员内联编辑行：+ 禁用、有取消/保存按钮、下拉框排除 PEER_A 包含 PEER_B 与 PEER_C
      expect(html).toMatch(/id="kujira-admins-add"[^>]*disabled/);
      expect(html).toContain('id="kujira-admins-editor"');
      expect(html).toContain('id="kujira-admins-cancel"');
      expect(html).toContain('id="kujira-admins-save"');
      const adminSelect = html.match(
        /<select[^>]*id="kujira-admins-select"[\s\S]*?<\/select>/
      )![0];
      expect(adminSelect).not.toContain(`value="${PEER_A}"`);
      expect(adminSelect).toContain(`value="${PEER_B}"`);
      expect(adminSelect).toContain('B2C3D4E5…');
      expect(adminSelect).toContain('晚安');
      expect(adminSelect).toContain(`value="${PEER_C}"`);
      expect(adminSelect).toContain('暂无发言');

      // 隐私工具黑名单已选条目与内联编辑行：排除 PEER_B 包含 PEER_A
      expect(html).toContain(`data-testid="kujira-privacy-tools-peer-item-${PEER_B}"`);
      expect(html).toContain(`data-testid="kujira-privacy-tools-peer-remove-${PEER_B}"`);
      expect(html).toMatch(/id="kujira-privacy-tools-peer-add"[^>]*disabled/);
      expect(html).toContain('id="kujira-privacy-tools-peer-editor"');
      expect(html).toContain('id="kujira-privacy-tools-peer-cancel"');
      expect(html).toContain('id="kujira-privacy-tools-peer-save"');
      const privacySelect = html.match(
        /<select[^>]*id="kujira-privacy-tools-peer-select"[\s\S]*?<\/select>/
      )![0];
      expect(privacySelect).not.toContain(`value="${PEER_B}"`);
      expect(privacySelect).toContain(`value="${PEER_A}"`);
    });
  });

  describe('4. 黑名单/白名单独立存储、互不串扰与 KujiraFormModel 字段契约', () => {
    it('黑名单模式与白名单模式各自独立读取对应列表并展示对应空态提示', () => {
      // 黑名单空、白名单有 PEER_B -> 黑名单模式下只看黑名单，显示黑名单空态且不串入 PEER_B
      const blacklistHtml = renderConnectionTab({
        draft: {
          privacy_tools_list_mode: 'blacklist',
          privacy_tools_blacklist: [],
          privacy_tools_whitelist: [PEER_B],
        },
        initialKnownPeers: knownPeers,
      });
      expect(blacklistHtml).toContain('黑名单用户 (privacy_tools_blacklist)');
      expect(blacklistHtml).toContain('暂未配置，所有单聊会话均保留完整工具。');
      expect(blacklistHtml).not.toContain(`data-testid="kujira-privacy-tools-peer-item-${PEER_B}"`);

      // 白名单空、黑名单有 PEER_A -> 白名单模式下只看白名单，显示白名单空态且不串入 PEER_A
      const whitelistEmptyHtml = renderConnectionTab({
        draft: {
          privacy_tools_list_mode: 'whitelist',
          privacy_tools_blacklist: [PEER_A],
          privacy_tools_whitelist: [],
        },
        initialKnownPeers: knownPeers,
      });
      expect(whitelistEmptyHtml).toMatch(
        /id="kujira-privacy-tools-list-mode-option-whitelist"[^>]*aria-checked="true"/
      );
      expect(whitelistEmptyHtml).toContain('白名单用户 (privacy_tools_whitelist)');
      expect(whitelistEmptyHtml).toContain('暂未配置，所有单聊会话都会隔离可能泄露隐私的工具。');
      expect(whitelistEmptyHtml).not.toContain(
        `data-testid="kujira-privacy-tools-peer-item-${PEER_A}"`
      );

      // 白名单含 PEER_B、黑名单含 PEER_A -> 白名单模式仅展示 PEER_B
      const whitelistFilledHtml = renderConnectionTab({
        draft: {
          privacy_tools_list_mode: 'whitelist',
          privacy_tools_blacklist: [PEER_A],
          privacy_tools_whitelist: [PEER_B],
        },
        initialKnownPeers: knownPeers,
      });
      expect(whitelistFilledHtml).toContain(
        `data-testid="kujira-privacy-tools-peer-item-${PEER_B}"`
      );
      expect(whitelistFilledHtml).not.toContain(
        `data-testid="kujira-privacy-tools-peer-item-${PEER_A}"`
      );
    });

    it('KujiraFormModel 正确跟踪 admins / privacy_tools_* 的 isOverridden / isDirty / resetField', () => {
      const model = new KujiraFormModel({
        initialValues: {
          admins: [],
          privacy_tools_list_mode: 'blacklist',
          privacy_tools_blacklist: [],
          privacy_tools_whitelist: [],
        },
        baseDefaults: DEFAULT_BASE_CONFIG,
      });

      expect(model.isOverridden('admins')).toBe(false);
      expect(model.isOverridden('privacy_tools_list_mode')).toBe(false);
      expect(model.isOverridden('privacy_tools_blacklist')).toBe(false);
      expect(model.isOverridden('privacy_tools_whitelist')).toBe(false);
      expect(model.isDirty()).toBe(false);

      model.setField('admins', [PEER_A]);
      model.setField('privacy_tools_list_mode', 'whitelist');
      model.setField('privacy_tools_whitelist', [PEER_B]);
      expect(model.isOverridden('admins')).toBe(true);
      expect(model.isOverridden('privacy_tools_list_mode')).toBe(true);
      expect(model.isOverridden('privacy_tools_whitelist')).toBe(true);
      expect(model.isOverridden('privacy_tools_blacklist')).toBe(false);
      expect(model.isDirty()).toBe(true);

      model.resetField('admins');
      expect(model.getDraft().admins).toEqual([]);
      expect(model.isOverridden('admins')).toBe(false);

      model.resetField('privacy_tools_list_mode');
      model.resetField('privacy_tools_whitelist');
      expect(model.getDraft().privacy_tools_list_mode).toBe('blacklist');
      expect(model.getDraft().privacy_tools_whitelist).toEqual([]);
      expect(model.isDirty()).toBe(false);
    });
  });

  describe('5. 公共脱敏格式化与 5 秒轮询启停契约', () => {
    it('PeerListEditor 导出的端点、相对时间格式化与 5 秒轮询启停逻辑符合契约', () => {
      expect(PEERS_ENDPOINT).toBe('/plugins/kujira/peers');
      expect(PEERS_POLL_MS).toBe(5_000);

      const now = 1_700_000_300_000;
      expect(formatRelativeSpeakTime(null, now)).toBe('暂无发言');
      expect(formatRelativeSpeakTime(now - 10_000, now)).toBe('刚刚');
      expect(formatRelativeSpeakTime(now - 5 * 60_000, now)).toBe('5分钟前');

      const label = formatPeerDropdownLabel(
        {
          peer: PEER_A,
          short_openid: 'A1B2C3D4',
          last_message_time: now - 5 * 60_000,
          last_message_preview: '权限测试',
        },
        now
      );
      expect(label).toBe('A1B2C3D4… · 5分钟前 · “权限测试”');

      vi.useFakeTimers();
      const fetcher = vi.fn();
      const stop = startPeerListPolling(fetcher, PEERS_POLL_MS);

      expect(fetcher).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(10_000);
      expect(fetcher).toHaveBeenCalledTimes(4);

      stop();
      vi.advanceTimersByTime(15_000);
      expect(fetcher).toHaveBeenCalledTimes(4);
    });
  });
});
