/**
 * noteAnchor.ts — 笔记锚点解析(纯函数, 扩展与 webview 共用)
 *
 * 笔记的稳定锚点是「章节标题 + 原文段落」, 章节序号/段落序号只作就近提示:
 *  - 文件重新导出、合并章节后 chapterIndex 会漂移, 标题通常不变
 *  - 段落被插入/删除后 paragraphIndex 会偏, 但整段文字通常还在
 */

import type { NoteItem } from './notes';

/** 标题归一化: 去首尾空白、全角空格转半角、连续空白压成一个 */
export function normalizeTitle(t: string): string {
    return (t || '')
        .replace(/\u3000/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function clamp(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) { return min; }
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 解析笔记应落在哪一章:
 *  1. 标题全等(多条时取与 chapterIndex 最近的一条)
 *  2. 标题包含匹配(同上取最近)
 *  3. 兜底: clamp(chapterIndex)
 */
export function resolveChapterIndex(
    chapters: { index: number; title: string }[],
    note: Pick<NoteItem, 'chapterTitle' | 'chapterIndex'>
): number {
    if (!chapters || chapters.length === 0) { return 0; }
    const target = normalizeTitle(note.chapterTitle);

    if (target) {
        const exact = chapters.filter((c) => normalizeTitle(c.title) === target);
        if (exact.length === 1) { return exact[0].index; }
        if (exact.length > 1) { return nearest(exact, note.chapterIndex); }

        const loose = chapters.filter((c) => normalizeTitle(c.title).indexOf(target) >= 0);
        if (loose.length > 0) { return nearest(loose, note.chapterIndex); }
    }
    return clamp(note.chapterIndex, 0, chapters.length - 1);
}

function nearest(list: { index: number }[], hint: number): number {
    let best = list[0].index;
    let bestDiff = Math.abs(best - hint);
    for (const c of list) {
        const d = Math.abs(c.index - hint);
        if (d < bestDiff) { best = c.index; bestDiff = d; }
    }
    return best;
}

/**
 * 解析笔记应落在哪一段:
 *  1. hint±40 段内全等
 *  2. 全章全等
 *  3. 全章按引文前 16 字前缀匹配
 *  4. 兜底 clamp(hint), exact=false
 */
export function findParagraph(
    paragraphs: string[],
    hint: number,
    quote: string
): { index: number; exact: boolean } {
    const list = paragraphs || [];
    if (list.length === 0) { return { index: 0, exact: false }; }
    const start = clamp(hint, 0, list.length - 1);
    const target = (quote || '').trim();

    if (target) {
        const from = Math.max(0, start - 40);
        const to = Math.min(list.length - 1, start + 40);
        for (let i = from; i <= to; i++) {
            if ((list[i] || '').trim() === target) { return { index: i, exact: true }; }
        }
        for (let i = 0; i < list.length; i++) {
            if ((list[i] || '').trim() === target) { return { index: i, exact: true }; }
        }
        const prefix = target.slice(0, 16);
        if (prefix) {
            for (let i = 0; i < list.length; i++) {
                if ((list[i] || '').trim().indexOf(prefix) >= 0) { return { index: i, exact: false }; }
            }
        }
    }
    return { index: start, exact: false };
}
