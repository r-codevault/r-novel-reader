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

/** 连续失败多少次判定失效 */
export const FAIL_THRESHOLD = 2;

/** 失效判定: deadAt 是唯一事实源 */
export function isDead(s: { deadAt?: number }): boolean {
    return typeof s.deadAt === 'number' && s.deadAt > 0;
}

export function failStreakOf(s: { failStreak?: number }): number {
    const n = s.failStreak;
    return typeof n === 'number' && isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

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
    /** 连续失败次数(检查/搜索), 任意一次成功清零 */
    failStreak?: number;
    /** >0 = 失效(自动退出搜索, 只在「失效」Tab 出现) */
    deadAt?: number;
    /** 失效原因(最近一次失败信息) */
    deadReason?: string;
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
    failStreak: number;
    deadAt?: number;
    deadReason?: string;
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
        failStreak: failStreakOf(s),
        deadAt: isDead(s) ? s.deadAt : undefined,
        deadReason: s.deadReason,
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

/** 单源检查/搜索结果 */
export interface SourceResult {
    id: string;
    ok: boolean;
    message?: string;
    /** 结果时间戳, 缺省当前时间 */
    at?: number;
}

export interface RecordOutcome {
    /** 本次新标记失效的 id */
    died: string[];
    /** 本次自动恢复的 id */
    revived: string[];
    written: boolean;
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
        failStreak: failStreakOf({ failStreak: typeof o.failStreak === 'number' ? o.failStreak : 0 }),
        deadAt: typeof o.deadAt === 'number' && o.deadAt > 0 ? (o.deadAt as number) : undefined,
        deadReason: str(o.deadReason).slice(0, 300) || undefined,
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

/** 旧文件没有失效字段: 只在内存补默认值, 不回写磁盘 */
function hydrate(items: BookSource[]): BookSource[] {
    return items.map((s) => ({
        ...s,
        failStreak: failStreakOf(s),
        deadAt: isDead(s) ? s.deadAt : undefined,
        deadReason: typeof s.deadReason === 'string' && s.deadReason ? s.deadReason : undefined,
    }));
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
                this.items = hydrate(parsed.items.filter(isSource));
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
        this.items = hydrate(items.slice(0, MAX_SOURCES));
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

    /** 参与搜索: 已启用且未失效 */
    searchable(): BookSource[] {
        return this.list().filter((s) => s.enabled && !isDead(s));
    }

    /** 全部失效书源 */
    deadList(): BookSource[] {
        return this.list().filter((s) => isDead(s));
    }

    size(): number {
        return this._read().length;
    }

    async upsert(source: BookSource): Promise<BookSource> {
        return this._enqueue(async () => {
            const items = this._read();
            const idx = items.findIndex((s) => s.id === source.id);
            if (idx >= 0) {
                // 保留用户本地状态与运行态(启用/登记时间/检查结果/失效判定)
                const old = items[idx];
                items[idx] = {
                    ...source,
                    enabled: old.enabled,
                    addedAt: old.addedAt,
                    lastCheck: old.lastCheck,
                    lastCheckOk: old.lastCheckOk,
                    lastCheckMessage: old.lastCheckMessage,
                    failStreak: old.failStreak,
                    deadAt: old.deadAt,
                    deadReason: old.deadReason,
                };
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

    /** 批量启停(全选/反选/全部停用): 一次落盘 */
    async setEnabledMany(patches: { id: string; enabled: boolean }[]): Promise<number> {
        if (!patches.length) { return 0; }
        return this._enqueue(async () => {
            const items = this._read();
            const byId = new Map(items.map((s) => [s.id, s]));
            let changed = 0;
            for (const patch of patches) {
                const target = byId.get(patch.id);
                if (!target || target.enabled === patch.enabled) { continue; }
                target.enabled = patch.enabled;
                changed++;
            }
            if (changed > 0) { await this._write(items); }
            return changed;
        });
    }

    /** 清除全部失效书源(删除数据), 返回删除条数 */
    async clearDead(): Promise<number> {
        return this._enqueue(async () => {
            const items = this._read();
            const kept = items.filter((s) => !isDead(s));
            const removed = items.length - kept.length;
            if (removed > 0) { await this._write(kept); }
            return removed;
        });
    }

    /** 恢复: 清失效标记与失败计数, 保留 lastCheck*(作为历史参考) */
    async revive(id: string): Promise<boolean> {
        return this._enqueue(async () => {
            const items = this._read();
            const target = items.find((s) => s.id === id);
            if (!target) { return false; }
            target.failStreak = 0;
            delete target.deadAt;
            delete target.deadReason;
            await this._write(items);
            return true;
        });
    }

    /**
     * 批量记录检查/搜索结果。
     *  - ok: 失败计数清零, 若原本失效则自动恢复
     *  - fail: 计数 +1, 达到阈值标失效
     * 一轮搜索只调用一次(一次落盘); 内容无变化时不写盘。
     */
    async recordResults(results: SourceResult[]): Promise<RecordOutcome> {
        if (!results.length) { return { died: [], revived: [], written: false }; }
        return this._enqueue(async () => {
            const items = this._read();
            const byId = new Map(items.map((s) => [s.id, s]));
            const died: string[] = [];
            const revived: string[] = [];
            const now = Date.now();
            let changed = false;
            for (const r of results) {
                const t = byId.get(r.id);
                if (!t) { continue; }
                const at = typeof r.at === 'number' ? r.at : now;
                const msg = (r.message || '').slice(0, 300);
                const wasDead = isDead(t);
                const prevStreak = failStreakOf(t);
                if (t.lastCheck !== at || t.lastCheckOk !== r.ok || t.lastCheckMessage !== msg) { changed = true; }
                t.lastCheck = at;
                t.lastCheckOk = r.ok;
                t.lastCheckMessage = msg;
                if (r.ok) {
                    if (prevStreak !== 0) { changed = true; }
                    t.failStreak = 0;
                    if (wasDead) {
                        delete t.deadAt;
                        delete t.deadReason;
                        revived.push(t.id);
                    }
                } else {
                    const next = prevStreak + 1;
                    if (next !== prevStreak) { changed = true; }
                    t.failStreak = next;
                    if (next >= FAIL_THRESHOLD && !wasDead) {
                        t.deadAt = at;
                        t.deadReason = msg;
                        died.push(t.id);
                    } else if (wasDead && msg && t.deadReason !== msg) {
                        t.deadReason = msg;
                    }
                }
            }
            if (changed || died.length || revived.length) { await this._write(items); }
            return { died, revived, written: changed || died.length > 0 || revived.length > 0 };
        });
    }

    /** 记录一次可用性检查结果 */
    async markCheck(id: string, ok: boolean, message: string): Promise<void> {
        await this.recordResults([{ id, ok, message }]);
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
                    byId.set(src.id, {
                        ...src,
                        enabled: old.enabled,
                        addedAt: old.addedAt,
                        lastCheck: old.lastCheck,
                        lastCheckOk: old.lastCheckOk,
                        lastCheckMessage: old.lastCheckMessage,
                        failStreak: old.failStreak,
                        deadAt: old.deadAt,
                        deadReason: old.deadReason,
                    });
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
                delete out.failStreak;
                delete out.deadAt;
                delete out.deadReason;
                return out;
            });
        return JSON.stringify(items, null, 2);
    }
}
