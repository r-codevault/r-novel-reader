/**
 * offline/offlineStore.ts — 用户主动下载的离线内容(与临时读缓存物理分离)
 *
 * 目录: <root>/<sourceId>/<hash>/
 *   manifest.json  元信息 + 目录快照(原子写)
 *   done.log       每行一条完成记录(追加写, O(1); 崩溃最多丢最后一行)
 *   ch-000012.txt  正文, 段落之间用 "\n\n" 分隔(保住段距)
 *
 * 为什么不用「每章重写 manifest」: 5000 章的书会产生几十万次全量写盘。
 *
 * 真值来源以磁盘为准: listDone() 同时读 done.log 与目录里的 ch-*.txt,
 * 两者取并集再校验文件确实存在且非空 —— 断电/手删文件都能自愈。
 *
 * 本模块只依赖 fs/path, 不依赖 vscode, 便于单元测试。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OnlineChapter } from '../online/onlineBook';
import { parseOnlinePath } from '../onlinePath';
import { appendLine, dirSize, readJson, readLines, writeJsonAtomic } from '../util/fsx';

export interface OfflineManifest {
    v: 1;
    sourceId: string;
    sourceName: string;
    bookUrl: string;
    bookTitle: string;
    author: string;
    tocUrl: string;
    tocFetchedAt: number;
    /** 目录快照: 导出与离线阅读都不再依赖书源 */
    chapters: OnlineChapter[];
    totalChapters: number;
    createdAt: number;
    updatedAt: number;
    /** 最近一次下载范围(0 基, 含端点); 缺省表示整本 */
    range?: [number, number];
    /** 失败章 → 精简错误(上限 200 条, 续传时自动重试) */
    failed?: Record<string, string>;
}

export interface OfflineEntry {
    key: string;
    manifest: OfflineManifest;
    done: number[];
    bytes: number;
}

export interface ErrorReport {
    /** 章节序号 → 错误信息 */
    [index: number]: string;
}

const MANIFEST = 'manifest.json';
const DONE_LOG = 'done.log';
const MAX_FAILURES = 200;

/** 章节文件名(零填充, 目录里排序好看, 也避免 ch-2 与 ch-10 混淆) */
function chapterFile(index: number): string {
    return 'ch-' + String(index).padStart(6, '0') + '.txt';
}

/** 从文件名反解章节序号; 不匹配返回 null */
function parseChapterFile(name: string): number | null {
    const m = /^ch-(\d+)\.txt$/.exec(name);
    if (!m) { return null; }
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

export class OfflineStore {
    /**
     * done.log 的串行写队列。
     *
     * 下载是 3 并发, 而 Windows 上多个 appendFile 同时打开同一个文件会直接
     * 抛 EPERM(操作不允许) —— 已实测复现。这里按文件路径串起来写,
     * 保证任何时刻只有一个 append 在跑。
     */
    private readonly appendQueues = new Map<string, Promise<unknown>>();
    /** manifest.json 的串行写队列: 同一个 .tmp 路径被并发写会互相抢 */
    private readonly jsonQueues = new Map<string, Promise<unknown>>();

    constructor(private readonly root: string) {}

    /** 串行追加一行; 前一次失败不影响后一次 */
    private appendSerial(file: string, line: string): Promise<void> {
        const prev = this.appendQueues.get(file) || Promise.resolve();
        const next = prev.then(
            () => appendLine(file, line),
            () => appendLine(file, line)
        );
        // 存一份"不会 reject"的版本, 避免队列里堆积未处理的拒绝
        this.appendQueues.set(file, next.catch(() => undefined));
        return next;
    }

    /** 串行原子写 JSON */
    private jsonSerial(file: string, data: unknown): Promise<void> {
        const prev = this.jsonQueues.get(file) || Promise.resolve();
        const next = prev.then(
            () => writeJsonAtomic(file, data),
            () => writeJsonAtomic(file, data)
        );
        this.jsonQueues.set(file, next.catch(() => undefined));
        return next;
    }

    dirFor(key: string): string | null {
        const ref = parseOnlinePath(key);
        if (!ref) { return null; }
        const sourceId = ref.sourceId.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!sourceId || !/^[0-9a-f]+$/.test(ref.hash)) { return null; }
        return path.join(this.root, sourceId, ref.hash);
    }

    // ------------------------------------------------------------ manifest

    async readManifest(key: string): Promise<OfflineManifest | null> {
        const dir = this.dirFor(key);
        if (!dir) { return null; }
        const m = await readJson<OfflineManifest>(path.join(dir, MANIFEST));
        if (!m || m.v !== 1 || !Array.isArray(m.chapters) || !m.chapters.length) { return null; }
        return m;
    }

    async writeManifest(key: string, m: OfflineManifest): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        m.updatedAt = Date.now();
        await this.jsonSerial(path.join(dir, MANIFEST), m);
    }

    /**
     * 首次下载写入; 已存在则刷新目录快照, 保留 createdAt / range / failed。
     * 目录章节数变化(连载更新)时以新目录为准。
     */
    async ensureManifest(
        key: string,
        seed: Omit<OfflineManifest, 'v' | 'createdAt' | 'updatedAt'>
    ): Promise<OfflineManifest> {
        const existing = await this.readManifest(key);
        if (existing) {
            const changed = existing.chapters.length !== seed.chapters.length
                || existing.tocFetchedAt !== seed.tocFetchedAt;
            if (!changed) { return existing; }
            const next: OfflineManifest = {
                ...existing,
                sourceName: seed.sourceName,
                tocUrl: seed.tocUrl,
                tocFetchedAt: seed.tocFetchedAt,
                chapters: seed.chapters,
                totalChapters: seed.totalChapters,
                updatedAt: Date.now(),
            };
            await this.writeManifest(key, next);
            return next;
        }
        const now = Date.now();
        const created: OfflineManifest = { ...seed, v: 1, createdAt: now, updatedAt: now };
        await this.writeManifest(key, created);
        return created;
    }

    // ------------------------------------------------------------- chapters

    /** 写一章正文(段落以 "\n\n" 分隔, 保住段距), 返回字节数 */
    async writeChapter(key: string, index: number, paragraphs: string[]): Promise<number> {
        const dir = this.dirFor(key);
        if (!dir) { return 0; }
        await fs.promises.mkdir(dir, { recursive: true });
        const text = paragraphs.join('\n\n');
        const target = path.join(dir, chapterFile(index));
        // 先写 .tmp 再 rename: 下载中断不会留下半章, 否则下次会被当成"已下载"
        const tmp = target + '.tmp';
        await fs.promises.writeFile(tmp, text, 'utf8');
        await fs.promises.rename(tmp, target);
        return Buffer.byteLength(text, 'utf8');
    }

    /** 读回段落; 与旧 OnlineCache.readChapter 的返回形状一致(切分后去空行) */
    async readChapter(key: string, index: number): Promise<string[] | null> {
        const dir = this.dirFor(key);
        if (!dir) { return null; }
        try {
            const text = await fs.promises.readFile(path.join(dir, chapterFile(index)), 'utf8');
            const lines = text.split('\n').map((l) => l.trim()).filter((l) => !!l);
            return lines.length ? lines : null;
        } catch {
            return null;
        }
    }

    // --------------------------------------------------------------- done

    /** 已下载章(升序): done.log ∪ 目录里的 ch-*.txt, 再校验文件存在且非空 */
    async listDone(key: string): Promise<number[]> {
        const dir = this.dirFor(key);
        if (!dir) { return []; }

        const candidates = new Set<number>();

        for (const line of await readLines(path.join(dir, DONE_LOG))) {
            try {
                const rec = JSON.parse(line) as { i?: number };
                if (typeof rec.i === 'number' && Number.isInteger(rec.i) && rec.i >= 0) {
                    candidates.add(rec.i);
                }
            } catch { /* 坏行忽略: 断电可能留下半截 */ }
        }

        // 目录扫描作为兜底真值: done.log 丢失时仍能恢复
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) { continue; }
                const idx = parseChapterFile(entry.name);
                if (idx !== null) { candidates.add(idx); }
            }
        } catch { /* 目录不存在 */ }

        const ok: number[] = [];
        for (const idx of candidates) {
            try {
                const stat = await fs.promises.stat(path.join(dir, chapterFile(idx)));
                if (stat.isFile() && stat.size > 0) { ok.push(idx); }
            } catch { /* 文件被删: 不算已下载 */ }
        }
        ok.sort((a, b) => a - b);
        return ok;
    }

    /** 记一章完成(追加一行, O(1); 串行写避免 Windows 文件锁冲突) */
    async markDone(key: string, index: number, bytes: number): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        await this.appendSerial(
            path.join(dir, DONE_LOG),
            JSON.stringify({ i: index, n: bytes, t: Date.now() })
        );
    }

    /** 续传前一次性装载: manifest + done + failed */
    async loadState(key: string): Promise<{
        manifest: OfflineManifest | null;
        done: Set<number>;
        failed: Record<number, string>;
    }> {
        const manifest = await this.readManifest(key);
        const done = new Set(await this.listDone(key));
        const failed: Record<number, string> = {};
        if (manifest && manifest.failed) {
            for (const [k, v] of Object.entries(manifest.failed)) {
                const n = Number(k);
                if (Number.isInteger(n)) { failed[n] = v; }
            }
        }
        return { manifest, done, failed };
    }

    /** 写入失败章清单(低频事件, 才值得整份重写 manifest) */
    async setFailures(key: string, failed: Record<number, string>): Promise<void> {
        const manifest = await this.readManifest(key);
        if (!manifest) { return; }
        const entries = Object.entries(failed)
            .filter(([k]) => Number.isInteger(Number(k)))
            .slice(0, MAX_FAILURES);
        const next: Record<string, string> = {};
        for (const [k, v] of entries) { next[k] = v; }
        manifest.failed = Object.keys(next).length ? next : undefined;
        await this.writeManifest(key, manifest);
    }

    // ---------------------------------------------------------------- size

    async sizeOf(key: string): Promise<number> {
        const dir = this.dirFor(key);
        if (!dir) { return 0; }
        return dirSize(dir);
    }

    /** 全部离线内容的汇总(存储面板展示) */
    async totalSize(): Promise<{ bytes: number; books: number }> {
        let bytes = 0;
        let books = 0;
        for (const item of await this.scan()) {
            bytes += await dirSize(item.dir);
            books += 1;
        }
        return { bytes, books };
    }

    /** 列出全部离线书(启动时建内存索引) */
    async listAll(): Promise<OfflineEntry[]> {
        const out: OfflineEntry[] = [];
        for (const item of await this.scan()) {
            if (!item.manifest) { continue; }
            out.push({
                key: item.key,
                manifest: item.manifest,
                done: await this.listDone(item.key),
                bytes: await dirSize(item.dir),
            });
        }
        return out;
    }

    /** 扫描根目录 → 每本书的 key / dir / manifest(lazy; 不统计大小) */
    private async scan(): Promise<{ key: string; dir: string; manifest: OfflineManifest | null }[]> {
        let sources: fs.Dirent[];
        try { sources = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch { return []; }
        const out: { key: string; dir: string; manifest: OfflineManifest | null }[] = [];
        for (const source of sources) {
            if (!source.isDirectory()) { continue; }
            const sourceDir = path.join(this.root, source.name);
            let books: fs.Dirent[];
            try { books = await fs.promises.readdir(sourceDir, { withFileTypes: true }); } catch { continue; }
            for (const book of books) {
                if (!book.isDirectory()) { continue; }
                const dir = path.join(sourceDir, book.name);
                const manifest = await readJson<OfflineManifest>(path.join(dir, MANIFEST));
                // key 优先用 manifest 里的真实 sourceId; 目录名是清洗过的
                const sourceId = manifest && manifest.sourceId ? manifest.sourceId : source.name;
                out.push({
                    key: 'online://' + sourceId + '/' + book.name,
                    dir,
                    manifest: manifest && manifest.v === 1 ? manifest : null,
                });
            }
        }
        return out;
    }

    // -------------------------------------------------------------- remove

    async remove(key: string): Promise<void> {
        const dir = this.dirFor(key);
        if (!dir) { return; }
        try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    async removeAll(): Promise<void> {
        try { await fs.promises.rm(this.root, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
}
