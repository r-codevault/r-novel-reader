/**
 * notesView.ts — 笔记的分组与展示派生(纯函数, 便于单测)
 *
 * 排序只在这里实现一份:
 *  - 书分组: 最近编辑时间倒序, 同时刻按书名
 *  - 组内: updatedAt 倒序, 同时刻按 createdAt 倒序
 */

import type { NoteGroupOpenMap, NoteItem } from './vscode';

export interface NoteBookGroup {
  bookPath: string;
  bookTitle: string;
  items: NoteItem[];
  /** 书内按章细分(供浮层做二级展开/收起) */
  chapters: NoteChapterGroup[];
  /** 组内最近编辑时间, 用于书分组排序 */
  maxUpdatedAt: number;
  /** 是否为当前正在读的书 */
  current: boolean;
  /** 书已不在书架(分组保留, 但不允许跳转) */
  orphan: boolean;
}

/** 书内的章分组: 展开规则与书分组一致(在读章默认展开, 其它收起) */
export interface NoteChapterGroup {
  chapterTitle: string;
  chapterIndex: number;
  items: NoteItem[];
  maxUpdatedAt: number;
  /** 是否为当前正在阅读的章 */
  current: boolean;
}

/**
 * 按书分组(书内再按章细分)。
 * @param items        全部笔记
 * @param currentBookPath 当前打开的书(可能为空)
 * @param shelfPaths   书架里的书路径集合(判断孤儿分组)
 * @param currentChapterTitle 当前阅读的章标题(判断在读章, 可能变更)
 */
export function groupNotes(
  items: NoteItem[],
  currentBookPath: string,
  shelfPaths: Set<string>,
  currentChapterTitle?: string
): NoteBookGroup[] {
  const map = new Map<string, NoteBookGroup>();

  for (const n of items || []) {
    if (!n || !n.bookPath) { continue; }
    let g = map.get(n.bookPath);
    if (!g) {
      g = {
        bookPath: n.bookPath,
        bookTitle: n.bookTitle || basename(n.bookPath),
        items: [],
        chapters: [],
        maxUpdatedAt: 0,
        current: n.bookPath === currentBookPath,
        orphan: n.bookPath !== currentBookPath && !shelfPaths.has(n.bookPath),
      };
      map.set(n.bookPath, g);
    }
    g.items.push(n);
    g.maxUpdatedAt = Math.max(g.maxUpdatedAt, n.updatedAt || 0);
    // 当前书用最新书名覆盖快照, 改书名后分组标题不会停在旧值
    if (g.current && n.bookTitle) { g.bookTitle = n.bookTitle; }
  }

  const groups = Array.from(map.values());
  for (const g of groups) {
    g.items.sort(function (a, b) {
      const d = (b.updatedAt || 0) - (a.updatedAt || 0);
      return d !== 0 ? d : (b.createdAt || 0) - (a.createdAt || 0);
    });
    g.chapters = groupChapters(g.items, g.current ? currentChapterTitle : '');
  }
  groups.sort(function (a, b) {
    const d = b.maxUpdatedAt - a.maxUpdatedAt;
    if (d !== 0) { return d; }
    return a.bookTitle.localeCompare(b.bookTitle, 'zh-Hans-CN');
  });
  return groups;
}

/** 把一本书的笔记按章细分: 最近编辑倒序, 同时刻按章节序号升序 */
function groupChapters(items: NoteItem[], currentChapterTitle: string): NoteChapterGroup[] {
  const cmap = new Map<string, NoteChapterGroup>();
  for (const n of items) {
    const key = n.chapterTitle || '未命名章节';
    let c = cmap.get(key);
    if (!c) {
      c = { chapterTitle: key, chapterIndex: n.chapterIndex || 0, items: [], maxUpdatedAt: 0, current: false };
      cmap.set(key, c);
    }
    c.items.push(n);
    c.maxUpdatedAt = Math.max(c.maxUpdatedAt, n.updatedAt || 0);
    c.chapterIndex = Math.min(c.chapterIndex, n.chapterIndex || 0);
  }
  const list = Array.from(cmap.values());
  for (const c of list) {
    c.current = !!currentChapterTitle && c.chapterTitle === currentChapterTitle;
    // 组内排序已在 items 上做好, 这里只排章
  }
  list.sort(function (a, b) {
    const d = b.maxUpdatedAt - a.maxUpdatedAt;
    if (d !== 0) { return d; }
    return a.chapterIndex - b.chapterIndex;
  });
  return list;
}

/**
 * 分组是否展开:
 *  - 用户点过组头 → 以 map 里记录的显式选择为准
 *  - 没点过 → 在读的书展开, 其它收起
 */
export function isGroupOpen(map: NoteGroupOpenMap, g: NoteBookGroup): boolean {
  return isOpenByKey(map, g.bookPath, g.current);
}

/** 章分组是否展开: 用户点过以显式选择为准, 否则在读章展开(键含书路径, 避免跨书同章名串扰) */
export function isChapterOpen(map: NoteGroupOpenMap, bookPath: string, c: NoteChapterGroup): boolean {
  return isOpenByKey(map, chapterKey(bookPath, c), c.current);
}

/**
 * 通用展开判断(必须用 in 而不是 hasOwnProperty:
 * in 走 Proxy 的 has 陷阱(Vue 有 instrument, 会 track), hasOwnProperty 走
 * getOwnPropertyDescriptor 陷阱(Vue 未 instrument, 不 track) →
 * 若用 hasOwnProperty, 首次给 map 添加新 key 时渲染 effect 没有依赖, 点击组头不会重渲染)
 */
export function isOpenByKey(map: NoteGroupOpenMap, key: string, def: boolean): boolean {
  if (key in map) {
    return map[key] === true;
  }
  return def;
}

/** 切换分组展开态: 写入的是"取反后的有效值", 不是取反 map 原值 */
export function toggleGroupOpen(map: NoteGroupOpenMap, g: NoteBookGroup): void {
  map[g.bookPath] = !isGroupOpen(map, g);
}

/** 切换章分组展开态(键含书路径, 避免跨书同章名串扰) */
export function toggleChapterOpen(map: NoteGroupOpenMap, bookPath: string, c: NoteChapterGroup): void {
  map[chapterKey(bookPath, c)] = !isChapterOpen(map, bookPath, c);
}

function chapterKey(bookPath: string, c: NoteChapterGroup): string {
  return 'c:' + bookPath + '\u0000' + c.chapterTitle;
}

/** 从路径取文件名(无扩展名), 作为书名为空时的兜底 */
export function basename(p: string): string {
  const s = String(p || '').replace(/^.*[\\/]/, '');
  return s.replace(/\.[^.]+$/, '') || s || '未命名';
}

/** 相对时间: 刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) { return ''; }
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) { return '刚刚'; }
  if (min < 60) { return min + ' 分钟前'; }
  const hour = Math.floor(min / 60);
  if (hour < 24) { return hour + ' 小时前'; }
  const day = Math.floor(hour / 24);
  if (day < 30) { return day + ' 天前'; }
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}
