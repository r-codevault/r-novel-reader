/**
 * sourceView.ts — 书源面板的纯函数派生(便于单测与复用)
 */
import type { BookSourceView, SearchBookItem } from './vscode';

/** 是否已失效(deadAt 是唯一事实源) */
export function isDead(s: { deadAt?: number }): boolean {
  return typeof s.deadAt === 'number' && (s.deadAt as number) > 0;
}

/** 未失效的书源(「书源」Tab 列表用) */
export function aliveSources(sources: BookSourceView[]): BookSourceView[] {
  return sources.filter(function (s) { return !isDead(s); });
}

/** 已启用且未失效(参与搜索) */
export function searchableSources(sources: BookSourceView[]): BookSourceView[] {
  return sources.filter(function (s) { return s.enabled && !isDead(s); });
}

/** 失效书源 */
export function deadSources(sources: BookSourceView[]): BookSourceView[] {
  return sources.filter(isDead);
}

/** 已启用书源(含失效, 仅用于统计展示) */
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

export type CheckStatus = 'ok' | 'bad' | 'dead' | 'unknown';

export function checkStatus(s: BookSourceView): CheckStatus {
  if (isDead(s)) { return 'dead'; }
  if (s.lastCheckOk === true) { return 'ok'; }
  if (s.lastCheckOk === false) { return 'bad'; }
  return 'unknown';
}

export function statusText(s: BookSourceView): string {
  const status = checkStatus(s);
  if (status === 'dead') { return '失效'; }
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

/** 失败源名字摘要(最多 3 个) */
export function failedNames(names: string[]): string {
  const list = names.filter(Boolean);
  if (!list.length) { return ''; }
  const head = list.slice(0, 3).join('、');
  return '（' + head + (list.length > 3 ? ' 等' : '') + '）';
}
