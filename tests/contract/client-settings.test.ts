/**
 * 契约测试：客户端 settings.section 侧边栏独立页面装配与 Kujira 纯净架构契约
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
  IconChevronDownOutlineMedium: () => null,
}));

import * as clientModule from '../../src/client/index.js';

const { name, inject, apply } = clientModule as any;
const KujiraSettingsSection = (clientModule as any).KujiraSettingsSection;
const KujiraSettingsCard = (clientModule as any).KujiraSettingsCard;

class MockElement {
  id = '';
  textContent = '';
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: MockElement[] = [];

  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }
  remove() {}
}

function createMockDocument() {
  const head = new MockElement();
  const body = new MockElement();
  return {
    head,
    body,
    createElement: () => new MockElement(),
    getElementById: () => null,
    querySelector: () => null,
  };
}

function createMockContext() {
  const injectedSlots: string[] = [];
  const registeredItems: Array<{ meta: any; component: any }> = [];

  const mockCtx = {
    slots: {
      inject: vi.fn((slotName: string, cb: () => any) => {
        injectedSlots.push(slotName);
        const res = cb?.();
        if (res && typeof res[Symbol.iterator] === 'function') {
          for (const _item of res) {
            // 消耗 generator
          }
        }
      }),
      register: vi.fn((meta: any, component: any) => {
        const item = { meta, component };
        registeredItems.push(item);
        return item;
      }),
    },
  };

  return { mockCtx, injectedSlots, registeredItems };
}

describe('契约测试: 客户端 settings.section 侧边栏独立页面与 Kujira 装配规范', () => {
  beforeEach(() => {
    (globalThis as any).document = createMockDocument();
  });

  describe('1. 模块元数据与依赖契约', () => {
    it('导出的模块名 name 必须对齐为 "kujira"', () => {
      expect(name).toBe('kujira');
    });

    it('导出的 inject 依赖数组必须收敛为 ["slots"]', () => {
      expect(inject).toBeDefined();
      expect(Array.isArray(inject)).toBe(true);
      expect(inject).toEqual(['slots']);
    });

    it('严禁包含已废弃的依赖项', () => {
      expect(inject).not.toContain('sessions');
      expect(inject).not.toContain('settingsScope');
      expect(inject).not.toContain('connection');
      expect(inject).not.toContain('workspace-controller');
    });
  });

  describe('2. DSH 侧边栏独立页面装配契约（settings.section）', () => {
    it('客户端 apply(ctx) 必须注入 settings.section 插槽，且绝不注入旧版插件/输入框插槽', () => {
      const { mockCtx, injectedSlots } = createMockContext();

      apply(mockCtx);

      expect(injectedSlots).toContain('settings.section');
      expect(injectedSlots).not.toContain('settings.plugin.item');
      expect(injectedSlots).not.toContain('conversation.composer.dock');
    });

    it('slots.register 注册元数据必须完全对齐 Kujira 规范', () => {
      const { mockCtx, registeredItems } = createMockContext();

      apply(mockCtx);

      const sectionRegistration = registeredItems.find(
        (item) => item.meta?.name === 'settings.section'
      );
      expect(sectionRegistration, '未找到 settings.section 注册项').toBeDefined();

      const { meta, component } = sectionRegistration!;

      expect(meta.name).toBe('settings.section');
      expect(meta.id).toBe('kujira');
      expect(meta.order).toBe(55);
      expect(meta.locale).toBeUndefined();

      expect(typeof meta.label).toBe('function');
      expect(meta.label()).toBe('QQ Kujira');

      expect(meta.inject).toBeUndefined();
      expect(component).toBe(KujiraSettingsSection);
    });
  });

  describe('3. 顶层组件导出与零明文静态渲染契约', () => {
    it('模块必须显式导出 KujiraSettingsSection 与 KujiraSettingsCard 组件', () => {
      expect(KujiraSettingsSection).toBeDefined();
      expect(KujiraSettingsCard).toBeDefined();
      expect(typeof KujiraSettingsSection === 'function').toBe(true);
      expect(React.isValidElement(React.createElement(KujiraSettingsSection))).toBe(true);
    });

    it('KujiraSettingsSection 支持静态渲染并展示凭据元数据徽章而不回显明文', () => {
      const closeMock = vi.fn();
      const html = renderToStaticMarkup(
        React.createElement(KujiraSettingsSection, {
          close: closeMock,
          initialConfig: { persona: '测试 Kujira 伙伴' },
          credentialsStatus: {
            appId: { configured: true, source: 'env', writable: true },
            appSecret: { configured: true, source: 'file', writable: true },
            ready: true,
          },
        })
      );
      expect(html).toContain('data-testid="kujira-bridge-section"');
      expect(html).toContain('QQ Kujira 机器人配置');
      expect(html).toContain('已配置 (来源: env)');
      expect(html).toContain('已配置 (来源: file)');
      expect(html).not.toContain('NapCat');

      // 保持 5 分区 Tab 结构
      expect(html).toContain('id="kujira-tab-connection"');
      expect(html).toContain('id="kujira-tab-persona"');
      expect(html).toContain('id="kujira-tab-memory"');
      expect(html).toContain('id="kujira-tab-face"');
      expect(html).toContain('id="kujira-tab-slang"');

      // AppID / AppSecret 只写保护不回显明文 + 保留核心连接配置项
      expect(html).toContain('id="kujira-cred-app-id"');
      expect(html).toMatch(/id="kujira-cred-app-id"[^>]*value=""/);
      expect(html).toContain('id="kujira-cred-app-secret"');
      expect(html).toMatch(/id="kujira-cred-app-secret"[^>]*type="password"/);
      expect(html).toMatch(/id="kujira-cred-app-secret"[^>]*value=""/);
      expect(html).toContain('id="kujira-new-message-behavior"');
      expect(html).toContain('id="kujira-image-ttl"');

      // 已固化为默认开启而移除的配置开关不再渲染
      expect(html).not.toContain('kujira-markdown-enabled');
      expect(html).not.toContain('markdown_enabled');
      expect(html).not.toContain('kujira-input-notify-enabled');
      expect(html).not.toContain('input_notify_enabled');
    });
  });
});
