/**
 * notes.ts — 阅读笔记存储
 *
 * 数据保存在 VS Code globalState 的 novelReader.notes 键下:
 *  - 单键全量: { v: 1, items: NoteItem[] }(笔记量级远小于 globalState 承载上限)
 *  - 分组键是 bookPath(写入时由扩展用当前书的实际读取路径盖章), 书名只做展示快照
 *  - 章节锚点用 chapterTitle, chapterIndex 仅作"重解析后标题重名"时的就近提示
 *  - 所有写操作走内部串行队列, 防连续保存时后写覆盖前写
 */

import * as vscode from 'vscode';

export interface NoteItem {
    /** 唯一 id(crypto.randomUUID) */
    id: string;
    /** 所属书籍: 实际读取路径(书库副本优先), 也是分组键 */
    bookPath: string;
    /** 书名快照(书移出书架后仍可显示分组标题) */
    bookTitle: string;
    /** 章节标题: 稳定锚点(文件重新解析后按标题找章) */
    chapterTitle: string;
    /** 写入时的章节序号: 仅作标题重名/缺失时的就近提示 */
    chapterIndex: number;
    /** 写入时的段落序号: 仅作恢复提示 */
    paragraphIndex: number;
    /** 被引用的整段原文(上限 4000 字, 超出截断) */
    quote: string;
    /** 笔记正文(上限 5000 字, trim 后非空) */
    text: string;
    createdAt: number;
    updatedAt: number;
}

/** 新建笔记时 webview 提供的字段(bookPath/bookTitle 由扩展补) */
export interface NoteDraft {
    chapterTitle: string;
    chapterIndex: number;
    paragraphIndex: number;
    quote: string;
    text: string;
}

export interface NoteBookRef {
    bookPath: string;
    bookTitle: string;
}

const NOTES_KEY = 'novelReader.notes';
const MAX_QUOTE = 4000;
const MAX_TEXT = 5000;
/** 用于截断超长引用的省略号 */
const ELLIPSIS = '…';

interface NotesFile {
    v: 1;
    items: NoteItem[];
}

function clip(s: string, max: number): string {
    if (typeof s !== 'string') { return ''; }
    return s.length > max ? s.slice(0, max) + ELLIPSIS : s;
}

function isNote(v: unknown): v is NoteItem {
    if (!v || typeof v !== 'object') { return false; }
    const n = v as Partial<NoteItem>;
    return (
        typeof n.id === 'string' && n.id.length > 0 &&
        typeof n.bookPath === 'string' && n.bookPath.length > 0 &&
        typeof n.chapterTitle === 'string' &&
        typeof n.quote === 'string' &&
        typeof n.text === 'string'
    );
}

function newId(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') { return c.randomUUID(); }
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export class NotesStore {
    /** 写操作串行链: 读-改-写必须原子, 否则连点保存会丢条目 */
    private _chain: Promise<unknown> = Promise.resolve();

    constructor(private readonly state: vscode.Memento) {}

    private _read(): NoteItem[] {
        const raw = this.state.get<NotesFile | undefined>(NOTES_KEY, undefined);
        if (!raw || typeof raw !== 'object') { return []; }
        const doc = raw as Partial<NotesFile>;
        if (doc.v !== 1 || !Array.isArray(doc.items)) { return []; }
        // 坏条目直接丢弃, 不让一条脏数据拖垮整个列表
        return doc.items.filter(isNote).map((n) => ({
            ...n,
            quote: clip(n.quote, MAX_QUOTE),
            text: clip(n.text, MAX_TEXT),
        }));
    }

    private async _write(items: NoteItem[]): Promise<void> {
        await this.state.update(NOTES_KEY, { v: 1, items } as NotesFile);
    }

    /** 串行执行读改写 */
    private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._chain.then(fn, fn);
        // 失败不能污染后续队列
        this._chain = run.catch(() => undefined);
        return run;
    }

    /** 全部笔记(原始顺序, 排序由 webview 负责以保证只实现一份) */
    list(): NoteItem[] {
        return this._read();
    }

    listFor(bookPath: string): NoteItem[] {
        return this._read().filter((n) => n.bookPath === bookPath);
    }

    countFor(bookPath: string): number {
        return this.listFor(bookPath).length;
    }

    async add(draft: NoteDraft, book: NoteBookRef): Promise<NoteItem> {
        const text = typeof draft.text === 'string' ? draft.text.trim() : '';
        if (!text) { throw new Error('笔记内容不能为空'); }
        return this._enqueue(async () => {
            const now = Date.now();
            const item: NoteItem = {
                id: newId(),
                bookPath: book.bookPath,
                bookTitle: book.bookTitle || '',
                chapterTitle: draft.chapterTitle || '',
                chapterIndex: Number.isFinite(draft.chapterIndex) ? draft.chapterIndex : 0,
                paragraphIndex: Number.isFinite(draft.paragraphIndex) ? draft.paragraphIndex : 0,
                quote: clip(draft.quote || '', MAX_QUOTE),
                text: clip(text, MAX_TEXT),
                createdAt: now,
                updatedAt: now,
            };
            const items = this._read();
            items.push(item);
            await this._write(items);
            return item;
        });
    }

    async update(id: string, text: string): Promise<NoteItem | undefined> {
        const next = typeof text === 'string' ? text.trim() : '';
        if (!next) { throw new Error('笔记内容不能为空'); }
        return this._enqueue(async () => {
            const items = this._read();
            const item = items.find((n) => n.id === id);
            if (!item) { return undefined; }
            item.text = clip(next, MAX_TEXT);
            item.updatedAt = Date.now();
            await this._write(items);
            return item;
        });
    }

    async remove(id: string): Promise<boolean> {
        return this._enqueue(async () => {
            const items = this._read();
            const next = items.filter((n) => n.id !== id);
            if (next.length === items.length) { return false; }
            await this._write(next);
            return true;
        });
    }

    /** 清空某本书的笔记(本期不主动调用, 预留给"清空本书笔记") */
    async removeByBook(bookPath: string): Promise<number> {
        return this._enqueue(async () => {
            const items = this._read();
            const next = items.filter((n) => n.bookPath !== bookPath);
            const removed = items.length - next.length;
            if (removed > 0) { await this._write(next); }
            return removed;
        });
    }

    /** 文件路径变化(导入到书库/重新选择文件)时迁移分组键 */
    async relink(oldPath: string, newPath: string, bookTitle?: string): Promise<number> {
        if (!oldPath || !newPath || oldPath === newPath) { return 0; }
        return this._enqueue(async () => {
            const items = this._read();
            let moved = 0;
            for (const n of items) {
                if (n.bookPath !== oldPath) { continue; }
                n.bookPath = newPath;
                if (bookTitle) { n.bookTitle = bookTitle; }
                moved++;
            }
            if (moved > 0) { await this._write(items); }
            return moved;
        });
    }
}
