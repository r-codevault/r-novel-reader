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

/** 全局共享状态(与扩展侧消息协议字段一一对应) */
export const state = reactive({
  novel: null as NovelInfo | null,
  settings: null as ReadingSettings | null,
  chapter: null as ChapterPayload | null,
  chapters: [] as { index: number; title: string }[],
  shelf: [] as ShelfItemView[],
  libraryPath: '',
  /** 自定义图片主题的背景图 URI(由扩展下发; 非自定义主题为空) */
  customBgUri: '',
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

/** 章节跳转请求 */
export function gotoChapter(index: number): void {
  send({ type: 'getChapter', index });
}
