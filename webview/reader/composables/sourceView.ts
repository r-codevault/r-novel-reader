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

/**
 * 搜索结果统计文案（纯函数, 可单测）。
 *
 * 四种情况必须分开说, 否则用户看到的永远是"没有找到书籍"——
 * 到底是"真的没有"还是"所有源都挂了", 处理方式完全不同（R9-02）。
 */
export function resultSummary(items: SearchBookItem[], errors: number): string {
  if (!items.length && !errors) {
    return '没有找到这本书：换个关键词，或在「书源」里调整启用范围';
  }
  if (!items.length && errors > 0) {
    return '所有书源都失败了：展开明细查看原因，或对单个书源重试';
  }
  if (items.length && errors > 0) {
    return '找到 ' + items.length + ' 本 · ' + errors + ' 个书源出错';
  }
  return '找到 ' + items.length + ' 本';
}

/**
 * 宿主错误分类(kind) -> 中文类别标签。
 *
 * 宿主的 `errorOf()` 已经给出 kind(searchService/http/evalRule), 这里**只做展示映射**,
 * 不在 webview 重新判断错误类型 —— 分类真相源只能有一个（R9-01）。
 */
export function errorCategory(kind: string | undefined): string {
  switch (kind) {
    case 'timeout': return '超时';
    case 'network': return '网络';
    case 'http': return '状态码';
    case 'parse': return '解析';
    case 'rule': return '规则';
    case 'unsupported': return '不支持';
    case 'abort': return '已取消';
    case 'fatal': return '致命';
    default: return '未知';
  }
}

/** 失败原因精简: 超过 40 字截断(完整原因走 title) */
export function shortReason(message: string): string {
  const text = (message || '').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

/** 失败源名字摘要(最多 3 个) */
export function failedNames(names: string[]): string {
  const list = names.filter(Boolean);
  if (!list.length) { return ''; }
  const head = list.slice(0, 3).join('、');
  return '（' + head + (list.length > 3 ? ' 等' : '') + '）';
}


/** 搜索结果区行数分配: 总容量 10 行, 当前/历史上下分栏, 分隔条高度另算 */
export const RESULT_ROW_CAP = 10;

export interface ResultRows {
  /** 当前结果实际渲染行数 */
  curRender: number;
  /** 历史结果实际渲染行数 */
  histRender: number;
  /** 当前区分到的行数(拖动/自动) */
  curAlloc: number;
  /** 历史区分到的行数 */
  histAlloc: number;
}

/**
 * 搜索结果区行数分配: 当前/历史上下分栏, 分隔条高度另算。
 *
 * @param capacity 结果区实测可容纳的行数（默认取历史常量 RESULT_ROW_CAP）。
 *                 第 5 参新增且带默认值 —— 旧的 4 参调用行为完全不变（R4-04）。
 */
export function allocResultRows(
  currentCount: number,
  historyCount: number,
  hasHistory: boolean,
  dragRows: number | null,
  capacity: number = RESULT_ROW_CAP
): ResultRows {
  const CAP = Math.max(1, Math.round(Number(capacity) || RESULT_ROW_CAP));
  const clamp = function (n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, n));
  };
  if (!hasHistory) {
    const cur = Math.min(currentCount, CAP);
    return { curRender: cur, histRender: 0, curAlloc: cur, histAlloc: 0 };
  }
  if (currentCount === 0 && dragRows === null) {
    const hist = Math.min(historyCount, CAP);
    return { curRender: 0, histRender: hist, curAlloc: 0, histAlloc: hist };
  }
  // 对半分/差额分配都按"实测容量"缩放, 不再写死 5 与 10
  const half = Math.max(1, Math.floor(CAP / 2));
  const small = Math.max(1, Math.ceil(CAP / 2) - 1);
  let cur: number;
  if (dragRows !== null) {
    cur = dragRows;
  } else if (currentCount < small) {
    cur = currentCount;                 // 当前 3 条 -> 3 / 7
  } else if (historyCount < small) {
    cur = CAP - historyCount;           // 历史 3 条 -> 7 / 3
  } else {
    cur = half;                         // 两边都够 -> 5 / 5
  }
  cur = clamp(cur, currentCount > 0 ? 1 : 0, Math.min(currentCount, CAP));
  const histAlloc = Math.max(0, CAP - cur);
  return {
    curRender: Math.min(cur, currentCount),
    histRender: Math.min(histAlloc, historyCount),
    curAlloc: cur,
    histAlloc,
  };
}
