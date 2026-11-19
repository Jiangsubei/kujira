/**
 * tests/contract/slang-settings-tab.test.ts
 * 契约测试: Web UI 设置卡「黑话学习」Tab 渲染与交互
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

describe('契约测试: Web UI 设置卡「黑话学习」Tab (Slang Settings Tab Contract)', () => {
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

  it('契约 1: SETTINGS_TABS 包含黑话学习 Tab，且渲染 Tab 按钮', () => {
    const slangTab = SETTINGS_TABS.find((t) => t.id === 'slang');
    expect(slangTab).toBeDefined();
    expect(slangTab?.label).toBe('黑话学习');

    const { html } = renderCard();
    expect(html).toContain('id="kujira-tab-slang"');
    expect(html).toContain('黑话学习');
  });

  it('契约 2: 切换至 slang Tab，直接展示条数上限、满额时行为与容量状态，不再渲染已移除的导出路径输入框', () => {
    const { html } = renderCard({ initialTab: 'slang' });

    expect(html).toContain('kujira-tabpanel-slang');
    expect(html).not.toContain('装载黑话学习套件');
    expect(html).not.toContain('id="kujira-slang-enabled"');

    expect(html).toContain('id="kujira-slang-max-entries"');
    expect(html).toContain('id="kujira-slang-evict-policy"');
    expect(html).not.toContain('id="kujira-slang-storage-path"');
    expect(html).not.toContain('.dsh/kujira/slang/slang.md');
    expect(html).toContain('容量状态:');

    expect(html).not.toContain('slang-budget-chars');
  });

  it('契约 3: 渲染「+ 添加黑话」图标按钮且位于容量状态右侧', () => {
    const { html } = renderCard({ initialTab: 'slang' });

    expect(html).toContain('kujira-slang-add-btn');
    expect(html).toContain('title="添加黑话词条"');
    expect(html).toMatch(/容量状态[\s\S]*?kujira-slang-add-btn/);
  });
});
