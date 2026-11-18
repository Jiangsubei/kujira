/**
 * kujira Settings Card Styles — visual language aligned with official
 * DSH plugin cards (`dsh-client-ui-settings-plugins` PluginCard / fields).
 *
 * Token surface: `var(--dsw-alias-*)` (official DSH design system tokens).
 */

export const KUJIRA_CARD_CSS_ID = 'kujira/card.module.css';

const KUJIRA_CARD_CSS = `
.kujira_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;margin:0;transition:border-color .16s,background .16s}
.kujira_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.kujira_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.kujira_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.kujira_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.kujira_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.kujira_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}
.kujira_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.kujira_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.kujira_chevronOpen{transform:rotate(180deg)}
.kujira_badgePending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.kujira_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.kujira_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.kujira_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.kujira_discard,.kujira_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;white-space:nowrap;flex-shrink:0}
.kujira_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.kujira_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.kujira_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.kujira_discard:disabled,.kujira_save:disabled{opacity:.4;cursor:default}
.kujira_discard:focus-visible,.kujira_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.kujira_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.kujira_field+.kujira_field{border-top:1px solid var(--dsw-alias-border-l2)}
.kujira_switchRow{flex-direction:row;align-items:center;justify-content:space-between;gap:8px}
.kujira_fieldHead{align-items:center;gap:8px;display:flex}
.kujira_fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.kujira_fieldBadges{align-items:center;gap:8px;display:inline-flex}
.kujira_fieldBadge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.kujira_fieldBadgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.kujira_fieldReset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.kujira_fieldReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.kujira_fieldReset:disabled{cursor:default}
.kujira_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.kujira_textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:72px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;resize:vertical}
.kujira_input:focus-visible,.kujira_textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.kujira_input:disabled,.kujira_textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.kujira_inputInvalid{border-color:var(--dsw-alias-label-error)}
.kujira_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.kujira_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.kujira_checkbox{accent-color:var(--dsw-alias-brand-primary);width:18px;height:18px;cursor:pointer;flex:none}
.kujira_checkbox:disabled{cursor:default;opacity:.4}
.kujira_tabBar{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0 0;margin:0;overflow-x:auto}
.kujira_tab{appearance:none;background:0 0;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1.5;padding:6px 12px 8px;cursor:pointer;border-radius:6px 6px 0 0;transition:color .16s,border-color .16s;white-space:nowrap}
.kujira_tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.kujira_tabActive{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}
.kujira_tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.kujira_tabPanel{display:flex;flex-direction:column}
.kujira_tabPanelHidden{display:none !important}
.kujira_section{display:flex;flex-direction:column;width:100%;min-height:0;flex:1;padding:4px 0 24px;box-sizing:border-box}
.kujira_sectionHead{margin-bottom:16px;display:flex;flex-direction:column;gap:6px}
.kujira_sectionTitleRow{display:flex;align-items:center;gap:12px}
.kujira_sectionTitle{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:1.4;margin:0}
.kujira_sectionDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.kujira_sectionBody{display:flex;flex-direction:column;flex:1}
.kujira_faceUploadBar{display:flex;align-items:center;gap:10px;padding:12px 0;flex-wrap:wrap}
.kujira_faceGallery{margin-top:16px;display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.kujira_faceGalleryHead{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.kujira_faceGalleryTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.kujira_faceGallerySub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}
.kujira_faceGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(115px,1fr));column-gap:12px;row-gap:16px}
.kujira_faceCard{position:relative;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px;text-align:center;transition:border-color .16s,background .16s}
.kujira_faceCard:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}
.kujira_faceCardPreview{height:72px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);overflow:hidden;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.kujira_faceCardImg{max-width:100%;max-height:100%;object-fit:contain}
.kujira_faceCardTitle{font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:6px}
.kujira_faceCardActions{position:absolute;top:6px;right:6px;display:flex;gap:4px}
.kujira_faceActionBtn{appearance:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:4px;cursor:pointer;padding:3px;display:inline-flex;align-items:center;justify-content:center;transition:color .16s,border-color .16s}
.kujira_faceActionBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.kujira_faceActionDelete:hover{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.kujira_faceInlineEditor{margin-top:8px;padding:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;display:flex;flex-direction:column;gap:6px}
.kujira_faceEmpty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;color:var(--dsw-alias-label-tertiary);gap:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.kujira_faceEmptyText{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}
.kujira_modalOverlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;backdrop-filter:blur(2px)}
.kujira_modalPanel{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 20px 40px rgba(0,0,0,.45);width:100%;max-width:500px;overflow:hidden;display:flex;flex-direction:column}
.kujira_modalHead{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kujira_modalTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.kujira_modalClose{appearance:none;background:0 0;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:4px;border-radius:4px}
.kujira_modalClose:hover{color:var(--dsw-alias-label-primary)}
.kujira_modalBody{padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px}
.kujira_modalPreviewBox{width:100%;max-height:220px;height:220px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;padding:8px;box-sizing:border-box}
.kujira_modalPreviewImg{max-width:100%;max-height:100%;object-fit:contain}
.kujira_modalFooterRow{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);box-sizing:border-box}
.kujira_segContainer{display:inline-flex;align-items:center;background:var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));border:1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));border-radius:8px;padding:3px;gap:4px;width:fit-content;max-width:100%;box-sizing:border-box}
.kujira_segBtn{appearance:none;background:transparent;border:1.5px solid transparent;color:var(--dsw-alias-label-secondary, #9ca3af);font:inherit;font-size:13px;font-weight:500;line-height:1.4;padding:5px 18px;border-radius:6px;cursor:pointer;transition:all .16s ease;outline:none;text-align:center;user-select:none;white-space:nowrap}
.kujira_segBtn:hover:not(:disabled):not([aria-checked="true"]){color:var(--dsw-alias-label-primary, #ffffff);background:rgba(255, 255, 255, 0.04)}
.kujira_segBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #388bfd);outline-offset:1px}
.kujira_segBtn:disabled{opacity:.4;cursor:not-allowed}
.kujira_segBtnActive,.kujira_segBtn[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary, #388bfd) !important;background:var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));color:var(--dsw-alias-label-primary, #ffffff);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.kujira_peerFilterBox{display:flex;flex-direction:column;gap:10px;padding:12px;margin:0 0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}
.kujira_peerEditorRow{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.kujira_peerSelect{flex:1;min-width:0;height:28px;font-size:12px;padding:0 8px}
.kujira_peerEditorActions{display:inline-flex;align-items:center;gap:6px;flex:none}
.kujira_peerEditorBtn{height:24px;padding:0 10px;font-size:11px;line-height:1}
.kujira_peerList{display:flex;flex-direction:column;gap:6px}
.kujira_peerRow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.4}
.kujira_peerMeta{display:flex;align-items:center;gap:6px;min-width:0;flex:1;overflow:hidden}
.kujira_peerCode{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);flex:none}
.kujira_peerSub{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
`;

export function injectCardStyles(): void {
  if (typeof document === 'undefined') return;
  const selector = `style[data-plugin-css=${JSON.stringify(KUJIRA_CARD_CSS_ID)}]`;
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.pluginCss = KUJIRA_CARD_CSS_ID;
  tag.textContent = KUJIRA_CARD_CSS;
  document.head.appendChild(tag);
}

export const cardStyle = {
  card: 'kujira_card',
  cardOpen: 'kujira_cardOpen',
  header: 'kujira_header',
  headText: 'kujira_headText',
  name: 'kujira_name',
  description: 'kujira_description',
  chevron: 'kujira_chevron',
  chevronOpen: 'kujira_chevronOpen',
  badgePending: 'kujira_badgePending',
  body: 'kujira_body',
  tabBar: 'kujira_tabBar',
  tab: 'kujira_tab',
  tabActive: 'kujira_tabActive',
  tabPanel: 'kujira_tabPanel',
  tabPanelHidden: 'kujira_tabPanelHidden',
  footer: 'kujira_footer',
  failed: 'kujira_failed',
  discard: 'kujira_discard',
  save: 'kujira_save',
  segContainer: 'kujira_segContainer',
  segBtn: 'kujira_segBtn',
  segBtnActive: 'kujira_segBtnActive',
  peerFilterBox: 'kujira_peerFilterBox',
  peerEditorRow: 'kujira_peerEditorRow',
  peerSelect: 'kujira_peerSelect',
  peerEditorActions: 'kujira_peerEditorActions',
  peerEditorBtn: 'kujira_peerEditorBtn',
  peerList: 'kujira_peerList',
  peerRow: 'kujira_peerRow',
  peerMeta: 'kujira_peerMeta',
  peerCode: 'kujira_peerCode',
  peerSub: 'kujira_peerSub',
};

export const sectionStyle = {
  section: 'kujira_section',
  head: 'kujira_sectionHead',
  titleRow: 'kujira_sectionTitleRow',
  title: 'kujira_sectionTitle',
  description: 'kujira_sectionDescription',
  body: 'kujira_sectionBody',
  tabBar: 'kujira_tabBar',
  tab: 'kujira_tab',
  tabActive: 'kujira_tabActive',
  tabPanel: 'kujira_tabPanel',
  tabPanelHidden: 'kujira_tabPanelHidden',
  footer: 'kujira_footer',
  failed: 'kujira_failed',
  discard: 'kujira_discard',
  save: 'kujira_save',
  badgePending: 'kujira_badgePending',
};

export const fieldStyle = {
  field: 'kujira_field',
  switchRow: 'kujira_switchRow',
  head: 'kujira_fieldHead',
  label: 'kujira_fieldLabel',
  badges: 'kujira_fieldBadges',
  badge: 'kujira_fieldBadge',
  badgeMuted: 'kujira_fieldBadgeMuted',
  reset: 'kujira_fieldReset',
  input: 'kujira_input',
  textarea: 'kujira_textarea',
  inputInvalid: 'kujira_inputInvalid',
  invalid: 'kujira_invalid',
  hint: 'kujira_hint',
  checkbox: 'kujira_checkbox',
  segContainer: 'kujira_segContainer',
  segBtn: 'kujira_segBtn',
  segBtnActive: 'kujira_segBtnActive',
  peerFilterBox: 'kujira_peerFilterBox',
  peerEditorRow: 'kujira_peerEditorRow',
  peerSelect: 'kujira_peerSelect',
  peerEditorActions: 'kujira_peerEditorActions',
  peerEditorBtn: 'kujira_peerEditorBtn',
  peerList: 'kujira_peerList',
  peerRow: 'kujira_peerRow',
  peerMeta: 'kujira_peerMeta',
  peerCode: 'kujira_peerCode',
  peerSub: 'kujira_peerSub',
};

export const faceStyle = {
  uploadBar: 'kujira_faceUploadBar',
  gallery: 'kujira_faceGallery',
  galleryHead: 'kujira_faceGalleryHead',
  galleryTitle: 'kujira_faceGalleryTitle',
  gallerySub: 'kujira_faceGallerySub',
  grid: 'kujira_faceGrid',
  card: 'kujira_faceCard',
  cardPreview: 'kujira_faceCardPreview',
  cardImg: 'kujira_faceCardImg',
  cardTitle: 'kujira_faceCardTitle',
  cardActions: 'kujira_faceCardActions',
  actionBtn: 'kujira_faceActionBtn',
  actionDelete: 'kujira_faceActionDelete',
  inlineEditor: 'kujira_faceInlineEditor',
  empty: 'kujira_faceEmpty',
  emptyText: 'kujira_faceEmptyText',
  modalOverlay: 'kujira_modalOverlay',
  modalPanel: 'kujira_modalPanel',
  modalHead: 'kujira_modalHead',
  modalTitle: 'kujira_modalTitle',
  modalClose: 'kujira_modalClose',
  modalBody: 'kujira_modalBody',
  modalPreviewBox: 'kujira_modalPreviewBox',
  modalPreviewImg: 'kujira_modalPreviewImg',
  modalFooterRow: 'kujira_modalFooterRow',
};
