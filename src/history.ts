/**
 * history.ts — 阅读历史(本地 / 在线分开保存)
 *
 * 存储在 VS Code globalState `novelReader.history`:
 *  - local / online 两个数组, 各最多 1000 本
 *  - 同一本书按 filePath 去重, 再次阅读移到最前
 *  - 写盘做 1.2s 防抖, 避免滚动进度每 600ms 就写一次
 */

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
