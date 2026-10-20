/**
 * webview/reader/composables/catalog.ts — 目录解析(章节号/分卷分组)
 */

export interface CatalogChapter {
  index: number;
  title: string;
}

export interface CatalogGroup {
  name: string;
  entry: number; // 卷标题对应正文章节的 index(-1 表示无)
  items: CatalogChapter[];
}

/** 标题拆成 章节号 + 章节名 */
export function chapterParts(title: string): { no: string; name: string } {
  const m = /^(第[0-9０-９一二三四五六七八九十百千零两]+[章节回卷部篇集])(.*)$/.exec(title.trim());
  if (m) { return { no: m[1], name: m[2].trim() }; }
  const m2 = /^(Chapter\s*\d+)(.*)$/i.exec(title.trim());
  if (m2) { return { no: m2[1], name: m2[2].trim() }; }
  return { no: '', name: title.trim() };
}

/**
 * 卷/部/篇/集 类标题判定(供目录分组与章数统计共用)。
 * 标记需出现在标题前部, 避免正文标题里偶尔提及"第X篇"被误判为分卷。
 */
export function isVolumeTitle(title: string): boolean {
  return /^.{0,10}第[0-9０-９一二三四五六七八九十百千零两]+[卷部篇集]/.test(title);
}

/**
 * 按 卷/部/篇/集 类章节切分目录层级(无此类章节则整体归入"正文")。
 * 卷标题行本身也是正文章节(承载卷首引子), 因此作组名 + 组入口(entry),
 * 但**不作为目录条目渲染、不计入章数** —— 篇名不该被当成一章。
 */
export function buildCatalogGroups(chapters: CatalogChapter[]): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  let cur: CatalogGroup | null = null;
  for (const c of chapters) {
    if (isVolumeTitle(c.title)) {
      if (cur) { groups.push(cur); }
      cur = { name: c.title, entry: c.index, items: [] };
    } else {
      if (!cur) { cur = { name: '正文', entry: -1, items: [] }; }
      cur.items.push(c);
    }
  }
  if (cur) { groups.push(cur); }
  return groups;
}

/** 千分位 */
export function thousand(n: number): string {
  let s = String(n);
  let out = '';
  while (s.length > 3) {
    out = ',' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return s + out;
}
