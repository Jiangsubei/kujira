/**
 * kujira Client WebUI Plugin Entry Point
 * Injects Kujira settings section into the DSH Web UI settings.section extension slot.
 */

import { KujiraSettingsSection, KujiraSettingsCard } from './card.js';

export const name = 'kujira';
export const inject = ['slots'];

export function apply(ctx: any) {
  if (!ctx?.slots?.inject) return;

  // 注册 0.2.1 规范侧边栏独立设置板块 (settings.section)
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.section',
        id: 'kujira',
        order: 55,
        label: () => 'QQ Kujira',
      },
      KujiraSettingsSection
    );
  });
}

export { KujiraSettingsSection, KujiraSettingsCard };
