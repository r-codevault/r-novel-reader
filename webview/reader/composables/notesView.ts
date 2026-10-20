/**
 * notesView.ts — 笔记的分组与展示派生(纯函数, 便于单测)
 *
 * 排序只在这里实现一份:
 *  - 书分组: 最近编辑时间倒序, 同时刻按书名
 *  - 组内: updatedAt 倒序, 同时刻按 createdAt 倒序
 */

import type { NoteItem } from './vscode';

export interface NoteBookGroup {
  bookPath: string;
  bookTitle: string;
  items: NoteItem[];
  /** 组内最近编辑时间, 用于书分组排序 */
  maxUpdatedAt: number;
  /** 是否为当前正在读的书 */
  current: boolean;
  /** 书已不在书架(分组保留, 但不允许跳转) */
  orphan: boolean;
}

/**
 * 按书分组。
 * @param items        全部笔记
 * @param currentBookPath 当前打开的书(可能为空)
 * @param shelfPaths   书架里的书路径集合(判断孤儿分组)
 */
export function groupNotes(
  items: NoteItem[],
  currentBookPath: string,
  shelfPaths: Set<string>
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
  }
  groups.sort(function (a, b) {
    const d = b.maxUpdatedAt - a.maxUpdatedAt;
    if (d !== 0) { return d; }
    return a.bookTitle.localeCompare(b.bookTitle, 'zh-Hans-CN');
  });
  return groups;
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
