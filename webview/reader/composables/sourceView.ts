/**
 * sourceView.ts — 书源面板的纯函数派生(便于单测与复用)
 */
import type { BookSourceView, SearchBookItem } from './vscode';

/** 已启用书源 */
export function enabledSources(sources: BookSourceView[]): BookSourceView[] {
  return sources.filter(function (s) { return s.enabled; });
}

/** 管理页搜索: 匹配名称/分组/地址(忽略大小写与空白) */
export function filterSources(sources: BookSourceView[], keyword: string): BookSourceView[] {
  const k = (keyword || '').replace(/\s+/g, '').toLowerCase();
  if (!k) { return sources; }
  return sources.filter(function (s) {
    const hay = (s.name + '|' + s.group + '|' + s.url).replace(/\s+/g, '').toLowerCase();
    return hay.indexOf(k) >= 0;
  });
}

export type CheckStatus = 'ok' | 'bad' | 'unknown';

export function checkStatus(s: BookSourceView): CheckStatus {
  if (s.lastCheckOk === true) { return 'ok'; }
  if (s.lastCheckOk === false) { return 'bad'; }
  return 'unknown';
}

export function statusText(s: BookSourceView): string {
  const status = checkStatus(s);
  if (status === 'ok') { return '可用'; }
  if (status === 'bad') { return '不可用'; }
  return '未检查';
}

/** 结果行右侧的书源标签 */
export function sourceLabel(item: SearchBookItem): string {
  return item.sourceName || '未知书源';
}

/** 字数展示: 10000 以上折算为万字 */
export function formatWordCount(n: number | undefined): string {
  if (!n || n <= 0) { return ''; }
  if (n >= 10000) {
    const w = n / 10000;
    return (w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')) + ' 万字';
  }
  return n + ' 字';
}

/** 结果行的次要信息拼装(空值自动省略) */
export function resultMeta(item: SearchBookItem): string {
  const parts: string[] = [];
  if (item.author) { parts.push(item.author); }
  if (item.kind) { parts.push(item.kind); }
  const words = formatWordCount(item.wordCount);
  if (words) { parts.push(words); }
  if (item.lastChapter) { parts.push('最新: ' + item.lastChapter); }
  return parts.join(' · ');
}

/** 搜索结果统计文案 */
export function resultSummary(items: SearchBookItem[], errors: number): string {
  const parts: string[] = [];
  parts.push(items.length ? '找到 ' + items.length + ' 本' : '没有找到书籍');
  if (errors > 0) { parts.push(errors + ' 个书源出错'); }
  return parts.join(' · ');
}

/** 选中书源的展示文案 */
export function selectedSourcesText(selected: string[], sources: BookSourceView[]): string {
  if (!selected.length) {
    const total = enabledSources(sources).length;
    return total ? '全部已启用书源（' + total + ' 个）' : '全部已启用书源';
  }
  if (selected.length === 1) {
    const hit = sources.find(function (s) { return s.id === selected[0]; });
    return hit ? hit.name : '1 个书源';
  }
  return selected.length + ' 个书源';
}

/** 切换某个书源的选中态(空数组代表"全部", 选中具体源后从全集中收敛) */
export function toggleSourceSelection(selected: string[], id: string): string[] {
  if (selected.indexOf(id) >= 0) {
    return selected.filter(function (x) { return x !== id; });
  }
  return selected.concat([id]);
}
