/**
 * overlay.ts — 浮层焦点栈：打开时聚焦、关闭时归位、互斥切换时交接。
 *
 * 为什么统一放这里：打开/关闭的入口原本分散在 `SideMenu.toggle()`、
 * `App.openTab()`、`App.closeAllPopups()`、各组件内 `state.xxxOpen = false`
 * 与 `init` 的 `openSettings`。焦点逻辑写在组件里必然漏掉某条路径。
 * 现在只有 App 用 `watch` 统一调用本模块，组件不直接调用。
 *
 * 设计约束（PRD R5）：
 *  - **非模态**：不监听 Tab、不设置 inert、不拦截焦点离开 —— 只做"进入/归位"；
 *  - 记录的是"打开那一刻的 activeElement"，所以必须在该次点击的事件序内同步调用
 *    `markOpen()`（App 用 `watch(..., { flush: 'sync' })` 保证这一点）；
 *  - 没有触发元素（外部 openDrawer 协议）时退回 `fallbackSelector`（侧栏菜单项），
 *    再不行退到 `#reader`。
 */

/** 参与焦点栈的浮层（`confirm` 是浮层内的确认层，单独处理） */
export type PopupKey =
  | 'catalogOpen'
  | 'settingsOpen'
  | 'shelfOpen'
  | 'storageOpen'
  | 'notesOpen'
  | 'sourceOpen'
  | 'historyOpen';

export interface OverlaySpec {
  key: PopupKey;
  /** 浮层标题元素的 id（`<h2 id="...">`），打开后优先聚焦它 */
  titleId: string;
  /** 无触发元素时的确定性 fallback 选择器（对应侧栏菜单项） */
  fallbackSelector: string;
}

/** 每个浮层的规格表（App 与组件共用一份，避免 id/选择器写散） */
export const OVERLAY_SPECS: Record<PopupKey, OverlaySpec> = {
  catalogOpen: { key: 'catalogOpen', titleId: 'catalogPanelTitle', fallbackSelector: '[data-menu="catalog"]' },
  settingsOpen: { key: 'settingsOpen', titleId: 'settingsPanelTitle', fallbackSelector: '[data-menu="settings"]' },
  shelfOpen: { key: 'shelfOpen', titleId: 'shelfPopupTitle', fallbackSelector: '[data-menu="shelf"]' },
  storageOpen: { key: 'storageOpen', titleId: 'storagePopupTitle', fallbackSelector: '[data-menu="storage"]' },
  notesOpen: { key: 'notesOpen', titleId: 'notesPopupTitle', fallbackSelector: '[data-menu="notes"]' },
  sourceOpen: { key: 'sourceOpen', titleId: 'sourcePopupTitle', fallbackSelector: '[data-menu="source"]' },
  historyOpen: { key: 'historyOpen', titleId: 'historyPopupTitle', fallbackSelector: '[data-menu="history"]' },
};

/** 打开前的触发元素（只在内存里，不进响应式 state） */
const savedFocus: Partial<Record<PopupKey, HTMLElement | null>> = {};
/** 每个浮层上次聚焦到的元素（互斥切换时只聚焦一次，避免抖动） */
const lastFocused: Partial<Record<PopupKey, HTMLElement | null>> = {};

function activeEl(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) { return null; }
  return el;
}

function isVisible(el: HTMLElement | null): boolean {
  if (!el) { return false; }
  if (!document.body.contains(el)) { return false; }
  // happy-dom / 真实浏览器都能拿到 offsetParent（fixed 元素除外，故再判 rect）
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 || el.offsetParent !== null;
}

/** 打开：保存触发元素。必须在点击的事件序内（同步）调用 */
export function markOpen(spec: OverlaySpec): void {
  savedFocus[spec.key] = activeEl();
  lastFocused[spec.key] = null;
}

/**
 * 打开后一帧：标题 → 关闭按钮 → 首个可聚焦控件。
 * 标题带 `tabindex="-1"`，聚焦它不会把 Tab 序打乱，读屏会念出浮层名字。
 */
export function focusInto(key: PopupKey): void {
  const spec = OVERLAY_SPECS[key];
  const root = document.querySelector('#' + rootIdOf(key)) as HTMLElement | null;
  const title = document.getElementById(spec.titleId);
  if (title && (root ? root.contains(title) : true)) {
    title.focus();
    lastFocused[key] = title;
    return;
  }
  if (!root) { return; }
  const close = root.querySelector('.popup-close, .cat-btn, button') as HTMLElement | null;
  if (close && typeof close.focus === 'function') {
    close.focus();
    lastFocused[key] = close;
    return;
  }
  lastFocused[key] = null;
}

/** popupKey -> 根元素 id（与各组件模板里的 id 对应） */
function rootIdOf(key: PopupKey): string {
  switch (key) {
    case 'catalogOpen': return 'catalogPanel';
    case 'settingsOpen': return 'settingsPanel';
    case 'shelfOpen': return 'shelfPopup';
    case 'storageOpen': return 'storagePopup';
    case 'notesOpen': return 'notesPopup';
    case 'sourceOpen': return 'sourcePopup';
    case 'historyOpen': return 'historyPopup';
    default: return '';
  }
}

/**
 * 关闭：恢复触发元素；不存在/不可见则 fallback（侧栏菜单项）→ `#reader`。
 * 目标一定不是 `body`，否则键盘用户会"掉出页面"（PRD R5-04）。
 */
export function restoreFrom(key: PopupKey): void {
  const spec = OVERLAY_SPECS[key];
  const saved = savedFocus[key];
  savedFocus[key] = undefined;
  lastFocused[key] = null;
  if (saved && isVisible(saved)) {
    saved.focus();
    return;
  }
  const fallback = document.querySelector(spec.fallbackSelector) as HTMLElement | null;
  if (fallback && isVisible(fallback)) {
    fallback.focus();
    return;
  }
  const reader = document.getElementById('reader');
  if (reader && typeof reader.focus === 'function') {
    if (!reader.hasAttribute('tabindex')) { reader.setAttribute('tabindex', '-1'); }
    reader.focus();
  }
}

/**
 * 互斥切换（书架 → 目录）：**不为旧浮层恢复焦点**，只为新浮层聚焦一次。
 * 否则会出现"先回 A 的触发点、再进 B"的焦点抖动。
 */
export function handOff(from: PopupKey[], to: PopupKey): void {
  for (const key of from) {
    savedFocus[key] = undefined;
    lastFocused[key] = null;
  }
  focusInto(to);
}

/** 上一次聚焦到哪个元素（测试与调试用） */
export function focusedOf(key: PopupKey): HTMLElement | null {
  return lastFocused[key] || null;
}
