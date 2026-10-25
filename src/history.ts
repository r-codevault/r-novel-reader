/**
 * history.ts — 阅读历史(本地 / 在线分开保存)
 *
 * 存储在 VS Code globalState `novelReader.history`:
 *  - local / online 两个数组, 各最多 1000 本
 *  - 同一本书按 filePath 去重, 再次阅读移到最前
 *  - 写盘做 1.2s 防抖, 避免滚动进度每 600ms 就写一次
 */

import * as path from 'path';
import * as vscode from 'vscode';

export type HistoryKind = 'local' | 'online';

export interface HistoryEntry {
    kind: HistoryKind;
    /** 本地绝对路径 / online:// 伪路径 */
    filePath: string;
    title: string;
    author: string;
    /** 最后阅读章节(0 起始) */
    chapterIndex: number;
    totalChapters: number;
    lastReadAt: number;
    /** 在线书元信息 */
    sourceId?: string;
    sourceName?: string;
    bookUrl?: string;
}

export interface HistoryPayload {
    local: HistoryEntry[];
    online: HistoryEntry[];
}

const HISTORY_KEY = 'novelReader.history';
export const HISTORY_MAX_PER_KIND = 1000;

interface StoredHistory {
    v: 1;
    local: HistoryEntry[];
    online: HistoryEntry[];
}

function normalize(e: HistoryEntry): HistoryEntry {
    const kind: HistoryKind = e.kind === 'online' ? 'online' : 'local';
    const chapter = Number.isFinite(e.chapterIndex) ? Math.max(0, Math.floor(e.chapterIndex)) : 0;
    return {
        kind,
        filePath: String(e.filePath || ''),
        title: String(e.title || ''),
        author: String(e.author || ''),
        chapterIndex: chapter,
        totalChapters: Number.isFinite(e.totalChapters) ? Math.max(0, Math.floor(e.totalChapters)) : 0,
        lastReadAt: Number.isFinite(e.lastReadAt) ? e.lastReadAt : Date.now(),
        ...(kind === 'online'
            ? {
                sourceId: e.sourceId ? String(e.sourceId) : undefined,
                sourceName: e.sourceName ? String(e.sourceName) : undefined,
                bookUrl: e.bookUrl ? String(e.bookUrl) : undefined,
            }
            : {}),
    };
}

/** 组装"打开一本书"的历史条目所需的最小信息(结构类型, 避免与 novelParser 互相依赖) */
export interface OpenNovelInfo {
    filePath: string;
    bookTitle?: string;
    author?: string;
    chapters?: readonly unknown[];
    online?: { sourceId?: string; sourceName?: string; bookUrl?: string };
}

/** 书架记录里用得到的字段(HistoryEntry 的元信息优先取它, 书名可能被用户改过) */
export interface ShelfEntryInfo {
    title?: string;
    author?: string;
    totalChapters?: number;
    online?: { sourceId?: string; sourceName?: string; bookUrl?: string };
}

/**
 * 构造"打开即记"的历史条目。
 *
 * 刻意**不查书架是否存在** —— 从书源搜出来、还没加入书架的预览书也要进历史
 * (否则用户刚看过的书在历史里根本找不到)。书架门禁原本是历史为空的主因。
 */
export function buildOpenEntry(
    novel: OpenNovelInfo | null | undefined,
    shelfEntry: ShelfEntryInfo | undefined,
    chapterIndex: number,
    totalOverride?: number
): HistoryEntry | null {
    const filePath = String((novel && novel.filePath) || '');
    if (!filePath) { return null; }   // 空态占位书(filePath 为空)不记

    const onlineRef = (shelfEntry && shelfEntry.online) || (novel && novel.online);
    const kind: HistoryKind = filePath.startsWith('online://') || !!onlineRef ? 'online' : 'local';

    const shelfTotal = shelfEntry && Number.isFinite(shelfEntry.totalChapters)
        ? Number(shelfEntry.totalChapters)
        : 0;
    const novelTotal = novel && Array.isArray(novel.chapters) ? novel.chapters.length : 0;
    const total = typeof totalOverride === 'number' && Number.isFinite(totalOverride)
        ? totalOverride
        : shelfTotal || novelTotal;

    const title = ((shelfEntry && shelfEntry.title) || '')
        || (novel && novel.bookTitle)
        || (kind === 'local' ? path.basename(filePath) : '');
    const author = ((shelfEntry && shelfEntry.author) || '') || (novel && novel.author) || '';

    return {
        kind,
        filePath,
        title,
        author,
        chapterIndex: Number.isFinite(chapterIndex) ? Math.max(0, Math.floor(chapterIndex)) : 0,
        totalChapters: total,
        lastReadAt: Date.now(),
        ...(kind === 'online'
            ? {
                sourceId: onlineRef?.sourceId,
                sourceName: onlineRef?.sourceName,
                bookUrl: onlineRef?.bookUrl,
            }
            : {}),
    };
}

export class HistoryStore {
    private local: HistoryEntry[] = [];
    private online: HistoryEntry[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private dirty = false;

    constructor(private readonly state: vscode.Memento) {}

    load(): void {
        const raw = this.state.get<StoredHistory>(HISTORY_KEY, { v: 1, local: [], online: [] });
        this.local = Array.isArray(raw.local) ? raw.local.filter((e) => e && e.filePath).map(normalize).slice(0, HISTORY_MAX_PER_KIND) : [];
        this.online = Array.isArray(raw.online) ? raw.online.filter((e) => e && e.filePath).map(normalize).slice(0, HISTORY_MAX_PER_KIND) : [];
    }

    /** 按 filePath 查一条(本地/在线都查): 给"从历史打开已下架在线书"兜底用 */
    find(filePath: string): HistoryEntry | undefined {
        if (!filePath) { return undefined; }
        return this.online.find((e) => e.filePath === filePath)
            || this.local.find((e) => e.filePath === filePath);
    }

    /**
     * 只推进度: 章节没变直接返回 false —— 不写盘、不动 lastReadAt、不重排,
     * 这样章内滚动(600ms 上报一次)不会让历史列表一直跳动。
     */
    updateProgress(filePath: string, chapterIndex: number): boolean {
        if (!filePath) { return false; }
        const arr = this.online.some((e) => e.filePath === filePath) ? this.online
            : this.local.some((e) => e.filePath === filePath) ? this.local
                : null;
        if (!arr) { return false; }
        const at = arr.findIndex((e) => e.filePath === filePath);
        const cur = arr[at];
        const chapter = Number.isFinite(chapterIndex) ? Math.max(0, Math.floor(chapterIndex)) : 0;
        if (cur.chapterIndex === chapter) { return false; }
        cur.chapterIndex = chapter;
        cur.lastReadAt = Date.now();
        arr.splice(at, 1);
        arr.unshift(cur);
        this.dirty = true;
        this.schedule();
        return true;
    }

    list(): HistoryPayload {
        return { local: this.local.slice(), online: this.online.slice() };
    }

    /** 记录/更新一本; 同一 filePath 去重并移到最前 */
    record(entry: HistoryEntry): void {
        if (!entry || !entry.filePath) { return; }
        const e = normalize({ ...entry, lastReadAt: entry.lastReadAt || Date.now() });
        const arr = e.kind === 'online' ? this.online : this.local;
        const at = arr.findIndex((x) => x.filePath === e.filePath);
        if (at >= 0) { arr.splice(at, 1); }
        arr.unshift(e);
        if (arr.length > HISTORY_MAX_PER_KIND) { arr.length = HISTORY_MAX_PER_KIND; }
        this.dirty = true;
        this.schedule();
    }

    /**
     * 批量删除(按 filePath, 本地/在线两栏一起查)。
     * @returns 实际删除条数
     */
    removeMany(filePaths: string[]): number {
        const set = new Set((filePaths || []).filter((p) => typeof p === 'string' && !!p));
        if (!set.size) { return 0; }
        let removed = 0;
        for (const arr of [this.local, this.online]) {
            const before = arr.length;
            const kept = arr.filter((e) => !set.has(e.filePath));
            if (kept.length === before) { continue; }
            arr.length = 0;
            for (const e of kept) { arr.push(e); }
            removed += before - kept.length;
        }
        if (removed) {
            this.dirty = true;
            this.schedule();
        }
        return removed;
    }

    /** 清空某一栏; @returns 删除条数 */
    clearKind(kind: HistoryKind): number {
        const arr = kind === 'online' ? this.online : this.local;
        const n = arr.length;
        if (!n) { return 0; }
        arr.length = 0;
        this.dirty = true;
        this.schedule();
        return n;
    }

    /** 立即落盘(退出/测试用) */
    async flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (!this.dirty) { return; }
        this.dirty = false;
        await this.state.update(HISTORY_KEY, { v: 1, local: this.local, online: this.online });
    }

    private schedule(): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, 1200);
    }
}
