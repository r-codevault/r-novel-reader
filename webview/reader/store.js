import { reactive } from 'vue';
import { vscode } from './composables/vscode.js';
import { parseShortcut } from './composables/shortcut.js';

/** 由构建时 vite define 注入的常量 */
export const THEMES = __THEMES__;
export const FONT_STACKS = __FONT_STACKS__;
export const DEFAULT_SETTINGS = __DEFAULT_SETTINGS__;

/** 全局共享响应式状态(与扩展消息协议对应) */
export const store = reactive({
  novel: null, // { bookTitle, author, totalChapters, totalWords }
  settings: Object.assign({}, DEFAULT_SETTINGS),
  chapter: null, // { index, title, paragraphs, totalChapters, chapterWords, scrollRatio }
  chapters: [],
  catReverse: false,
  catCollapsed: [],
  // UI 状态
  catalogOpen: false,
  settingsOpen: false,
  fabAwake: false,
  fabDragging: false,
});

let saveTimer = null;
let pendingPatch = {};

/** 主题对象 by id */
export function themeOf(id) {
  for (var i = 0; i < THEMES.length; i++) { if (THEMES[i].id === id) { return THEMES[i]; } }
  return THEMES[0];
}

/** 把主题色写到 :root CSS 变量(逻辑与旧 applySettings 完全一致) */
export function applyThemeVars(s) {
  var t = themeOf(s.theme);
  var root = document.documentElement;
  root.style.setProperty('--bg', t.bg);
  root.style.setProperty('--fg', t.fg);
  root.style.setProperty('--page-bg', t.pageBg);
  root.style.setProperty('--chrome-bg', t.chromeBg);
  root.style.setProperty('--chrome-fg', t.fg);
  root.style.setProperty('--chrome-border', t.chromeBorder);
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-fg', t.accentFg);
  root.style.setProperty('--btn-hover', t.accent);
  root.style.setProperty('--input-bg', t.bg);
  root.style.setProperty('--input-fg', t.fg);
  root.style.setProperty('--input-border', t.chromeBorder);
  // 设置面板配色: 全部来自 THEMES 主题变量(调试时改 settings.ts 即可)
  root.style.setProperty('--sp-bg', t.chromeBg);
  root.style.setProperty('--sp-fg', t.fg);
  root.style.setProperty('--sp-border', t.chromeBorder);
  root.style.setProperty('--sp-muted', t.muted);
  root.style.setProperty('--sp-hover', t.panelHover);
  root.style.setProperty('--sp-accent', t.panelAccent);
  root.style.setProperty('--sp-control-bg', t.bg);
  // 悬浮球: 面板同色底 + 主题色图标/描边
  root.style.setProperty('--fab-bg', t.chromeBg);
  root.style.setProperty('--fab-fg', t.accent);
  root.style.setProperty('--fab-border', t.chromeBorder);
  // 阅读排版
  root.style.setProperty('--font-size', s.fontSize + 'px');
  root.style.setProperty('--font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.system);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--para-spacing', s.paragraphSpacing + 'em');
  root.style.setProperty('--content-width', s.contentWidth + 'px');
}

/**
 * 设置变更(乐观应用 + 250ms 累积防抖保存)。
 * 累积合并: 后一次 patch 不能覆盖前一次(否则滚轮改字号会被顶掉)。
 */
export function persistSettings(patch) {
  var merged = Object.assign({}, store.settings, patch);
  store.settings = merged;
  applyThemeVars(merged);
  store.prevCombo = parseShortcut(merged.shortcutPrev);
  store.nextCombo = parseShortcut(merged.shortcutNext);
  pendingPatch = Object.assign(pendingPatch, patch);
  if (saveTimer) { clearTimeout(saveTimer); }
  saveTimer = setTimeout(function () {
    var sending = pendingPatch;
    pendingPatch = {};
    vscode.postMessage({ type: 'updateSettings', patch: sending });
  }, 250);
}

export function stepFontSize(d) {
  var cur = store.settings.fontSize || DEFAULT_SETTINGS.fontSize;
  var next = Math.min(32, Math.max(12, cur + d));
  if (next !== cur) { persistSettings({ fontSize: next }); }
}

export function stepSetting(key, d, min, max) {
  var cur = Number(store.settings[key]) || 0;
  var next = Math.min(max, Math.max(min, Math.round((cur + d) * 10) / 10));
  if (next !== cur) {
    var patch = {};
    patch[key] = next;
    persistSettings(patch);
  }
}

/** 发送设置到扩展(重置等场景) */
export function resetSettings() {
  vscode.postMessage({ type: 'resetSettings' });
}
