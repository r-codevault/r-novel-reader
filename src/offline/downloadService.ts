/**
 * offline/downloadService.ts — 离线下载队列
 *
 * - 固定并发 3(README 承诺的上限: 搜索 6 / 下载 3)
 * - 暂停/继续/取消: 暂停立即中断在途请求, 恢复后接着跑(不重新算进度)
 * - 续传: 已下载的章直接跳过(done.log + ch-*.txt 为准), 失败章下次自动重试
 * - 单章失败不影响整体; 重试只针对可恢复错误(超时/网络/5xx)
 * - **源级节流**: 同一书源按最小间隔串起请求, 遇 503/429 自适应放慢并整队冷却。
 *   原因: 多数站点对「连续抓几十章」会返回 503(实测某站 0.5s/请求仍拦, 1s/请求全通),
 *   旧实现 3 并发硬冲 + 500ms 重试 → 整本一半章节直接被判失败。
 * - 连续多章被限流就整本停下(已下载的保留, 下次点下载自动续传), 不把 5000 章全记成失败
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

/**
 * 源级节流参数(默认值来自实测):
 *  - 平时不额外限速(保持历史速度), 健康站点完全无感
 *  - 一旦被 503/429 拦下: 间隔立刻拉到 1s, 并让整个书源冷却 4s
 *  - 之后每连续成功 20 章把间隔收窄 30%, 但**不低于 1s**(不再退回猛冲)
 *
 * 实测数据(某采集站, 3000 字/章): 3 并发猛冲 → 连抓 12 章后全量 503;
 * 0.5s/请求仍拦; 1s/请求 30/30 全通。旧实现 3 并发 + 500ms 重试 2 次
 * 只能拿到 55% 的章节, 剩下全被判失败 —— 这就是"整本下载成片失败"的根因。
 */
export const DOWNLOAD_BASE_INTERVAL = 0;
export const DOWNLOAD_MIN_INTERVAL = 1000;
export const DOWNLOAD_MAX_INTERVAL = 3000;
export const DOWNLOAD_COOLDOWN = 4000;
/** 被限流时额外重试次数(比普通重试多: 限流是"等一下就好", 不是错误) */
export const DOWNLOAD_RATE_RETRY = 6;
/** 连续这么多章都拿不到(限流重试也没用)就整本停下 */
export const DOWNLOAD_RATE_GIVE_UP = 3;

export interface PacingConfig {
    baseInterval: number;
    minInterval: number;
    maxInterval: number;
    cooldownMs: number;
    /** 限流专属重试次数 */
    rateRetry: number;
    /** 连续几章限流失败后整本早停 */
    rateGiveUp: number;
}

export const DEFAULT_PACING: PacingConfig = {
    baseInterval: DOWNLOAD_BASE_INTERVAL,
    minInterval: DOWNLOAD_MIN_INTERVAL,
    maxInterval: DOWNLOAD_MAX_INTERVAL,
    cooldownMs: DOWNLOAD_COOLDOWN,
    rateRetry: DOWNLOAD_RATE_RETRY,
    rateGiveUp: DOWNLOAD_RATE_GIVE_UP,
};

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
    /**
     * 非用户取消、也非单章失败造成的提前结束原因(目前只有"站点持续限流")。
     * 前端要把它原样展示给用户, 而不是说"N 章失败"。
     */
    abortedReason?: string;
}

export interface DownloadDeps {
    store: OfflineStore;
    /** 抓一章正文; signal 触发时应尽快抛错(阅读侧同一条链路) */
    fetchChapter: (chapter: OnlineChapter, ref: OnlineRef, signal: AbortSignal) => Promise<string[]>;
    concurrency?: number;
    retry?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
    /** 源级节流参数(单测里可调小, 免得等真时间) */
    pacing?: Partial<PacingConfig>;
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

/**
 * 「站点忙/限流」不算错误: 429 是明说, 503 是绝大多数采集站反爬的通用响应
 * (实测某站连续抓 12 章后开始 503, 停 5 秒即恢复)。这类要慢下来重试, 不能记失败。
 */
function isRateLimited(err: unknown): boolean {
    return err instanceof HttpError
        && err.kind === 'http'
        && (err.status === 429 || err.status === 503);
}

function shortMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.length > 160 ? raw.slice(0, 157) + '...' : raw;
}

/** 节流等待期间被暂停/取消打断时抛它, 由调用方按"未完成"处理(不算失败) */
class InterruptedError extends Error {
    constructor(public readonly reason: 'paused' | 'cancelled') {
        super(reason === 'paused' ? '已暂停' : '已取消');
        this.name = 'InterruptedError';
    }
}

/**
 * 单书源请求节流器。
 *
 * 目标不是"平均限速", 而是**先试着跑, 被拦了才退让**:
 * 健康站点按 base 间隔连续抓(几乎无感), 一旦收到 503/429 就
 * 翻倍间隔 + 全源冷却, 让所有 worker 一起等一下, 而不是各自猛撞。
 */
export class SourcePacer {
    private interval: number;
    /** 可持续间隔下限: 被反复拦会往上抬, 长时间干净再慢慢降回来 */
    private floor: number;
    private nextAt = 0;
    private blockedUntil = 0;
    /** 连续成功章数 */
    private streak = 0;
    /** "冷却结束后又被拦"的次数(用来判断 minInterval 是不是还不够慢) */
    private incidents = 0;

    constructor(private readonly cfg: PacingConfig) {
        this.interval = Math.max(0, cfg.baseInterval);
        this.floor = cfg.minInterval;
    }

    /** 当前请求间隔(ms), 供日志/测试断言 */
    public get currentInterval(): number { return this.interval; }

    /** 当前学到的可持续下限(诊断用) */
    public get currentFloor(): number { return this.floor; }

    /** 还要冷却多久(ms) */
    public get cooldownLeft(): number {
        return Math.max(0, this.blockedUntil - Date.now());
    }

    /**
     * 等到可以发下一个请求。
     * 等待期间若被暂停/取消立刻抛 InterruptedError —— 不能让人点了暂停还卡 20 秒。
     */
    public async gate(control: DownloadControl): Promise<void> {
        for (;;) {
            if (control.cancelled) { throw new InterruptedError('cancelled'); }
            if (control.paused) { throw new InterruptedError('paused'); }
            const now = Date.now();
            const at = Math.max(now, this.nextAt, this.blockedUntil);
            if (at <= now) {
                this.nextAt = now + this.interval;
                return;
            }
            // 切片等: 保证暂停/取消在 200ms 内响应
            await sleep(Math.min(at - now, 200));
        }
    }

    /** 成功一章: 持续干净就先把间隔收回来, 再慢慢把下限也降回去 */
    public reward(): void {
        this.streak += 1;
        // 收敛要快: 被拦一次会翻倍到 2s/4s, 不能靠"每 20 章降 30%"慢慢熬回来
        if (this.streak % 8 === 0 && this.interval > this.floor) {
            this.interval = Math.max(this.floor, Math.round(this.interval * 0.75));
        }
        // 跑了好一阵都没被拦 → 说明之前的"下限"过于保守, 每次只退 100ms
        if (this.streak % 40 === 0) {
            this.incidents = 0;
            this.floor = Math.max(this.cfg.minInterval, this.floor - 100);
        }
    }

    /** 被限流: 间隔翻倍 + 全源冷却(同一次拦截只翻一次倍) */
    public penalize(): void {
        const now = Date.now();
        // 3 个 worker 会在同一瞬间各收到一个 503; 那是**一次**拦截, 不能连翻三倍。
        // 冷却期内的后续 503 一律忽略, 冷却结束后再被拦才算新的一次。
        if (now < this.blockedUntil) { return; }
        this.streak = 0;
        this.incidents += 1;
        // 冷却之后还被拦 = 这个速率站方不接受, 把"下限"也抬上去,
        // 否则会一直在 1s ←→ 2s 之间来回抖(每次都白吃 4s 冷却)
        if (this.incidents >= 3) {
            this.incidents = 0;
            this.floor = Math.min(this.cfg.maxInterval, this.floor + 250);
        }
        const next = this.interval > 0 ? this.interval * 2 : this.floor;
        this.interval = Math.min(this.cfg.maxInterval, Math.max(this.floor, next));
        this.blockedUntil = now + this.cfg.cooldownMs;
    }
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
    /** 按书源复用节流器: 同一站点的多本书共享学习到的限速(重装/重启即重置) */
    private readonly pacers = new Map<string, SourcePacer>();

    constructor(private readonly deps: DownloadDeps) {}

    private pacerFor(sourceId: string): SourcePacer {
        let pacer = this.pacers.get(sourceId);
        if (!pacer) {
            const cfg: PacingConfig = { ...DEFAULT_PACING, ...(this.deps.pacing || {}) };
            pacer = new SourcePacer(cfg);
            this.pacers.set(sourceId, pacer);
        }
        return pacer;
    }

    /** 当前某书源的请求间隔(测试/诊断用) */
    public intervalOf(sourceId: string): number | undefined {
        return this.pacers.get(sourceId)?.currentInterval;
    }

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
        const pacing: PacingConfig = { ...DEFAULT_PACING, ...(this.deps.pacing || {}) };
        const pacer = this.pacerFor(task.ref.sourceId);
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
            // 进度回调是"宿主 -> webview"的旁路: 面板已关闭时 postMessage 会抛,
            // 绝不能让它污染下载统计(否则这几章会被算成失败)
            try {
                hooks.onProgress?.({
                    key: task.key, index, title,
                    done: doneCount, total, failed: failedCount,
                    added: justAdded ? [index] : [],
                });
            } catch { /* 回调异常不影响下载 */ }
        };

        // 暂停即时生效: 在途请求也要被打断(否则点了暂停还要干等 20s 超时),
        // 被打断的章由 processOne 放回队首, 恢复后重抓, 不计失败。
        const attemptOnce = async (chapter: OnlineChapter): Promise<string[]> => {
            const perAttempt = new AbortController();
            const link = combineSignals([control.signal, control.pauseSignal, perAttempt.signal]);
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

        /**
         * 取一章正文(带节流 + 两类重试):
         *  - 限流(503/429): 让书源整体放慢/冷却后重试, 预算比普通错误大得多
         *  - 普通可恢复错误(超时/网络/其它 5xx): 最多 retry 次, 间隔递增
         */
        const fetchWithRetry = async (chapter: OnlineChapter): Promise<string[]> => {
            let attempt = 0;
            let rateAttempt = 0;
            for (;;) {
                await pacer.gate(control);
                try {
                    const out = await attemptOnce(chapter);
                    pacer.reward();
                    return out;
                } catch (err) {
                    if (control.cancelled || control.paused) { throw err; }
                    if (isRateLimited(err)) {
                        pacer.penalize();
                        rateAttempt += 1;
                        if (rateAttempt > pacing.rateRetry) { throw err; }
                        continue;   // 冷却由 pacer.blockedUntil 承担, 回到 gate 等
                    }
                    if (attempt >= retry || !isRetryable(err)) { throw err; }
                    attempt += 1;
                    await sleep(retryDelay * attempt);
                    if (control.cancelled || control.paused) { throw err; }
                }
            }
        };

        let rateFailStreak = 0;
        let stopped = false;
        let abortedReason = '';

        const processOne = async (index: number): Promise<boolean> => {
            const chapter = task.chapters[index];
            if (!chapter) { return true; }
            try {
                const paragraphs = await fetchWithRetry(chapter);
                const bytes = await store.writeChapter(task.key, index, paragraphs);
                await store.markDone(task.key, index, bytes);
                doneCount += 1;
                added.push(index);
                rateFailStreak = 0;
                emit(index, chapter.title, true);
                return true;
            } catch (err) {
                if (err instanceof InterruptedError) {
                    if (err.reason === 'cancelled') { return false; }
                    pending.unshift(index);
                    return false;
                }
                if (control.cancelled) { return false; }
                if (control.paused) {
                    // 暂停打断的章不算失败: 放回队首, 恢复后重跑
                    pending.unshift(index);
                    return false;
                }
                failedCount += 1;
                failures.set(index, shortMessage(err));
                // 连着几章都是"限流重试也拿不到" → 站点在硬拦, 整本停下比硬冲更明智
                if (isRateLimited(err)) {
                    rateFailStreak += 1;
                    if (rateFailStreak >= pacing.rateGiveUp) {
                        stopped = true;
                        abortedReason = '站点持续限流（HTTP 503/429），已停止下载。已下载的章节会保留，稍后再点「下载」会从断点继续。';
                    }
                } else {
                    rateFailStreak = 0;
                }
                emit(index, chapter.title);
                return true;
            }
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                if (control.cancelled || control.paused || stopped) { return; }
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
            if (control.cancelled || stopped || pending.length === 0) { break; }
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
            ok: !control.cancelled && !abortedReason && failedCount === 0,
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
            abortedReason: abortedReason || undefined,
        };
        status.running = false;
        status.paused = false;
        return result;
    }
}
