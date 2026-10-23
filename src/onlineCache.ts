/**
 * onlineCache.ts — 在线书的本地缓存(目录 + 已读章节)
 *
 * 目录: <root>/<sourceId>/<hash>/toc.json
 * 正文: <root>/<sourceId>/<hash>/ch-<index>.txt
 *
 * 用扩展 globalStorage 目录, 不污染书库; 删除书架条目时整目录清掉。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OnlineChapter } from './online/onlineBook';
import { parseOnlinePath } from './onlinePath';

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
        try {
            const text = await fs.promises.readFile(path.join(dir, 'toc.json'), 'utf8');
            const parsed = JSON.parse(text) as CachedToc;
            if (!parsed || !Array.isArray(parsed.chapters) || !parsed.chapters.length) { return null; }
            return parsed;
        } catch {
            return null;
        }
    }

    async writeToc(key: string, toc: CachedToc): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        await fs.promises.mkdir(dir, { recursive: true });
        const tmp = path.join(dir, 'toc.json.tmp');
        await fs.promises.writeFile(tmp, JSON.stringify(toc), 'utf8');
        await fs.promises.rename(tmp, path.join(dir, 'toc.json'));
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

    /** 删除某本在线书的全部缓存 */
    async clear(key: string): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        } catch { /* 忽略 */ }
    }

    /** 统计缓存大小(字节), 供存储面板展示/清理 */
    async sizeOf(key: string): Promise<number> {
        const dir = this.dirFor(key);
        if (!dir) { return 0; }
        let total = 0;
        const walk = async (current: string): Promise<void> => {
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) { await walk(full); continue; }
                try { total += (await fs.promises.stat(full)).size; } catch { /* 忽略 */ }
            }
        };
        await walk(dir);
        return total;
    }
}
