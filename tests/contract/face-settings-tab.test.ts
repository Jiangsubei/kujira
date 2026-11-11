/**
 * tests/contract/face-settings-tab.test.ts
 * 契约测试: Web UI 设置卡「表情包」Tab 渲染与交互
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconTrashOutlineRegular: () => null,
}));

import {
  KujiraSettingsCard,
  SETTINGS_TABS,
  type CardProps,
  type CardController,
} from '../../src/client/card.js';

describe('契约测试: Web UI 设置卡「表情包」Tab (Face Settings Tab Contract)', () => {
  function renderCard(props: Partial<CardProps> = {}) {
    let captured: CardController | null = null;
    const html = renderToStaticMarkup(
      React.createElement(KujiraSettingsCard, {
        initialExpanded: true,
        controllerRef: (ctrl) => {
          captured = ctrl;
        },
        ...props,
      })
    );
    return { html, controller: captured };
  }

  it('契约 1: SETTINGS_TABS 包含表情包 Tab，且渲染 Tab 按钮', () => {
    const faceTab = SETTINGS_TABS.find((t) => t.id === 'face');
    expect(faceTab).toBeDefined();
    expect(faceTab?.label).toBe('表情包');

    const { html } = renderCard();
    expect(html).toContain('id="kujira-tab-face"');
    expect(html).toContain('表情包');
  });

  it('契约 2: 切换至 face Tab，默认渲染总开关 face_enabled (默认关闭)', () => {
    const { html } = renderCard({ initialTab: 'face' });

    expect(html).toContain('kujira-tabpanel-face');
    expect(html).toContain('装载表情包工具集');
    expect(html).toContain('id="kujira-face-enabled"');

    expect(html).not.toContain('id="kujira-face-store-max"');
    expect(html).not.toContain('kujira-face-gallery');
    expect(html).not.toContain('face_sub_type');
  });

  it('契约 3: 总开关开启 (face_enabled=true) 时展示配额、淘汰策略、默认目录 .dsh/kujira/faces 与表情画廊', () => {
    const { html } = renderCard({
      initialTab: 'face',
      initialConfig: {
        face_enabled: true,
        face_store_max: 100,
        face_evict_policy: 'reject',
      },
    });

    expect(html).toContain('kujira-tabpanel-face');
    expect(html).toContain('id="kujira-face-store-max"');
    expect(html).toContain('id="kujira-face-evict-policy"');
    expect(html).toContain('id="kujira-face-store-dir"');
    expect(html).toContain('.dsh/kujira/faces');
    expect(html).toContain('kujira-face-gallery');
    expect(html).toContain('kujira-face-upload-bar');
    expect(html).toContain('kujira-face-upload-btn');
    expect(html).toContain('上传表情');
    expect(html).toContain('kujira-face-empty');
    expect(html).toContain('暂未收录表情包');
    expect(html).not.toContain('face_sub_type');
  });
});
