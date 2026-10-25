/**
 * offline/downloadService.ts — 离线下载队列
 *
 * - 固定并发 3(README 承诺的上限: 搜索 6 / 下载 3)
 * - 暂停/继续/取消: 暂停立即中断在途请求, 恢复后接着跑(不重新算进度)
 * - 续传: 已下载的章直接跳过(done.log + ch-*.txt 为准), 失败章下次自动重试
 * - 单章失败不影响整体; 重试只针对可恢复错误(超时/网络/5xx)
 * - 不调用 bookSource.recordResults: 批量下载单站失败会误判书源失效
 *
 * 刻意不 import vscode: 只依赖 OfflineStore + 注入的 fetchChapter,
 * 这样 scripts/test-download-service.js 可以直接 require 编译产物做单测。
 */
import { HttpError } from '../http';
import { UnsupportedRuleError } from '../rules/evalRule';
import type { OnlineChapter } from '../online/onlineBook';
import type { OnlineRef } from '../onlinePath';
import { combineSignals, sleep } from '../util/async';
import type { OfflineStore } from './offlineStore';

export const DOWNLOAD_CONCURRENCY = 3;
export const DOWNLOAD_TIMEOUT = 20000;
/** 首次失败后再重试 2 次 */
export const DOWNLOAD_RETRY = 2;
export const DOWNLOAD_RETRY_DELAY = 500;

export interface DownloadTask {
    key: string;
    ref: OnlineRef;
    chapters: OnlineChapter[];
    bookTitle: string;
    author: string;
    /** 0 基, 含端点 */
    range: { start: number; end: number };
}

export interface DownloadProgressEvent {
    key: string;
    index: number;
    title: string;
    /** 范围内已下载章数(含本次之前就下好的) */
    done: number;
    total: number;
    failed: number;
    /** 本次新落盘的章号(通常是 [index]), 让 webview 增量点亮目录圆点 */
    added: number[];
}

export interface DownloadFailure {
    index: number;
    title: string;
    message: string;
}

export interface DownloadResult {
    key: string;
    ok: boolean;
    cancelled: boolean;
    done: number;
    total: number;
    failed: number;
    added: number[];
    failures: DownloadFailure[];
    durationMs: number;
}

export interface DownloadDeps {
    store: OfflineStore;
    /** 抓一章正文; signal 触发时应尽快抛错(阅读侧同一条链路) */
    fetchChapter: (chapter: OnlineChapter, ref: OnlineRef, signal: AbortSignal) => Promise<string[]>;
    concurrency?: number;
    retry?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
}

export interface DownloadHooks {
    onProgress?: (p: DownloadProgressEvent) => void;
    onDone?: (r: DownloadResult) => void;
}

export interface DownloadStatus {
    running: boolean;
    paused: boolean;
    done: number;
    total: number;
    failed: number;
}

/** 暂停/继续/取消(与 SearchControl 同一套语义) */
export class DownloadControl {
    public paused = false;
    public cancelled = false;
    private waiters: (() => void)[] = [];
    private readonly aborter = new AbortController();
    private pauseAborter = new AbortController();

    public get signal(): AbortSignal { return this.aborter.signal; }

    /** 暂停专用: 每次暂停换一个, 恢复时重建, 用来立刻打断在途请求 */
    public get pauseSignal(): AbortSignal { return this.pauseAborter.signal; }

    public pause(): void {
        if (this.cancelled || this.paused) { return; }
        this.paused = true;
        try { this.pauseAborter.abort(); } catch { /* 已中断 */ }
    }

    public resume(): void {
        this.paused = false;
        if (this.pauseAborter.signal.aborted) {
            this.pauseAborter = new AbortController();
        }
        const list = this.waiters;
        this.waiters = [];
        for (const fn of list) { fn(); }
    }

    public cancel(): void {
        this.cancelled = true;
        this.resume();
        try { this.pauseAborter.abort(); } catch { /* 已中断 */ }
        try { this.aborter.abort(); } catch { /* 已取消 */ }
    }

    public async waitIfPaused(): Promise<void> {
        while (this.paused && !this.cancelled) {
            await new Promise<void>((resolve) => { this.waiters.push(resolve); });
        }
    }
}

/** 可恢复错误才重试: 403/404 这类重试只会拿到更差的响应 */
function isRetryable(err: unknown): boolean {
    if (err instanceof HttpError) {
        if (err.kind === 'timeout' || err.kind === 'network') { return true; }
        if (err.kind === 'http') { return typeof err.status === 'number' && err.status >= 500; }
        return false; // badUrl / abort / tooLarge
    }
    if (err instanceof UnsupportedRuleError) { return false; }
    if ((err as { name?: string } | null)?.name === 'AbortError') { return false; }
    return false;
}

function shortMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.length > 160 ? raw.slice(0, 157) + '...' : raw;
}

interface RunningEntry {
    control: DownloadControl;
    status: DownloadStatus;
    done: Promise<DownloadResult>;
    /** 书名快照: webview 任务表要显示"哪本书在下", 不能只给 key */
    bookTitle: string;
}

export class DownloadService {
    private readonly running = new Map<string, RunningEntry>();

    constructor(private readonly deps: DownloadDeps) {}

    public isRunning(key: string): boolean {
        return this.running.has(key);
    }

    /**
     * 全部运行中任务的快照（按 key）。
     * 与 `statusOf` 的区别: 这是"全局视图", 供 webview 任务表使用,
     * 不依赖"当前打开的是哪本书"。
     */
    public snapshot(): {
        key: string;
        bookTitle: string;
        done: number;
        total: number;
        failed: number;
        running: boolean;
        paused: boolean;
    }[] {
        const out: {
            key: string;
            bookTitle: string;
            done: number;
            total: number;
            failed: number;
            running: boolean;
            paused: boolean;
        }[] = [];
        this.running.forEach((entry, key) => {
            out.push({
                key,
                bookTitle: entry.bookTitle,
                done: entry.status.done,
                total: entry.status.total,
                failed: entry.status.failed,
                running: entry.status.running,
                paused: entry.status.paused,
            });
        });
        return out;
    }

    public statusOf(key: string): DownloadStatus | undefined {
        const entry = this.running.get(key);
        return entry ? { ...entry.status } : undefined;
    }

    public start(task: DownloadTask, hooks: DownloadHooks = {}): { control: DownloadControl; done: Promise<DownloadResult> } {
        const existing = this.running.get(task.key);
        if (existing) { return { control: existing.control, done: existing.done }; }

        const control = new DownloadControl();
        const status: DownloadStatus = { running: true, paused: false, done: 0, total: 0, failed: 0 };
        // 结束回调放在**移出 running 之后**: 宿主在 onDone 里会同步查 statusOf/isRunning,
        // 若此时条目还在, 推到前端的快照会错报 running: true, 按钮停在「暂停」不变。
        const done = this._run(task, control, status, hooks).then(
            (result) => {
                this.running.delete(task.key);
                try { hooks.onDone?.(result); } catch { /* 回调异常不影响结果 */ }
                return result;
            },
            (err: unknown) => {
                this.running.delete(task.key);
                throw err;
            }
        );
        this.running.set(task.key, { control, status, done, bookTitle: task.bookTitle });
        return { control, done };
    }

    public pause(key: string): boolean {
        const entry = this.running.get(key);
        if (!entry || entry.control.cancelled) { return false; }
        entry.control.pause();
        entry.status.paused = true;
        return true;
    }

    public resume(key: string): boolean {
        const entry = this.running.get(key);
        if (!entry || entry.control.cancelled) { return false; }
        entry.control.resume();
        entry.status.paused = false;
        return true;
    }

    public cancel(key: string): void {
        const entry = this.running.get(key);
        if (!entry) { return; }
        entry.control.cancel();
    }

    public cancelAll(): void {
        for (const entry of this.running.values()) { entry.control.cancel(); }
    }

    // -------------------------------------------------------------- 内部

    private async _run(
        task: DownloadTask,
        control: DownloadControl,
        status: DownloadStatus,
        hooks: DownloadHooks = {}
    ): Promise<DownloadResult> {
        const store = this.deps.store;
        const width = Math.max(1, this.deps.concurrency ?? DOWNLOAD_CONCURRENCY);
        const retry = Math.max(0, this.deps.retry ?? DOWNLOAD_RETRY);
        const retryDelay = Math.max(0, this.deps.retryDelayMs ?? DOWNLOAD_RETRY_DELAY);
        const timeoutMs = Math.max(1000, this.deps.timeoutMs ?? DOWNLOAD_TIMEOUT);
        const startedAt = Date.now();

        // 目录快照先落盘: 之后即使书源没了也能导出/阅读
        await store.ensureManifest(task.key, {
            sourceId: task.ref.sourceId,
            sourceName: task.ref.sourceName,
            bookUrl: task.ref.bookUrl,
            bookTitle: task.bookTitle,
            author: task.author,
            tocUrl: task.ref.tocUrl || '',
            tocFetchedAt: task.ref.tocFetchedAt || Date.now(),
            chapters: task.chapters,
            totalChapters: task.chapters.length,
            range: [task.range.start, task.range.end],
        });

        const last = task.chapters.length - 1;
        const start = Math.min(Math.max(0, task.range.start), Math.max(0, last));
        const end = Math.min(Math.max(start, task.range.end), Math.max(0, last));
        const total = last < 0 ? 0 : end - start + 1;

        const st = await store.loadState(task.key);
        const inRange = new Set<number>();
        for (const idx of st.done) {
            if (idx >= start && idx <= end) { inRange.add(idx); }
        }

        let doneCount = inRange.size;
        let failedCount = 0;
        const added: number[] = [];
        const failures = new Map<number, string>();

        status.total = total;
        status.done = doneCount;

        const pending: number[] = [];
        for (let i = start; i <= end; i++) {
            if (!inRange.has(i)) { pending.push(i); }
        }

        const emit = (index: number, title: string, justAdded = false): void => {
            status.done = doneCount;
            status.failed = failedCount;
            hooks.onProgress?.({
                key: task.key, index, title,
                done: doneCount, total, failed: failedCount,
                added: justAdded ? [index] : [],
            });
        };

        const attemptOnce = async (chapter: OnlineChapter, signal: AbortSignal): Promise<string[]> => {
            const perAttempt = new AbortController();
            const link = combineSignals([signal, perAttempt.signal]);
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; try { perAttempt.abort(); } catch { /* 已中断 */ } }, timeoutMs);
            try {
                return await this.deps.fetchChapter(chapter, task.ref, link.signal);
            } catch (err) {
                if (timedOut) { throw new HttpError('timeout', '章节抓取超时'); }
                throw err;
            } finally {
                clearTimeout(timer);
                link.dispose();
            }
        };

        const fetchWithRetry = async (chapter: OnlineChapter): Promise<string[]> => {
            let attempt = 0;
            for (;;) {
                try {
                    return await attemptOnce(chapter, control.signal);
                } catch (err) {
                    if (control.cancelled || control.paused) { throw err; }
                    if (attempt >= retry || !isRetryable(err)) { throw err; }
                    attempt += 1;
                    await sleep(retryDelay * attempt);
                    if (control.cancelled || control.paused) { throw err; }
                }
            }
        };

        const processOne = async (index: number): Promise<boolean> => {
            const chapter = task.chapters[index];
            if (!chapter) { return true; }
            try {
                const paragraphs = await fetchWithRetry(chapter);
                const bytes = await store.writeChapter(task.key, index, paragraphs);
                await store.markDone(task.key, index, bytes);
                doneCount += 1;
                added.push(index);
                emit(index, chapter.title, true);
                return true;
            } catch (err) {
                if (control.cancelled) { return false; }
                if (control.paused) {
                    // 暂停打断的章不算失败: 放回队首, 恢复后重跑
                    pending.unshift(index);
                    return false;
                }
                failedCount += 1;
                failures.set(index, shortMessage(err));
                emit(index, chapter.title);
                return true;
            }
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                if (control.cancelled || control.paused) { return; }
                const index = pending.shift();
                if (index === undefined) { return; }
                const keepGoing = await processOne(index);
                if (!keepGoing) { return; }
            }
        };

        const drain = async (): Promise<void> => {
            await Promise.all(Array.from({ length: Math.min(width, Math.max(1, pending.length)) }, () => worker()));
        };

        // 暂停 → 挂起等待; 恢复(resume 唤醒 waiters)后回到循环顶部继续消费队列。
        //
        // 注意 `!paused && pending 非空` 这一支: 正常情况 drain 会把队列抽干,
        // 只有"drain 期间用户先暂停又立刻继续"才会落到这里 —— 必须再抽一轮,
        // 直接 break 会漏掉剩余章节。加一个次数上限纯粹是防退化成忙等。
        let spin = 0;
        for (;;) {
            await drain();
            if (control.cancelled || pending.length === 0) { break; }
            if (!control.paused) {
                spin += 1;
                if (spin > 50) { break; }
                continue;
            }
            await control.waitIfPaused();
            if (control.cancelled) { break; }
        }

        const failureRecord: Record<number, string> = {};
        for (const [idx, msg] of failures) { failureRecord[idx] = msg; }
        await store.setFailures(task.key, failureRecord);

        const result: DownloadResult = {
            key: task.key,
            ok: !control.cancelled && failedCount === 0,
            cancelled: control.cancelled,
            done: doneCount,
            total,
            failed: failedCount,
            added,
            failures: Array.from(failures, ([index, message]) => ({
                index,
                title: task.chapters[index]?.title || '',
                message,
            })).sort((a, b) => a.index - b.index),
            durationMs: Date.now() - startedAt,
        };
        status.running = false;
        status.paused = false;
        return result;
    }
}
