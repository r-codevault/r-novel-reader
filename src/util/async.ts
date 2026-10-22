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
