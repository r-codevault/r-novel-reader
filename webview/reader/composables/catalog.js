/**
 * webview/reader/composables/catalog.js — 目录解析(章节号/分卷分组)
 * 从旧内嵌脚本平移
 */

/** 标题拆成 章节号 + 章节名 */
export function chapterParts(title) {
  var m = /^(第[0-9０-９一二三四五六七八九十百千零两]+[章节回卷部篇集])(.*)$/.exec(title.trim());
  if (m) { return { no: m[1], name: m[2].trim() }; }
  var m2 = /^(Chapter\s*\d+)(.*)$/i.exec(title.trim());
  if (m2) { return { no: m2[1], name: m2[2].trim() }; }
  return { no: '', name: title.trim() };
}

/**
 * 按 卷/部/篇/集 类章节切分目录层级(无此类章节则整体归入"正文")。
 * 卷标题本身也是正文章节, 因此它既作组名, 也作为该组的可点击入口(entry),
 */
export function buildCatalogGroups(chapters) {
  // 卷/部/篇/集 标记需出现在标题前部, 避免正文标题里偶尔提及"第X篇"被误判为分卷
  var isVolume = function (title) {
    return /^.{0,10}第[0-9０-９一二三四五六七八九十百千零两]+[卷部篇集]/.test(title);
  };
  var groups = [];
  var cur = null;
  for (var i = 0; i < chapters.length; i++) {
    var c = chapters[i];
    if (isVolume(c.title)) {
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

/** 千分位(不用正则, 与旧实现一致) */
export function thousand(n) {
  var s = String(n);
  var out = '';
  while (s.length > 3) {
    out = ',' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return s + out;
}
