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
