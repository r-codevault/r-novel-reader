/**
 * shelf.ts — 我的书架(多本小说管理)
 *
 * 数据保存在 VS Code globalState 的 novelReader.shelf 键下:
 *  - 每本书记录 文件路径 / 书名 / 作者 / 总章数 / 最后阅读章节 / 章内滚动位置
 *  - "上一次阅读的书" = updatedAt 最大的一本, 用于启动时自动延续阅读状态
 *  - 兼容旧版: 首次运行会把 novelReader.session 迁移成一条书架记录
 */

import * as vscode from 'vscode';

export interface ShelfBook {
    /** 小说文件绝对路径(唯一键) */
    filePath: string;
    title: string;
    author: string;
    totalChapters: number;
    /** 最后阅读到的章节序号(0 起始, -1 表示未开始) */
    chapterIndex: number;
    /** 章内滚动位置 0~1 */
    scrollRatio: number;
    /** 各章节内滚动位置记忆(章节序号 -> 0~1), 目录切走再切回时恢复原位置 */
    chapterRatios?: Record<number, number>;
    addedAt: number;
    updatedAt: number;
}

const SHELF_KEY = 'novelReader.shelf';
const LEGACY_SESSION_KEY = 'novelReader.session';

/** 旧版 session 结构 */
interface LegacySession {
    filePath: string;
    chapterIndex: number;
    scrollRatio: number;
    updatedAt: number;
}

export class ShelfStore {
    constructor(private readonly state: vscode.Memento) {}

    /** 全部书籍, 按最近阅读排序 */
    list(): ShelfBook[] {
        const books = this.state.get<ShelfBook[]>(SHELF_KEY, []);
        return [...books].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    get(filePath: string): ShelfBook | undefined {
        return this.state.get<ShelfBook[]>(SHELF_KEY, []).find((b) => b.filePath === filePath);
    }

    /** 最近一次阅读的书(用于启动时自动延续) */
    last(): ShelfBook | undefined {
        return this.list()[0];
    }

    get size(): number {
        return this.state.get<ShelfBook[]>(SHELF_KEY, []).length;
    }

    /** 打开小说时登记/更新书籍信息(保留已有阅读进度) */
    async upsert(book: {
        filePath: string;
        title: string;
        author: string;
        totalChapters: number;
    }): Promise<ShelfBook> {
        const books = this.state.get<ShelfBook[]>(SHELF_KEY, []);
        const now = Date.now();
        const existing = books.find((b) => b.filePath === book.filePath);
        const next: ShelfBook = existing
            ? { ...existing, ...book, updatedAt: now }
            : {
                  ...book,
                  chapterIndex: -1,
                  scrollRatio: 0,
                  addedAt: now,
                  updatedAt: now,
              };
        const rest = books.filter((b) => b.filePath !== book.filePath);
        await this.state.update(SHELF_KEY, [...rest, next]);
        return next;
    }

    /** 保存阅读进度(同时把章内比例记入 chapterRatios, 供切章后恢复原位置) */
    async updateProgress(filePath: string, chapterIndex: number, scrollRatio: number): Promise<void> {
        const books = this.state.get<ShelfBook[]>(SHELF_KEY, []);
        const idx = books.findIndex((b) => b.filePath === filePath);
        if (idx < 0) {
            return;
        }
        const ratio = Math.min(1, Math.max(0, scrollRatio || 0));
        const book = books[idx];
        const ratios = { ...(book.chapterRatios || {}) };
        // 只记忆"非顶部"(>0.5%)的位置: 切章瞬间 webview 会先上报 (新章节, 0),
        // 若把 0 也记进去, 会在恢复滚动前就把该章的位置记忆清零
        const ratioChanged = ratio > 0.005 && Math.abs((ratios[chapterIndex] ?? -1) - ratio) >= 0.01;
        if (ratioChanged) {
            // 记忆表只在比例真的变了时才更新, 避免高频滚动反复整表写盘
            ratios[chapterIndex] = ratio;
        }
        if (
            book.chapterIndex === chapterIndex &&
            Math.abs(book.scrollRatio - ratio) < 0.01 &&
            !ratioChanged
        ) {
            return;
        }
        books[idx] = {
            ...book,
            chapterIndex,
            scrollRatio: ratio,
            chapterRatios: ratioChanged ? ratios : book.chapterRatios,
            updatedAt: Date.now(),
        };
        await this.state.update(SHELF_KEY, books);
    }

    /** 查询某章的阅读位置记忆(无记录返回 undefined) */
    getRatio(filePath: string, chapterIndex: number): number | undefined {
        const book = this.get(filePath);
        const r = book?.chapterRatios?.[chapterIndex];
        return typeof r === 'number' && r > 0 ? Math.min(1, r) : undefined;
    }

    /** 从书架移除 */
    async remove(filePath: string): Promise<void> {
        const books = this.state.get<ShelfBook[]>(SHELF_KEY, []);
        await this.state.update(
            SHELF_KEY,
            books.filter((b) => b.filePath !== filePath)
        );
    }

    /**
     * 文件被移动/改名后重新定位: 把阅读进度从旧路径迁移到新路径。
     * 旧条目被替换为新条目(保留 chapterIndex / scrollRatio / addedAt)。
     */
    async relink(
        oldPath: string,
        newPath: string,
        meta: { title: string; author: string; totalChapters: number }
    ): Promise<void> {
        const books = this.state.get<ShelfBook[]>(SHELF_KEY, []);
        const old = books.find((b) => b.filePath === oldPath);
        const rest = books.filter((b) => b.filePath !== oldPath && b.filePath !== newPath);
        const now = Date.now();
        const next: ShelfBook = {
            filePath: newPath,
            title: meta.title,
            author: meta.author,
            totalChapters: meta.totalChapters,
            chapterIndex: old ? old.chapterIndex : -1,
            scrollRatio: old ? old.scrollRatio : 0,
            addedAt: old ? old.addedAt : now,
            updatedAt: now,
        };
        await this.state.update(SHELF_KEY, [...rest, next]);
    }

    /**
     * 迁移旧版的单本 session 到书架(幂等)。
     * 仅在书架为空且存在旧 session 时执行, 迁移后删除旧键。
     */
    async migrateLegacySession(): Promise<void> {
        const legacy = this.state.get<LegacySession | undefined>(LEGACY_SESSION_KEY);
        if (!legacy || !legacy.filePath) {
            return;
        }
        if (this.size === 0) {
            const now = Date.now();
            const book: ShelfBook = {
                filePath: legacy.filePath,
                title: legacy.filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''),
                author: '',
                totalChapters: 0,
                chapterIndex: typeof legacy.chapterIndex === 'number' ? legacy.chapterIndex : -1,
                scrollRatio: legacy.scrollRatio || 0,
                addedAt: legacy.updatedAt || now,
                updatedAt: legacy.updatedAt || now,
            };
            await this.state.update(SHELF_KEY, [book]);
        }
        await this.state.update(LEGACY_SESSION_KEY, undefined);
    }
}
