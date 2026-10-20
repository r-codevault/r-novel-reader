/**
 * webview/reader/composables/vscode.ts — VS Code webview 消息桥
 * 扩展 <-> webview 的 postMessage 协议封装(与扩展侧保持同一协议)
 */
import { reactive } from 'vue';
import type { ReadingSettings } from '../../src/settings';
import type { ShortcutCombo } from './shortcut';

export const vscode = acquireVsCodeApi();

/** 章节载荷(扩展 -> webview) */
export interface ChapterPayload {
  index: number;
  title: string;
  paragraphs: string[];
  totalChapters: number;
  chapterWords: number;
  scrollRatio: number;
}

export interface NovelInfo {
  totalChapters: number;
  totalWords: number;
  bookTitle: string;
  author?: string;
}

/** 书架条目(左抽屉「书架」页) */
export interface ShelfItemView {
  filePath: string;
  title: string;
  author: string;
  chapterIndex: number;
  totalChapters: number;
  current: boolean;
}

/** 左抽屉页签 */
export type DrawerTab = 'shelf' | 'catalog' | 'storage';

/**
 * 写入"窗口重开恢复信息"(VS Code 的 webview state)。
 * VS Code 会在重开窗口时把它作为 deserializeWebviewPanel 的 state 参数回传;
 * 扩展侧据此决定是否恢复阅读页(见 novelReader.restoreOnStartup)。
 */
export function saveRestoreState(s: { filePath: string; chapterIndex: number; scrollRatio: number }): void {
  try {
    vscode.setState(s);
  } catch {
    // 非 webview 环境(单测/浏览器预览)忽略
  }
}

/** 全局共享状态(与扩展侧消息协议字段一一对应) */
export const state = reactive({
  novel: null as NovelInfo | null,
  settings: null as ReadingSettings | null,
  chapter: null as ChapterPayload | null,
  chapters: [] as { index: number; title: string }[],
  shelf: [] as ShelfItemView[],
  libraryPath: '',
  catReverse: false,
  catCollapsed: [] as string[],
  prevCombo: null as ShortcutCombo | null,
  nextCombo: null as ShortcutCombo | null,
  // UI 状态: 侧边菜单(占位式) + 互斥弹窗
  menuExpanded: true,
  catalogOpen: false,
  settingsOpen: false,
  shelfOpen: false,
  storageOpen: false,
});

/** 发消息给扩展(自由格式, 字段与协议一一对应) */
export function send(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

/** 章节跳转请求(dir: 按钮方向; curRatio: 离开时的章内位置, 供扩展记住本章进度) */
export function gotoChapter(index: number, dir?: 'prev' | 'next' | 'jump'): void {
  send({
    type: 'getChapter',
    index,
    dir,
    curRatio: currentScrollRatio(),
  });
}

/** 当前章内滚动位置 0~1(与上报进度同一算法, 章不足一屏时为 0) */
function currentScrollRatio(): number {
  const max = document.body.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}
