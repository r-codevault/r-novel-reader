/**
 * webview/reader/store.ts — 全局响应式 store + 设置持久化 + 主题变量
 */
import { reactive } from 'vue';
import type { ReadingSettings, ThemeDef } from '../../src/settings';
import { state, send, type ChapterPayload } from './composables/vscode';
import { parseShortcut } from './composables/shortcut';

/** 由构建期注入的常量(虚拟模块, 见 vite.config.mjs; 单一来源 src/settings.ts) */
import { THEMES, FONT_STACKS, DEFAULT_SETTINGS, CONTENT_WIDTH, PROVINCES, PROVINCE_THEMES, SOLAR_TERMS, TERM_THEMES } from 'virtual:novel-constants';
export { THEMES, FONT_STACKS, DEFAULT_SETTINGS, CONTENT_WIDTH, PROVINCES, PROVINCE_THEMES, SOLAR_TERMS, TERM_THEMES };

export { state };

export function themeOf(id: string, province?: string, term?: string): ThemeDef {
  if (id === 'province') {
    // 地域色彩主题: 色板在构建期按 34 个省算好(vite.config), 端上直接查表
    return PROVINCE_THEMES[province || ''] || PROVINCE_THEMES['110000'] || THEMES[0];
  }
  if (id === 'term') {
    // 廿四节气主题: 同样构建期算好 24 套色板
    return TERM_THEMES[term || ''] || TERM_THEMES['lichun'] || THEMES[0];
  }
  for (const t of THEMES) { if (t.id === id) { return t; } }
  return THEMES[0];
}

/** 把主题色写到 :root CSS 变量(与旧 applySettings 一致) */
/**
 * 仅预览(不落盘): 用临时设置覆盖主题变量。
 * 用于省份列表悬浮预览 —— 只改 CSS 变量, 不动 state.settings, 因此不会触发持久化。
 */
export function previewTheme(patch: Partial<ReadingSettings>): void {
  if (!state.settings) { return; }
  applyThemeVars(Object.assign({}, state.settings, patch) as ReadingSettings);
}

/** 结束预览: 还原为当前真实设置对应色板 */
export function restoreTheme(): void {
  if (!state.settings) { return; }
  applyThemeVars(state.settings);
}

export function applyThemeVars(s: ReadingSettings): void {
  const t = themeOf(s.theme, s.province, s.term);
  const root = document.documentElement;
  // 暴露主题 id 供 CSS 按主题分支(如 logo 放射线在浅色/黑夜用不同颜色)
  root.dataset.theme = t.id;
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
  // 滚动条: VS Code 注入的滚动条样式用的是 --vscode-scrollbarSlider-*, 需一并映射到主题色
  root.style.setProperty('--vscode-scrollbarSlider-background', t.chromeBorder);
  root.style.setProperty('--vscode-scrollbarSlider-hoverBackground', t.accent);
  root.style.setProperty('--vscode-scrollbarSlider-activeBackground', t.accent);
  // 阅读排版
  root.style.setProperty('--font-size', s.fontSize + 'px');
  root.style.setProperty('--font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.system);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--para-spacing', s.paragraphSpacing + 'em');
  applyContentWidth(s);
  syncXScrollbar();
}

/**
 * 写入栏宽:
 *  - widthRatio > 0 -> 预设比例档, 宽度 = 视口宽 × 比例(跟随窗口变化)
 *  - widthRatio = 0 -> 自定义像素(contentWidth), 超出视口时文档横向滚动
 */
function applyContentWidth(s: ReadingSettings): void {
  const root = document.documentElement;
  const ratio = Number(s.widthRatio) || 0;
  const vw = root.clientWidth || window.innerWidth || 0;
  const w = ratio > 0 && vw > 0
    ? Math.round(vw * ratio)
    : Math.round(Number(s.contentWidth) || 720);
  root.style.setProperty('--content-width', w + 'px');
  root.dataset.widthMode = ratio > 0 ? 'preset' : 'custom';
}

// 比例档需要跟随窗口: 尺寸变化时只重算栏宽(不重跑整套主题变量)
window.addEventListener('resize', function () {
  if (!state.settings) { return; }
  if ((Number(state.settings.widthRatio) || 0) > 0) { applyContentWidth(state.settings); }
  syncXScrollbar();
});

let xSbPending = false;
/**
 * 横向滚动条实测高度 -> --x-sb。
 * 自定义宽度超出窗口时, 文档底部会出现横向滚动条, 固定状态栏会把它盖住, 故让状态栏上移让位。
 * (每帧至多量一次, 避免拖拽时反复触发布局)
 */
export function syncXScrollbar(): void {
  if (xSbPending) { return; }
  xSbPending = true;
  requestAnimationFrame(function () {
    xSbPending = false;
    const root = document.documentElement;
    const h = root.dataset.widthMode === 'custom'
      ? Math.max(0, window.innerHeight - root.clientHeight)
      : 0;
    root.style.setProperty('--x-sb', h + 'px');
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPatch: Partial<ReadingSettings> = {};

/**
 * 设置变更(乐观应用 + 250ms 累积防抖保存)。
 * 累积合并: 后一次 patch 不能覆盖前一次(否则滚轮改字号会被顶掉)。
 * 例外: 主题变更立即提交(侧边栏跟随主题, 需要无延迟)。
 */
export function persistSettings(patch: Partial<ReadingSettings>): void {
  state.settings = Object.assign({}, state.settings, patch) as ReadingSettings;
  applyThemeVars(state.settings);
  state.prevCombo = parseShortcut(state.settings.shortcutPrev);
  state.nextCombo = parseShortcut(state.settings.shortcutNext);
  pendingPatch = Object.assign(pendingPatch, patch);
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // 主题切换 / 状态栏显隐 / 栏宽档位 是离散操作 -> 立即提交, 不吃防抖延迟
  const immediate =
    Object.prototype.hasOwnProperty.call(patch, 'theme') ||
    Object.prototype.hasOwnProperty.call(patch, 'showStatusBar') ||
    Object.prototype.hasOwnProperty.call(patch, 'widthRatio') ||
    Object.prototype.hasOwnProperty.call(patch, 'contentWidth');
  if (immediate) {
    const sending = pendingPatch;
    pendingPatch = {};
    send({ type: 'updateSettings', patch: sending });
    return;
  }
  saveTimer = setTimeout(function () {
    const sending = pendingPatch;
    pendingPatch = {};
    send({ type: 'updateSettings', patch: sending });
  }, 250);
}

export function stepFontSize(d: number): void {
  const cur = state.settings?.fontSize || DEFAULT_SETTINGS.fontSize;
  const next = Math.min(32, Math.max(12, cur + d));
  if (next !== cur) { persistSettings({ fontSize: next }); }
}

export function stepSetting(key: 'lineHeight' | 'paragraphSpacing', d: number, min: number, max: number): void {
  if (!state.settings) { return; }
  const cur = Number(state.settings[key]) || 0;
  const next = Math.min(max, Math.max(min, Math.round((cur + d) * 10) / 10));
  if (next !== cur) {
    persistSettings({ [key]: next } as Partial<ReadingSettings>);
  }
}

export function resetSettings(): void {
  send({ type: 'resetSettings' });
}

/** 进度上报(600ms 节流 / immediate 立即) */
let progressTimer: ReturnType<typeof setTimeout> | null = null;
export function sendProgress(immediate: boolean): void {
  const send2 = function (): void {
    if (!state.chapter) { return; }
    const max = document.body.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    send({ type: 'saveProgress', chapterIndex: state.chapter.index, scrollRatio: ratio });
  };
  if (immediate) {
    send2();
  } else {
    if (progressTimer) { clearTimeout(progressTimer); }
    progressTimer = setTimeout(send2, 600);
  }
}

export type { ChapterPayload, ReadingSettings };
