/**
 * webview/reader/store.ts — 全局响应式 store + 设置持久化 + 主题变量
 */
import { reactive } from 'vue';
import type { ReadingSettings, ThemeDef } from '../../src/settings';
import { state, send, saveRestoreState, type ChapterPayload } from './composables/vscode';
import { parseShortcut } from './composables/shortcut';

/** 由构建期注入的常量(虚拟模块, 见 vite.config.mjs; 单一来源 src/settings.ts) */
import { THEMES, FONT_STACKS, DEFAULT_SETTINGS, CONTENT_WIDTH, PROVINCES, PROVINCE_THEMES, SOLAR_TERMS, TERM_THEMES, FESTIVALS, FESTIVAL_THEMES } from 'virtual:novel-constants';
export { THEMES, FONT_STACKS, DEFAULT_SETTINGS, CONTENT_WIDTH, PROVINCES, PROVINCE_THEMES, SOLAR_TERMS, TERM_THEMES, FESTIVALS, FESTIVAL_THEMES };

/** 界面字号: 纯逻辑模块(vscode-free), 扩展与 webview 共用同一份范围与派生规则 */
import { UI_FONT, clampUiFont, uiFontVars } from '../../src/uiFont';
export { UI_FONT };

export { state };

export function themeOf(id: string, province?: string, term?: string, festival?: string): ThemeDef {
  if (id === 'province') {
    // 地域色彩主题: 色板在构建期按 34 个省算好(vite.config), 端上直接查表
    return PROVINCE_THEMES[province || ''] || PROVINCE_THEMES['110000'] || THEMES[0];
  }
  if (id === 'term') {
    // 廿四节气主题: 同样构建期算好 24 套色板
    return TERM_THEMES[term || ''] || TERM_THEMES['lichun'] || THEMES[0];
  }
  if (id === 'festival') {
    // 传统节日主题: 构建期算好 23 套(18 日景 + 5 夜场), 缺省回退春节
    return FESTIVAL_THEMES[festival || ''] || FESTIVAL_THEMES['chunjie'] || THEMES[0];
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
  const t = themeOf(s.theme, s.province, s.term, s.festival);
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
  root.style.setProperty('--input-bg', t.bg);
  root.style.setProperty('--input-fg', t.fg);
  root.style.setProperty('--input-border', t.borderStrong);
  // 边框分两支: chromeBorder 只做装饰分割, borderStrong 负责"可识别控件边界"(≥3:1)
  root.style.setProperty('--border-strong', t.borderStrong);
  // 次要文字统一用实色令牌, 不再靠 opacity 叠色(透明度在不同底色上结果不可控, 也无法参与对比度校验)
  root.style.setProperty('--fg-muted', t.muted);
  root.style.setProperty('--danger', t.danger);
  // 危险底色上的文字色与成功状态色: 以前 CSS 里硬编码 #fff / #2ea043,
  // 深色主题上「删除」按钮与「已恢复」提示都读不清（R10/T05）
  root.style.setProperty('--danger-fg', t.dangerFg);
  root.style.setProperty('--success', t.success);
  root.style.setProperty('--shadow-color', t.shadow);
  // 设置面板配色: 全部来自 THEMES 主题变量(调试时改 settings.ts 即可)
  root.style.setProperty('--sp-bg', t.chromeBg);
  root.style.setProperty('--sp-fg', t.fg);
  root.style.setProperty('--sp-border', t.chromeBorder);
  root.style.setProperty('--sp-border-strong', t.borderStrong);
  root.style.setProperty('--sp-muted', t.muted);
  root.style.setProperty('--sp-hover', t.panelHover);
  // 强调色只有一支: 高亮文字 / 按钮底 / 进度条 / 焦点框共用, 不再有 panelAccent
  root.style.setProperty('--sp-accent', t.accent);
  root.style.setProperty('--sp-accent-fg', t.accentFg);
  root.style.setProperty('--sp-control-bg', t.bg);
  // 章节导航按钮(原 --fab-*: 悬浮球已移除, 命名与用途脱节, 一并更正)
  root.style.setProperty('--nav-btn-bg', t.chromeBg);
  root.style.setProperty('--nav-btn-fg', t.accent);
  root.style.setProperty('--nav-btn-border', t.borderStrong);
  // 滚动条: VS Code 注入的滚动条样式用的是 --vscode-scrollbarSlider-*, 需一并映射到主题色
  root.style.setProperty('--vscode-scrollbarSlider-background', t.borderStrong);
  root.style.setProperty('--vscode-scrollbarSlider-hoverBackground', t.accent);
  root.style.setProperty('--vscode-scrollbarSlider-activeBackground', t.accent);
  // 阅读排版
  root.style.setProperty('--font-size', s.fontSize + 'px');
  root.style.setProperty('--font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.system);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--para-spacing', s.paragraphSpacing + 'em');
  // 界面(功能面板)字号: 与上面的 --font-size 完全独立, 两者互不推导（R4-01 边界）。
  // 派生量统一由 uiFontVars 计算, 与 reader.css :root 的静态兜底(14/12/15)同源。
  const ui = uiFontVars(s.uiFontSize);
  root.style.setProperty('--ui-font', ui.main);
  root.style.setProperty('--ui-font-sub', ui.sub);
  root.style.setProperty('--ui-font-title', ui.title);
  applyContentWidth(s);
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
// 注: 文档出现横向滚动条时, fixed bottom:0 的状态栏由浏览器自动落在滚动条上方,
// 无需(也不能)再手动上移让位 —— v1.45.8 之前用 --x-sb 补偿反而多抬一截, 露出正文
window.addEventListener('resize', function () {
  if (!state.settings) { return; }
  if ((Number(state.settings.widthRatio) || 0) > 0) { applyContentWidth(state.settings); }
});

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
  // 主题切换 / 状态栏显隐 / 栏宽档位 / 两侧箭头模式 是离散操作 -> 立即提交, 不吃防抖延迟
  const immediate =
    Object.prototype.hasOwnProperty.call(patch, 'theme') ||
    Object.prototype.hasOwnProperty.call(patch, 'showStatusBar') ||
    Object.prototype.hasOwnProperty.call(patch, 'sideNavMode') ||
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

/**
 * 界面字号步进(与 stepFontSize 完全独立: 绝不触碰 --font-size)。
 * 不进 persistSettings 的 immediate 白名单 —— 与「字号大小」同手感:
 * 界面乐观即时生效, 落盘走 250ms 累积防抖。
 */
export function stepUiFontSize(d: number): void {
  if (!state.settings) { return; }
  const cur = clampUiFont(state.settings.uiFontSize);
  const next = clampUiFont(cur + d * UI_FONT.step);
  if (next !== cur) { persistSettings({ uiFontSize: next }); }
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

/**
 * 临时抑制进度上报(笔记跳转落位期间用):
 * 跳转造成的滚动不是"用户读到这里", 若照常上报会把书架进度写成错误位置。
 */
let suppressedUntil = 0;
export function setProgressSuppressed(on: boolean, ms = 500): void {
  suppressedUntil = on ? Date.now() + Math.max(0, ms) : 0;
}
function progressSuppressed(): boolean {
  return suppressedUntil > 0 && Date.now() < suppressedUntil;
}

// ---------------------------------------------------------------- 笔记卡片: 关闭后吞掉紧随的一次段落点击
// 卡片开着时点其他段落 -> mousedown 先关卡片, 这一次 click 只应"关而不选";
// 用模块级标志让段落 click 忽略一次, document 冒泡 click 里清零(任何点击都会清)
let suppressParaClick = false;
export function setSuppressParaClick(v: boolean): void {
  suppressParaClick = v;
}
export function peekSuppressParaClick(): boolean {
  return suppressParaClick;
}

/** 进度上报(600ms 节流 / immediate 立即) */
let progressTimer: ReturnType<typeof setTimeout> | null = null;
function postProgressNow(): void {
  // 定时器可能晚于抑制窗口结束才触发, 触发点再判一次
  if (!state.chapter || progressSuppressed()) { return; }
  const max = document.body.scrollHeight - window.innerHeight;
  const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  // 同步回state, 供切章时作为章内位置使用
  state.chapter.scrollRatio = ratio;
  send({ type: 'saveProgress', chapterIndex: state.chapter.index, scrollRatio: ratio });
  // 同步写"窗口重开恢复信息"(webview state); 注意这只是辅助来源,
  // 真正可靠的是扩展主进程按saveProgress 写入的书架进度(见 readerPanel.restore)
  if (state.novel && state.novel.filePath) {
    saveRestoreState({ filePath: state.novel.filePath, chapterIndex: state.chapter.index, scrollRatio: ratio });
  }
}

export function sendProgress(immediate: boolean): void {
  if (progressSuppressed()) { return; }
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  if (immediate) {
    postProgressNow();
    return;
  }
  const book = (state.novel && state.novel.filePath) || '';
  progressTimer = setTimeout(function () {
    progressTimer = null;
    // 换书后旧定时器不能把旧坐标写给新书(未走 flush 的路径兜底)
    if (((state.novel && state.novel.filePath) || '') !== book) { return; }
    postProgressNow();
  }, 600);
}

/**
 * 立即落盘当前进度(切书/关面板前调用)。
 * 必须在发送 openBook/previewOnlineBook 之前调用: postMessage 保序,
 * 扩展先收到 saveProgress(此时面板仍指向旧书), 再处理换书。
 */
export function flushProgress(): void {
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  postProgressNow();
}

export type { ChapterPayload, ReadingSettings };
