/**
 * webview/sidebar/store.ts — 侧边栏全局状态 + 消息协议
 */
import { reactive } from 'vue';

export type ViewMode = 'shelf' | 'chapters' | 'settings';

export interface ShelfItemView {
  filePath: string;
  title: string;
  author: string;
  /** 最后阅读章节序号, -1 表示未开始 */
  chapterIndex: number;
  totalChapters: number;
  current: boolean;
}

export interface NovelPayload {
  hasNovel: boolean;
  bookTitle: string;
  chapters: { index: number; title: string }[];
  currentIndex: number;
}

export const vscode = acquireVsCodeApi();

export const state = reactive({
  mode: 'chapters' as ViewMode,
  shelf: [] as ShelfItemView[],
  libraryPath: '',
  themeId: 'white',
  hasNovel: false,
  bookTitle: '',
  chapters: [] as { index: number; title: string }[],
  currentIndex: -1,
});

export function send(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

/** 章节列表重渲染的依据(换书才重建列表, 保持与旧实现一致) */
export function novelKey(): string {
  return state.bookTitle + '|' + state.chapters.length;
}

interface ThemeDef {
  id: string; name: string; bg: string; fg: string; pageBg: string;
  chromeBg: string; chromeBorder: string; accent: string; accentFg: string;
  muted: string; panelAccent: string; panelHover: string;
}

/** 构建期由 vite define 注入(单一来源 src/settings.ts) */
export const THEMES: ThemeDef[] = __THEMES__;

function themeOf(id: string): ThemeDef {
  for (const t of THEMES) { if (t.id === id) { return t; } }
  return THEMES[0];
}

/**
 * 侧边栏同步阅读主题: 把主题色映射到 --vscode-* 变量,
 * 侧边栏所有样式(list/hover/按钮/边框)即整体跟随, 无需改各处 CSS。
 */
export function applySidebarTheme(themeId: string): void {
  const t = themeOf(themeId);
  state.themeId = t.id;
  const root = document.documentElement;
  root.style.setProperty('--vscode-sideBar-background', t.chromeBg);
  root.style.setProperty('--vscode-editor-background', t.pageBg);
  root.style.setProperty('--vscode-foreground', t.fg);
  root.style.setProperty('--vscode-widget-border', t.chromeBorder);
  root.style.setProperty('--vscode-input-background', t.bg);
  root.style.setProperty('--vscode-list-hoverBackground', t.panelHover);
  root.style.setProperty('--vscode-list-inactiveSelectionBackground', t.bg);
  root.style.setProperty('--vscode-button-background', t.accent);
  root.style.setProperty('--vscode-button-foreground', t.accentFg);
  root.style.setProperty('--vscode-button-hoverBackground', t.accent);
  root.style.setProperty('--vscode-button-secondaryBackground', t.bg);
  root.style.setProperty('--vscode-button-secondaryForeground', t.fg);
  root.style.setProperty('--vscode-button-secondaryHoverBackground', t.panelHover);
  root.style.setProperty('--vscode-toolbar-hoverBackground', t.panelHover);
  root.style.setProperty('--vscode-charts-green', t.accent);
  root.style.setProperty('--vscode-focusBorder', t.accent);
  // 滚动条跟随主题(VS Code 注入的滚动条样式用这几个变量)
  root.style.setProperty('--vscode-scrollbarSlider-background', t.chromeBorder);
  root.style.setProperty('--vscode-scrollbarSlider-hoverBackground', t.accent);
  root.style.setProperty('--vscode-scrollbarSlider-activeBackground', t.accent);
}
