/**
 * online/searchService.ts — 多书源并发搜索
 *
 * 并发 6、单源超时 10s; 单源失败不影响其它源, 错误折叠返回给 UI。
 * 去重规则: 书名+作者相同视为同一本书, 保留书源列表里靠前的那条。
 */
import { BookSource, BookSourceStore } from '../bookSource';
import { HttpError } from '../http';
import { UnsupportedRuleError } from '../rules/evalRule';
import { mapLimit, withTimeout } from '../util/async';
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
    /** 因源上限未参与本次搜索的书源数 */
    skippedSources: number;
}

export interface SearchOptions {
    /** 只搜这些书源; 不传 = 全部启用 */
    sourceIds?: string[];
    page?: number;
    signal?: AbortSignal;
    /** 单源超时(默认 10s) */
    perSourceTimeoutMs?: number;
}

const CONCURRENCY = 6;
const PER_SOURCE_TIMEOUT = 10000;
const MAX_TOTAL = 300;
/**
 * 单次搜索的书源上限: 合集动辄上千个源, 全量并发既慢又容易被站点封。
 * 按用户书源顺序取前 100 个, 超出部分在 UI 提示(可用选择弹窗缩小范围)。
 */
const MAX_SOURCES_PER_SEARCH = 100;

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

    /** 取本次参与搜索的书源(按用户列表顺序) */
    pickSources(ids?: string[]): BookSource[] {
        const all = this.sources.enabled();
        if (!ids || ids.length === 0) { return all; }
        const set = new Set(ids);
        return all.filter((s) => set.has(s.id));
    }

    async search(key: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
        const keyword = (key || '').trim();
        if (!keyword) {
            return { items: [], errors: [], sourceCount: 0, truncated: false, skippedSources: 0 };
        }
        const picked = this.pickSources(opts.sourceIds);
        const list = picked.slice(0, MAX_SOURCES_PER_SEARCH);
        const skippedSources = Math.max(0, picked.length - list.length);
        const errors: SourceSearchError[] = [];
        const perSource = opts.perSourceTimeoutMs || PER_SOURCE_TIMEOUT;

        const batches = await mapLimit(list, CONCURRENCY, async (source) => {
            if (opts.signal?.aborted) {
                return { source, items: [] as SearchBookItem[], error: null as SourceSearchError | null };
            }
            const task = (async () => {
                const req = await buildSearchRequest(source, keyword, opts.page || 1, sandboxHttpFor(source, this.pool));
                const res = await fetchForSource(source, this.pool, req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body,
                    signal: opts.signal,
                });
                return parseSearchPage(source, res.text, res.url, sandboxHttpFor(source, this.pool));
            })();
            const result = await withTimeout(task, perSource);
            if (result.timedOut) {
                return {
                    source,
                    items: [] as SearchBookItem[],
                    error: { sourceId: source.id, sourceName: source.bookSourceName, kind: 'timeout', message: '搜索超时(' + Math.round(perSource / 1000) + 's)' },
                };
            }
            if (!result.ok || result.value === undefined) {
                const e = errorOf(result.error);
                return {
                    source,
                    items: [] as SearchBookItem[],
                    error: { sourceId: source.id, sourceName: source.bookSourceName, ...e },
                };
            }
            return { source, items: result.value as SearchBookItem[], error: null };
        });

        const merged: SearchBookItem[] = [];
        const seen = new Set<string>();
        let truncated = false;
        for (const batch of batches) {
            if (batch.error) { errors.push(batch.error); continue; }
            for (const item of batch.items) {
                const k = resultKey(item);
                if (seen.has(k)) { continue; }
                seen.add(k);
                if (merged.length >= MAX_TOTAL) { truncated = true; break; }
                merged.push(item);
            }
        }

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

        return { items: merged, errors, sourceCount: list.length, truncated, skippedSources };
    }
}
