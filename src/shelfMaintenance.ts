/**
 * shelfMaintenance.ts — 书架维护的纯逻辑(无 vscode 依赖, 便于单测)
 *
 * 用途:
 *  - 同书去重: 多份副本(导入时生成的 "名称 (n).txt")或"老路径 + 书库路径"并存时,
 *    只保留一条记录(优先 书库内 && 文件存在 && 已读)
 *  - 刷新书架时判断: 某个待补录的书籍是否与书架已有条目同书
 */

export interface ShelfBookLike {
    filePath: string;
    title: string;
    author: string;
    totalChapters: number;
    chapterIndex: number;
    addedAt?: number;
}

/** 同书判定键: 书名 + 作者 + 总章节数 */
export function shelfBookKey(
    title: string | undefined,
    author: string | undefined,
    totalChapters: number | undefined
): string {
    return `${(title || '').trim()}|${(author || '').trim()}|${totalChapters || 0}`;
}

/**
 * 计划: 哪些重复记录应该被移除(只删记录, 不动文件)。
 * @param books       全部书架条目
 * @param libraryPath 书库目录(空表示未设置)
 * @param fileExists  文件是否存在(注入以便测试)
 * @param dirCheck    是否位于书库目录内(注入以便测试)
 */
export function planDuplicateRemoval(
    books: ShelfBookLike[],
    libraryPath: string,
    fileExists: (p: string) => boolean,
    dirCheck: (p: string, dir: string) => boolean
): { key: string; keep: ShelfBookLike; removals: ShelfBookLike[] }[] {
    const groups = new Map<string, ShelfBookLike[]>();
    for (const b of books) {
        const key = shelfBookKey(b.title, b.author, b.totalChapters);
        const list = groups.get(key);
        if (list) {
            list.push(b);
        } else {
            groups.set(key, [b]);
        }
    }

    /** 优先级打分: 书库内且文件存在 > 文件存在 > 其它; 同分时已读优先, 再按加入时间 */
    const score = (b: ShelfBookLike): number[] => [
        libraryPath && dirCheck(b.filePath, libraryPath) && fileExists(b.filePath) ? 2 : fileExists(b.filePath) ? 1 : 0,
        b.chapterIndex >= 0 ? 1 : 0,
        -(b.addedAt || 0),
    ];
    const better = (a: ShelfBookLike, b: ShelfBookLike): boolean => {
        const sa = score(a);
        const sb = score(b);
        for (let i = 0; i < sa.length; i++) {
            if (sa[i] !== sb[i]) {
                return sa[i] > sb[i];
            }
        }
        return false;
    };

    const plans: { key: string; keep: ShelfBookLike; removals: ShelfBookLike[] }[] = [];
    for (const [key, list] of groups) {
        if (list.length <= 1) {
            continue;
        }
        let keep = list[0];
        for (const b of list.slice(1)) {
            if (better(b, keep)) {
                keep = b;
            }
        }
        plans.push({ key, keep, removals: list.filter((b) => b !== keep) });
    }
    return plans;
}
