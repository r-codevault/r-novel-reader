/**
 * online/searchService.ts — 多书源并发搜索
 *
 * - 不做书源数量上限: 用户勾了多少就搜多少
 * - 支持暂停/继续/取消(SearchControl): 暂停时不再启动新源, 已在途的完成
 * - 结果分批流式回传(onBatch), 上千个源时也能先看到结果
 * - 单源失败不影响其它源; 一轮搜索只写一次盘
 */
import { BookSource, BookSourceStore, SourceResult } from '../bookSource';
import { HttpError } from '../http';
import { UnsupportedRuleError } from '../rules/evalRule';
import { withTimeout } from '../util/async';
import { buildSearchRequest } from './searchUrl';
import { parseSearchPage, relevanceScore, resultKey, SearchBookItem } from './ruleApply';
import { fetchForSource, sandboxHttpFor, SourceHttpPool } from './sourceHttp';

export interface SourceSearchError {
    sourceId: string;
    sourceName: string;
    kind: string;
    message: string;
}

export interface SearchOutcome {
    items: SearchBookItem[];
    errors: SourceSearchError[];
    /** 实际参与搜索的书源数 */
    sourceCount: number;
    /** 结果条数被截断 */
    truncated: boolean;
    /** 因源上限未参与本次搜索的书源数(已不做上限, 恒为 0, 保留兼容) */
    skippedSources: number;
    /** 本次回写结果的书源数 */
    recorded: number;
    /** 本次新标记失效的书源 id */
    deadAdded: string[];
    /** 本次自动恢复的书源 id */
    revived: string[];
}

/** 搜索进度(每完成一个源推一次) */
export interface SearchProgress {
    done: number;
    total: number;
    sourceName: string;
    ok: boolean;
    failed: number;
}

/** 流式结果: 每凑够一批或结束时回传新增部分 */
export interface SearchBatch {
    items: SearchBookItem[];
    errors: SourceSearchError[];
}

export interface SearchHooks {
    onProgress?: (p: SearchProgress) => void;
    onBatch?: (b: SearchBatch) => void;
}

export interface SearchOptions extends SearchHooks {
    /** 只搜这些书源; 不传 = 全部启用 */
    sourceIds?: string[];
    page?: number;
    signal?: AbortSignal;
    /** 单源超时(默认 10s) */
    perSourceTimeoutMs?: number;
    /** 暂停/继续/取消控制器 */
    control?: SearchControl;
}

/** 暂停/继续/取消: 搜索过程中由 UI 控制 */
export class SearchControl {
    public paused = false;
    public cancelled = false;
    private waiters: (() => void)[] = [];
    private readonly aborter = new AbortController();

    public get signal(): AbortSignal { return this.aborter.signal; }

    public pause(): void {
        if (this.cancelled) { return; }
        this.paused = true;
    }

    public resume(): void {
        this.paused = false;
        const list = this.waiters;
        this.waiters = [];
        for (const fn of list) { fn(); }
    }

    /** 取消: 停止发起新请求, 中断在途请求 */
    public cancel(): void {
        this.cancelled = true;
        this.resume();
        try { this.aborter.abort(); } catch { /* 已取消 */ }
    }

    /** 暂停时挂起等待(取消会立即放行) */
    public async waitIfPaused(): Promise<void> {
        while (this.paused && !this.cancelled) {
            await new Promise<void>((resolve) => { this.waiters.push(resolve); });
        }
    }
}

const CONCURRENCY = 6;
const PER_SOURCE_TIMEOUT = 10000;
/** 结果总数上限(不是书源数): 防止上万源时内存/渲染爆掉 */
const MAX_TOTAL = 1000;
/** 每完成多少个源回传一批结果 */
const FLUSH_EVERY = 8;

function errorOf(err: unknown): { kind: string; message: string } {
    if (err instanceof UnsupportedRuleError) {
        return { kind: 'unsupported', message: err.message };
    }
    if (err instanceof HttpError) {
        return { kind: err.kind, message: err.message };
    }
    const message = (err as Error)?.message || String(err);
    return { kind: 'rule', message };
}

export class SearchService {
    constructor(
        private readonly sources: BookSourceStore,
        private readonly pool: SourceHttpPool = new SourceHttpPool()
    ) {}

    /** 取本次参与搜索的书源(按用户列表顺序): 已启用且未失效 */
    pickSources(ids?: string[]): BookSource[] {
        const all = this.sources.searchable();
        if (!ids || ids.length === 0) { return all; }
        const set = new Set(ids);
        return all.filter((s) => set.has(s.id));
    }

    async search(key: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
        const keyword = (key || '').trim();
        if (!keyword) {
            return {
                items: [], errors: [], sourceCount: 0, truncated: false,
                skippedSources: 0, recorded: 0, deadAdded: [], revived: [],
            };
        }
        const list = this.pickSources(opts.sourceIds);
        const total = list.length;
        const control = opts.control;
        const signal = control ? control.signal : opts.signal;
        const errors: SourceSearchError[] = [];
        const outcomes: SourceResult[] = [];
        const perSource = opts.perSourceTimeoutMs || PER_SOURCE_TIMEOUT;

        const merged: SearchBookItem[] = [];
        const keyIndex = new Map<string, number>();
        const sourceOrder = new Map(list.map((s, i) => [s.id, i]));
        let truncated = false;
        let done = 0;
        let failed = 0;
        let sinceFlush = 0;
        let pendingItems: SearchBookItem[] = [];
        let pendingErrors: SourceSearchError[] = [];

        const flush = (): void => {
            if (!pendingItems.length && !pendingErrors.length) { return; }
            opts.onBatch?.({ items: pendingItems, errors: pendingErrors });
            pendingItems = [];
            pendingErrors = [];
            sinceFlush = 0;
        };

        /**
         * 合并一条结果: 同一本书(书名+作者)只留书源顺序靠前的那条。
         * 并发下到达顺序不定, 用源顺序比较, 保证最终结果稳定。
         */
        const absorb = (item: SearchBookItem): void => {
            const k = resultKey(item);
            const order = sourceOrder.get(item.sourceId) ?? 999;
            const existing = keyIndex.get(k);
            if (existing !== undefined) {
                const old = merged[existing];
                const oldOrder = sourceOrder.get(old.sourceId) ?? 999;
                if (order < oldOrder) {
                    merged[existing] = item;
                    pendingItems.push(item);
                }
                return;
            }
            if (merged.length >= MAX_TOTAL) { truncated = true; return; }
            keyIndex.set(k, merged.length);
            merged.push(item);
            pendingItems.push(item);
        };

        const cancelled = (): boolean => control?.cancelled === true;

        const runOne = async (source: BookSource): Promise<void> => {
            if (cancelled()) { return; }
            const task = (async () => {
                const req = await buildSearchRequest(source, keyword, opts.page || 1, sandboxHttpFor(source, this.pool));
                const res = await fetchForSource(source, this.pool, req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body,
                    signal,
                });
                return parseSearchPage(source, res.text, res.url, sandboxHttpFor(source, this.pool));
            })();
            const result = await withTimeout(task, perSource);
            if (cancelled()) { return; }

            let ok = false;
            if (result.timedOut) {
                const message = '搜索超时(' + Math.round(perSource / 1000) + 's)';
                outcomes.push({ id: source.id, ok: false, message });
                const err = { sourceId: source.id, sourceName: source.bookSourceName, kind: 'timeout', message };
                errors.push(err);
                pendingErrors.push(err);
            } else if (!result.ok || result.value === undefined) {
                const e = errorOf(result.error);
                // 用户取消(abort)不算书源失败
                if (e.kind !== 'abort') { outcomes.push({ id: source.id, ok: false, message: e.message }); }
                const err = { sourceId: source.id, sourceName: source.bookSourceName, ...e };
                errors.push(err);
                if (e.kind !== 'abort') { pendingErrors.push(err); }
                ok = e.kind === 'abort';
            } else {
                const items = result.value as SearchBookItem[];
                outcomes.push({ id: source.id, ok: true, message: items.length ? '命中 ' + items.length + ' 条' : '可请求, 但未命中结果' });
                for (const item of items) { absorb(item); }
                ok = true;
            }

            done += 1;
            if (!ok) { failed += 1; }
            sinceFlush += 1;
            opts.onProgress?.({ done, total, sourceName: source.bookSourceName, ok, failed });
            if (sinceFlush >= FLUSH_EVERY) { flush(); }
        };

        // 自定义调度: 支持暂停(不启动新源)与取消
        let next = 0;
        const worker = async (): Promise<void> => {
            while (!cancelled()) {
                if (control) { await control.waitIfPaused(); }
                if (cancelled()) { return; }
                const idx = next++;
                if (idx >= list.length) { return; }
                await runOne(list[idx]);
            }
        };
        const workers = Math.max(1, Math.min(CONCURRENCY, list.length));
        await Promise.all(Array.from({ length: workers }, () => worker()));
        flush();

        // 相关性排序 + 书源顺序保持
        const order = new Map(list.map((s, i) => [s.id, i]));
        merged.sort((a, b) => {
            const sa = relevanceScore(a.title, keyword);
            const sb = relevanceScore(b.title, keyword);
            if (sa !== sb) { return sa - sb; }
            const oa = order.get(a.sourceId) ?? 999;
            const ob = order.get(b.sourceId) ?? 999;
            return oa - ob;
        });

        // 一轮搜索只写一次盘: 累计失败 / 自动判失效 / 成功后自动恢复
        const rec = await this.sources.recordResults(outcomes);

        return {
            items: merged,
            errors,
            sourceCount: list.length,
            truncated,
            skippedSources: 0,
            recorded: outcomes.length,
            deadAdded: rec.died,
            revived: rec.revived,
        };
    }
}
