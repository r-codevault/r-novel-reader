/**
 * bookSource.ts — 书源数据模型与存储
 *
 * 字段名沿用 legado(阅读 App)的 camelCase, 这样用户直接从书源站导入的 JSON
 * 可以原样保存、原样导出, 字段不会在中间层被改名。
 *
 * 存储: globalState `novelReader.bookSources`, 结构 `{ v:1, items:[...] }`;
 * 读-改-写走串行队列(照 notes.ts 的做法), 避免连点导入丢数据。
 */
import * as crypto from 'crypto';

export interface RuleSearch {
    bookList?: string;
    name?: string;
    author?: string;
    bookUrl?: string;
    coverUrl?: string;
    intro?: string;
    kind?: string;
    lastChapter?: string;
    wordCount?: string;
    checkKeyWord?: string;
}

export interface RuleToc {
    chapterList?: string;
    chapterName?: string;
    chapterUrl?: string;
    /** 有些源把下一章链接放在目录页(翻页阅读) */
    nextTocUrl?: string;
}

export interface RuleContent {
    content?: string;
    nextContentUrl?: string;
    title?: string;
}

export interface RuleBookInfo {
    name?: string;
    author?: string;
    intro?: string;
    kind?: string;
    lastChapter?: string;
    wordCount?: string;
    coverUrl?: string;
    tocUrl?: string;
}

/** legado 书源(只保留本扩展用得到的字段, 其余原样透传) */
export interface BookSource {
    id: string;
    bookSourceName: string;
    bookSourceUrl: string;
    bookSourceGroup?: string;
    bookSourceType?: number;
    bookSourceComment?: string;
    /** JSON 字符串: {"User-Agent":"..."} */
    header?: string;
    enabled: boolean;
    searchUrl?: string;
    ruleSearch?: RuleSearch;
    ruleBookInfo?: RuleBookInfo;
    ruleToc?: RuleToc;
    ruleContent?: RuleContent;
    exploreUrl?: string;
    jsLib?: string;
    variable?: string;
    /** 部分源声明页面编码 */
    charset?: string;
    customOrder?: number;
    addedAt: number;
    lastCheck?: number;
    lastCheckOk?: boolean;
    lastCheckMessage?: string;
    [extra: string]: unknown;
}

/** 下发给 webview 的精简视图(不带规则体, 2000 条也不会撑爆消息) */
export interface BookSourceView {
    id: string;
    name: string;
    url: string;
    group: string;
    enabled: boolean;
    searchUrl: string;
    lastCheck?: number;
    lastCheckOk?: boolean;
    lastCheckMessage?: string;
}

export function toSourceView(s: BookSource): BookSourceView {
    return {
        id: s.id,
        name: s.bookSourceName,
        url: s.bookSourceUrl,
        group: s.bookSourceGroup || '',
        enabled: s.enabled,
        searchUrl: s.searchUrl || '',
        lastCheck: s.lastCheck,
        lastCheckOk: s.lastCheckOk,
        lastCheckMessage: s.lastCheckMessage,
    };
}

/** 旧版存储键(globalState): 仅用于一次性迁移, 之后改存文件(合集可达 2000 条 / 10MB) */
export const LEGACY_BOOK_SOURCES_KEY = 'novelReader.bookSources';
const MAX_SOURCES = 5000;

interface SourceFile {
    v: number;
    items: BookSource[];
}

/** 存储适配器: 扩展用文件, 测试用内存 */
export interface BookSourceStorage {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
}

export interface ImportResult {
    added: number;
    updated: number;
    skipped: number;
    errors: string[];
    total: number;
}

/** 用 URL 派生稳定 id: 同一书源重复导入会落到同一条记录上 */
export function sourceIdFor(url: string): string {
    return crypto.createHash('sha1').update(String(url || '').trim().toLowerCase()).digest('hex').slice(0, 12);
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

/** 把任意来源的原始对象规范化为 BookSource; 缺关键字段返回 null */
export function normalizeSource(raw: unknown, now = Date.now()): BookSource | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
    const o = raw as Record<string, unknown>;
    const url = str(o.bookSourceUrl);
    const name = str(o.bookSourceName) || str(o.bookSourceUrl);
    if (!url || !/^https?:\/\//i.test(url)) { return null; }
    const source: BookSource = {
        ...o,
        id: sourceIdFor(url),
        bookSourceName: name || url,
        bookSourceUrl: url.replace(/\/+$/, ''),
        bookSourceGroup: str(o.bookSourceGroup),
        bookSourceComment: str(o.bookSourceComment),
        header: typeof o.header === 'string' ? o.header : '',
        enabled: bool(o.enabled, true),
        searchUrl: typeof o.searchUrl === 'string' ? o.searchUrl : '',
        charset: str(o.charset),
        customOrder: typeof o.customOrder === 'number' ? o.customOrder : 0,
        addedAt: typeof o.addedAt === 'number' ? o.addedAt : now,
    };
    const search = o.ruleSearch;
    source.ruleSearch = search && typeof search === 'object' ? (search as RuleSearch) : undefined;
    const toc = o.ruleToc;
    source.ruleToc = toc && typeof toc === 'object' ? (toc as RuleToc) : undefined;
    const content = o.ruleContent;
    source.ruleContent = content && typeof content === 'object' ? (content as RuleContent) : undefined;
    const info = o.ruleBookInfo;
    source.ruleBookInfo = info && typeof info === 'object' ? (info as RuleBookInfo) : undefined;
    return source;
}

/** 扫描平衡的 `{...}` 块(应对"多个 JSON 对象首尾相连"的书源文件) */
function scanObjects(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = -1;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) { quote = ''; }
            continue;
        }
        if (ch === '"') { quote = ch; continue; }
        if (ch === '{') {
            if (depth === 0) { start = i; }
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
        }
    }
    return out;
}

/**
 * 解析书源文本(用户粘贴/从 URL 下载/本地文件)。
 * 容错顺序: 整体 JSON -> 去 // 注释行 -> 逐个平衡对象解析 -> 包裹在对象里的数组。
 */
export function parseSourceText(text: string): { raws: unknown[]; errors: string[] } {
    const errors: string[] = [];
    const src = (text || '').replace(/^\uFEFF/, '').trim();
    if (!src) { return { raws: [], errors: ['内容为空'] }; }

    const collectFrom = (value: unknown): unknown[] => {
        if (Array.isArray(value)) { return value; }
        if (value && typeof value === 'object') {
            const obj = value as Record<string, unknown>;
            // 常见包裹: {bookSources:[...]} / {data:[...]} / {items:[...]}
            for (const key of ['bookSources', 'data', 'items', 'sources']) {
                if (Array.isArray(obj[key])) { return obj[key] as unknown[]; }
            }
            return [value];
        }
        return [];
    };

    try {
        return { raws: collectFrom(JSON.parse(src)), errors };
    } catch (err) {
        errors.push('整体 JSON 解析失败: ' + (err as Error).message);
    }

    // 去掉整行的 // 注释后重试
    const stripped = src.split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n');
    try {
        return { raws: collectFrom(JSON.parse(stripped)), errors: [] };
    } catch {
        // 继续尝试逐对象解析
    }

    const raws: unknown[] = [];
    for (const chunk of scanObjects(stripped)) {
        try {
            raws.push(JSON.parse(chunk));
        } catch {
            // 单个坏块不影响其它书源
        }
    }
    if (raws.length) { return { raws, errors: ['已跳过部分无法解析的内容'] }; }
    errors.push('没有解析出任何书源');
    return { raws: [], errors };
}

function isSource(v: unknown): v is BookSource {
    if (!v || typeof v !== 'object') { return false; }
    const o = v as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.bookSourceUrl === 'string' && typeof o.bookSourceName === 'string';
}

export class BookSourceStore {
    private _chain: Promise<unknown> = Promise.resolve();
    private items: BookSource[] = [];
    private loaded = false;
    /** 首次 load 完成前, 写操作必须排队等待(否则会用空表覆盖磁盘) */
    private _readyResolve: (() => void) | undefined;
    private readonly _ready = new Promise<void>((resolve) => { this._readyResolve = resolve; });

    constructor(private readonly storage: BookSourceStorage) {}

    /** 首启动加载(扩展 activate 时 await; 之后 list/get 均为内存读) */
    async load(): Promise<void> {
        if (this.loaded) { return; }
        this.loaded = true;
        try {
            const text = await this.storage.read();
            if (!text) { return; }
            const parsed = JSON.parse(text) as SourceFile;
            if (parsed && parsed.v === 1 && Array.isArray(parsed.items)) {
                this.items = parsed.items.filter(isSource);
            }
        } catch {
            // 文件损坏: 以空表启动, 不阻断扩展
            this.items = [];
        } finally {
            this._readyResolve?.();
        }
    }

    /** 从旧版 globalState 迁移(幂等; 迁移后由调用方清掉旧键) */
    async migrateLegacy(raw: unknown): Promise<number> {
        if (!raw || typeof raw !== 'object' || !Array.isArray((raw as SourceFile).items)) { return 0; }
        if (this.items.length > 0) { return 0; }
        const items = ((raw as SourceFile).items as unknown[]).filter(isSource) as BookSource[];
        if (!items.length) { return 0; }
        this.items = items.slice(0, MAX_SOURCES);
        await this._persist();
        return this.items.length;
    }

    private _read(): BookSource[] {
        return this.items;
    }

    private async _persist(): Promise<void> {
        const doc: SourceFile = { v: 1, items: this.items.slice(0, MAX_SOURCES) };
        await this.storage.write(JSON.stringify(doc));
    }

    private async _write(items: BookSource[]): Promise<void> {
        this.items = items.slice(0, MAX_SOURCES);
        await this._persist();
    }

    private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
        // 必须同步快照旧链: 若在回调里读 this._chain, 那时它已被本次任务覆盖, 会自我等待
        const prev = this._chain;
        const run = this._ready.then(() => prev).then(fn, fn);
        // 失败不能污染后续队列
        this._chain = run.catch(() => undefined);
        return run;
    }

    list(): BookSource[] {
        return this._read().slice().sort((a, b) => {
            const oa = a.customOrder || 0;
            const ob = b.customOrder || 0;
            if (oa !== ob) { return oa - ob; }
            return a.bookSourceName.localeCompare(b.bookSourceName, 'zh-Hans-CN');
        });
    }

    get(id: string): BookSource | undefined {
        return this._read().find((s) => s.id === id);
    }

    enabled(): BookSource[] {
        return this.list().filter((s) => s.enabled);
    }

    size(): number {
        return this._read().length;
    }

    async upsert(source: BookSource): Promise<BookSource> {
        return this._enqueue(async () => {
            const items = this._read();
            const idx = items.findIndex((s) => s.id === source.id);
            if (idx >= 0) {
                // 保留用户本地状态(enabled / addedAt / 检查结果)
                items[idx] = { ...source, enabled: items[idx].enabled, addedAt: items[idx].addedAt };
            } else {
                items.push(source);
            }
            await this._write(items);
            return source;
        });
    }

    async remove(id: string): Promise<void> {
        await this._enqueue(async () => {
            await this._write(this._read().filter((s) => s.id !== id));
        });
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this._enqueue(async () => {
            const items = this._read();
            const target = items.find((s) => s.id === id);
            if (!target) { return; }
            target.enabled = enabled;
            await this._write(items);
        });
    }

    /** 记录一次可用性检查结果 */
    async markCheck(id: string, ok: boolean, message: string): Promise<void> {
        await this._enqueue(async () => {
            const items = this._read();
            const target = items.find((s) => s.id === id);
            if (!target) { return; }
            target.lastCheck = Date.now();
            target.lastCheckOk = ok;
            target.lastCheckMessage = message.slice(0, 300);
            await this._write(items);
        });
    }

    /**
     * 导入书源文本。
     * 同 URL 视为同一书源: 更新规则但保留 enabled/addedAt/检查结果。
     */
    async importText(text: string): Promise<ImportResult> {
        const { raws, errors } = parseSourceText(text);
        const result: ImportResult = { added: 0, updated: 0, skipped: 0, errors, total: raws.length };
        const now = Date.now();
        const incoming: BookSource[] = [];
        const seen = new Set<string>();
        for (const raw of raws) {
            const normalized = normalizeSource(raw, now);
            if (!normalized) { result.skipped++; continue; }
            if (seen.has(normalized.id)) { result.skipped++; continue; }
            seen.add(normalized.id);
            incoming.push(normalized);
        }
        if (!incoming.length) { return result; }

        await this._enqueue(async () => {
            const items = this._read();
            const byId = new Map(items.map((s) => [s.id, s]));
            for (const src of incoming) {
                const old = byId.get(src.id);
                if (old) {
                    byId.set(src.id, { ...src, enabled: old.enabled, addedAt: old.addedAt, lastCheck: old.lastCheck, lastCheckOk: old.lastCheckOk, lastCheckMessage: old.lastCheckMessage });
                    result.updated++;
                } else {
                    byId.set(src.id, src);
                    result.added++;
                }
            }
            await this._write(Array.from(byId.values()));
        });
        return result;
    }

    /** 导出为 legado 可直接导入的 JSON(数组) */
    exportText(ids?: string[]): string {
        const items = this._read()
            .filter((s) => !ids || ids.indexOf(s.id) >= 0)
            .map((s) => {
                const out: Record<string, unknown> = { ...s };
                delete out.lastCheck;
                delete out.lastCheckOk;
                delete out.lastCheckMessage;
                return out;
            });
        return JSON.stringify(items, null, 2);
    }
}
