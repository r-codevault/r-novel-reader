/**
 * onlineCache.ts — 在线书的本地缓存(目录 + 已读章节)
 *
 * 目录: <root>/<sourceId>/<hash>/toc.json
 * 正文: <root>/<sourceId>/<hash>/ch-<index>.txt
 *
 * 用扩展 globalStorage 目录, 不污染书库; 删除书架条目时整目录清掉。
 *
 * 注意: 这里只放「按需懒加载读过的章」这类临时缓存, 可以随时清空。
 * 用户主动下载的离线内容在 offline/offlineStore.ts(独立的 offline-cache 目录),
 * 两者刻意分开 —— 否则「删书架保留离线内容」和「清临时缓存」会互相踩。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OnlineChapter } from './online/onlineBook';
import { parseOnlinePath } from './onlinePath';
import { dirSize, readJson, writeJsonAtomic } from './util/fsx';

export interface CachedToc {
    v: 1;
    fetchedAt: number;
    tocUrl: string;
    chapters: OnlineChapter[];
}

export class OnlineCache {
    constructor(private readonly root: string) {}

    private dirFor(key: string): string | null {
        const ref = parseOnlinePath(key);
        if (!ref) { return null; }
        const sourceId = ref.sourceId.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!sourceId || !/^[0-9a-f]+$/.test(ref.hash)) { return null; }
        return path.join(this.root, sourceId, ref.hash);
    }

    async readToc(key: string): Promise<CachedToc | null> {
        const dir = this.dirFor(key);
        if (!dir) { return null; }
        const parsed = await readJson<CachedToc>(path.join(dir, 'toc.json'));
        if (!parsed || !Array.isArray(parsed.chapters) || !parsed.chapters.length) { return null; }
        return parsed;
    }

    async writeToc(key: string, toc: CachedToc): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        await writeJsonAtomic(path.join(dir, 'toc.json'), toc);
    }

    async readChapter(key: string, index: number): Promise<string[] | null> {
        const dir = this.dirFor(key);
        if (!dir) { return null; }
        try {
            const text = await fs.promises.readFile(path.join(dir, 'ch-' + index + '.txt'), 'utf8');
            const lines = text.split('\n').map(function (line) { return line.trim(); }).filter(function (line) { return !!line; });
            return lines.length ? lines : null;
        } catch {
            return null;
        }
    }

    async writeChapter(key: string, index: number, paragraphs: string[]): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, 'ch-' + index + '.txt'), paragraphs.join('\n'), 'utf8');
    }

    /**
     * 列出已缓存正文的章号(升序)。
     *
     * 目录面板要用它标出「读了就自动缓存、断网也能看」的章 —— 与主动下载的
     * offline-cache 区分开: 这些章删书架/清缓存后就会消失。
     */
    async listChapters(key: string): Promise<number[]> {
        const dir = this.dirFor(key);
        if (!dir) { return []; }
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
        const out: number[] = [];
        for (const entry of entries) {
            if (!entry.isFile()) { continue; }
            const m = /^ch-(\d+)\.txt$/.exec(entry.name);
            if (!m) { continue; }
            const index = Number(m[1]);
            if (Number.isInteger(index) && index >= 0) { out.push(index); }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    /** 删除某本在线书的全部缓存 */
    async clear(key: string): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        } catch { /* 忽略 */ }
    }

    /** 统计单本缓存大小(字节), 供存储面板展示/清理 */
    async sizeOf(key: string): Promise<number> {
        const dir = this.dirFor(key);
        if (!dir) { return 0; }
        return dirSize(dir);
    }

    /** 统计整个临时缓存目录的大小与书目数, 供存储面板展示 */
    async totalSize(): Promise<{ bytes: number; books: number }> {
        let bytes = 0;
        let books = 0;
        let sources: fs.Dirent[];
        try { sources = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch { return { bytes: 0, books: 0 }; }
        for (const source of sources) {
            if (!source.isDirectory()) { continue; }
            const sourceDir = path.join(this.root, source.name);
            let books2: fs.Dirent[];
            try { books2 = await fs.promises.readdir(sourceDir, { withFileTypes: true }); } catch { continue; }
            for (const book of books2) {
                if (!book.isDirectory()) { continue; }
                books += 1;
                bytes += await dirSize(path.join(sourceDir, book.name));
            }
        }
        return { bytes, books };
    }
}
