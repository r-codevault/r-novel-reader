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
  /** 实际读取路径(笔记分组键与"当前书"判定都用它) */
  filePath?: string;
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

/** 阅读笔记(与扩展端 NoteItem 一一对应) */
export interface NoteItem {
  id: string;
  bookPath: string;
  bookTitle: string;
  chapterTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  quote: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建笔记卡片的状态(仅内存, 取消即丢弃) */
export interface NoteComposerState {
  /** composing=编辑(新建/编辑) viewing=只读查看(点「编辑」进入编辑) saving=保存中 */
  phase: 'composing' | 'saving' | 'viewing';
  chapterTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  quote: string;
  text: string;
  /** 带入的已有笔记 id: 有值时保存走 updateNote(编辑), 无值走 addNote(新建) */
  editId?: string;
  /** 段落锚点(视口坐标), 卡片据此定位 */
  anchorTop: number;
  anchorBottom: number;
  anchorLeft: number;
  error?: string;
}

/** 跳转前的阅读位置(供「返回阅读位置」用) */
export interface NoteReturnPos {
  chapterIndex: number;
  scrollRatio: number;
  chapterTitle: string;
}

/** 待落位的笔记跳转(跨章时等 chapter 到达) */
export interface NoteJumpTarget {
  id: string;
  chapterTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  quote: string;
}

/** 笔记分组展开态: 只记录用户显式选择(bookPath -> 是否展开), 缺省值由"是否在读"推导 */
export type NoteGroupOpenMap = Record<string, boolean>;

/** 左抽屉页签 */
export type DrawerTab = 'shelf' | 'catalog' | 'notes' | 'storage' | 'source';

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

/** 书源(扩展下发的精简视图, 不含规则体) */
export interface BookSourceView {
  id: string;
  name: string;
  url: string;
  group: string;
  enabled: boolean;
  searchUrl: string;
  lastCheck?: number;
  lastCheckOk?: boolean;
  lastCheckMessage?: string;
  /** 连续失败次数(检查/搜索), 成功清零 */
  failStreak: number;
  /** >0 = 失效(不参与搜索, 只在「失效」Tab 出现) */
  deadAt?: number;
  deadReason?: string;
}

/** 搜索结果条目 */
export interface SearchBookItem {
  sourceId: string;
  sourceName: string;
  title: string;
  author: string;
  bookUrl: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  wordCount?: number;
}

/** 单源搜索错误 */
export interface SourceSearchError {
  sourceId: string;
  sourceName: string;
  kind: string;
  message: string;
}

/** 全局共享状态(与扩展侧消息协议字段一一对应) */
export const state = reactive({
  novel: null as NovelInfo | null,
  settings: null as ReadingSettings | null,
  chapter: null as ChapterPayload | null,
  chapters: [] as { index: number; title: string }[],
  shelf: [] as ShelfItemView[],
  libraryPath: '',
  /** 全部笔记(按书分组在 webview 完成) */
  notes: [] as NoteItem[],
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
  notesOpen: false,
  /** 笔记分组展开态(仅内存, 只记用户显式操作过的书) */
  noteGroupOpen: {} as NoteGroupOpenMap,
  /** 章分组展开态(键含书路径; 换书/重发 init 不清空, 与书折叠态同策略) */
  noteChapterOpen: {} as NoteGroupOpenMap,
  /** 新建笔记卡片 */
  noteComposer: null as NoteComposerState | null,
  /** 跳转前位置 */
  noteReturn: null as NoteReturnPos | null,
  /** 待落位跳转 */
  noteJump: null as NoteJumpTarget | null,
  /** 摸鱼会话开启中(侧边栏「摸鱼模式」高亮) */
  slackerActive: false,
  /** 跨书跳转: 待目标书 init 落地后再按笔记定位 */
  pendingNoteJump: null as NoteItem | null,
  // ---- 网络书源
  sourceOpen: false,
  /** 书源弹窗内的视图: 搜索 / 书源管理 / 失效书源 */
  sourceView: 'search' as 'search' | 'manage' | 'dead',
  sources: [] as BookSourceView[],
  searchKeyword: '',
  searching: false,
  /** 搜索序号: 扩展回包时比对, 丢弃过期结果 */
  searchToken: 0,
  searchResults: [] as SearchBookItem[],
  searchErrors: [] as SourceSearchError[],
  searchDone: false,
  /** 本次因源上限(100)未参与搜索的书源数 */
  searchSkipped: 0,
  /** 本次搜索新移入失效的书源数 */
  searchDeadAdded: 0,
  /** 书源管理: 正在编辑的 sourceId(空 = 无) */
  sourceEditingId: '',
});

/** 发消息给扩展(自由格式, 字段与协议一一对应) */
export function send(msg: Record<string, unknown>): void {
  vscode.postMessage(msg);
}

/** 章节跳转请求(dir: 按钮方向; curRatio: 离开时的章内位置, 供扩展记住本章进度) */
export function gotoChapter(index: number, dir?: 'prev' | 'next' | 'jump', exactRatio?: number): void {
  send({
    type: 'getChapter',
    index,
    dir,
    curRatio: currentScrollRatio(),
    // 笔记「返回阅读位置」要求精确落点, 优先于扩展侧的记忆比例
    exactRatio: typeof exactRatio === 'number' ? exactRatio : undefined,
  });
}

/** 打开笔记浮层(与其它抽屉互斥由 App 统一处理) */
export function openNotes(): void {
  send({ type: 'requestNotes' });
  state.notesOpen = true;
}

/** 当前章内滚动位置 0~1(与上报进度同一算法, 章不足一屏时为 0) */
export function currentScrollRatio(): number {
  const max = document.body.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}
