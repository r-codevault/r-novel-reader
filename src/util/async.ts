/**
 * util/async.ts — 并发控制小工具(书源搜索/下载共用)
 */

/** 以固定并发度执行, 保持结果顺序; 单个失败不会中断整体(由回调自行决定) */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    const width = Math.max(1, Math.min(limit, items.length || 1));
    let cursor = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) { return; }
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: width }, () => worker()));
    return results;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CombinedSignal {
    signal: AbortSignal;
    /** 请求结束后调用, 摘掉监听(避免长会话里监听器堆积) */
    dispose: () => void;
}

/**
 * 合并多个中断信号: 任一触发即整体中断。
 * (不直接用 AbortSignal.any: 旧版 Node/VSCode 里没有, 自己要能兜底)
 */
export function combineSignals(signals: (AbortSignal | undefined | null)[]): CombinedSignal {
    const valid = signals.filter((s): s is AbortSignal => !!s);
    if (valid.length === 0) {
        return { signal: new AbortController().signal, dispose: () => { /* 无监听 */ } };
    }
    if (valid.length === 1) {
        return { signal: valid[0], dispose: () => { /* 无监听 */ } };
    }
    const ctrl = new AbortController();
    const onAbort = (): void => { ctrl.abort(); };
    for (const s of valid) {
        if (s.aborted) { ctrl.abort(); break; }
        s.addEventListener('abort', onAbort);
    }
    return {
        signal: ctrl.signal,
        dispose: () => { for (const s of valid) { s.removeEventListener('abort', onAbort); } },
    };
}

/**
 * 同一 key 的并发调用只真正执行一次, 其余调用共享同一个 Promise。
 *
 * 用途: 阅读器按需加载某章时, 下载队列可能正好也在抓同一章 ——
 * 没有这层去重会对同一 URL 发两次请求, 既浪费流量也可能触发站点限流。
 */
export class SingleFlight<K, V> {
    private readonly inflight = new Map<K, Promise<V>>();

    public run(key: K, fn: () => Promise<V>): Promise<V> {
        const existing = this.inflight.get(key);
        if (existing) { return existing; }
        const task: Promise<V> = (async () => fn())();
        this.inflight.set(key, task);
        // 同时挂 then/catch: 既清理条目, 也让无人 await 的失败不会变成 unhandledRejection
        const cleanup = (): void => {
            if (this.inflight.get(key) === task) { this.inflight.delete(key); }
        };
        task.then(cleanup, cleanup);
        return task;
    }

    public get size(): number { return this.inflight.size; }
}

export interface TimeoutResult<T> {
    ok: boolean;
    value?: T;
    timedOut: boolean;
    error?: unknown;
}

/** 给一个 Promise 套超时(不取消原任务, 只让调用方拿到超时结果) */
export async function withTimeout<T>(task: Promise<T>, ms: number): Promise<TimeoutResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TimeoutResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    });
    const settle = task.then((value) => ({ ok: true, timedOut: false, value } as TimeoutResult<T>))
        .catch((error) => ({ ok: false, timedOut: false, error } as TimeoutResult<T>));
    const result = await Promise.race([settle, timeout]);
    if (timer) { clearTimeout(timer); }
    return result;
}
