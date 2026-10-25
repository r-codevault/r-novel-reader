/**
 * shelfRefresh.ts — 「刷新书架」的预演(plan) / 执行(apply) 纯函数。
 *
 * 为什么拆出来：原先这段逻辑直接写在 extension.ts 里，边扫描边写盘，中途不可取消、
 * 也无法在执行前告诉用户"到底会发生什么"。两阶段才能满足 PRD R7-05 / Q9 / Q10：
 *   预演(planShelfRefresh) —— 只读盘，产出分类清单 + planId，不产生任何写入；
 *   执行(applyShelfRefresh) —— 只按 plan 逐项执行，并回报每一项的成败。
 *
 * **本文件不 import vscode**（fs 以接口注入），所以可以直接被 node 单测
 * (scripts/test-shelf-refresh.js) 驱动。
 *
 * 「清理失效」的判定是重点：只有 `probe()` 报 **ENOENT** 才算"文件真的没了"。
 * EACCES/EPERM/EBUSY/EMFILE/未知 一律进 `inaccessible` 且**不清理** ——
 * 用 fs.existsSync() 会把"权限不足"也当成 false，正是要禁止的"暂时不可访问 ≠ 已删除"。
 */

import { shelfBookKey, planDuplicateRemoval, type ShelfBookLike } from './shelfMaintenance';
import type { ShelfRefreshPlan, ShelfRefreshResult } from './protocol';

/** 探测结果: null = 存在且可访问; 其余为错误码 */
export type ProbeCode = null | 'ENOENT' | 'EACCES' | 'EPERM' | 'EBUSY' | 'EMFILE' | 'UNKNOWN';

export interface FsProbe {
    readdir(dir: string): Promise<{ name: string; isFile(): boolean }[]>;
    readFile(p: string): Promise<Buffer>;
    /** 返回 null = 存在且可访问; 返回错误码 = 不可访问（只有 ENOENT 允许清理） */
    probe(p: string): Promise<ProbeCode>;
    /**
     * 同步存在性判断。
     * `planDuplicateRemoval()` 是同步纯函数，需要一个同步的"文件存在"谓词；
     * 这里单独提供，语义与 `fs.existsSync` 一致（**不用于清理判定**）。
     */
    exists(p: string): boolean;
}

/** 执行阶段需要的书架写入能力（由 extension 注入 ShelfStore 适配器） */
export interface ShelfApplyApi {
    list(): ShelfBookLike[];
    upsert(book: { filePath: string; title: string; author: string; totalChapters: number }): Promise<void>;
    remove(filePath: string): Promise<void>;
}

export interface PlanInput {
    /** 书库目录 */
    dir: string;
    /** 当前书架条目（含只读字段，apply 时需要 author/totalChapters） */
    shelf: ShelfBookLike[];
    fs: FsProbe;
    /** 目录内文件是否属于书库目录（注入以便单测） */
    isInsideDir: (filePath: string, dir: string) => boolean;
    decode(buf: Buffer): { text: string; encoding: string };
    parse(text: string, path: string, enc: string): { bookTitle: string; author: string; chapters: unknown[] };
    deriveTitleAuthor(path: string, author: string): { bookTitle: string; author: string };
    /** 预演编号（宿主侧单调递增，用于 apply 时的过期校验） */
    planId: number;
}

/** 取文件名（不依赖 node:path，便于测试与浏览器侧复用） */
function baseName(p: string): string {
    return (p || '').replace(/^.*[\\/]/, '');
}

/**
 * 预演：只读盘，产出"将要发生什么"的分类清单。
 *
 * 计数口径与旧实现逐条对齐（add / skipDuplicate / merge / retitle / prune），
 * 唯一的行为修正是 `prune` 只认 ENOENT，其余不可访问一律降级为 inaccessible。
 */
export async function planShelfRefresh(input: PlanInput): Promise<ShelfRefreshPlan> {
    const plan: ShelfRefreshPlan = {
        planId: input.planId,
        dir: input.dir,
        scanned: 0,
        add: [],
        skipDuplicate: [],
        merge: [],
        retitle: [],
        prune: [],
        inaccessible: [],
        warnings: [],
    };

    // ---- 1) 枚举书库目录 ----
    let names: string[] = [];
    try {
        const entries = await input.fs.readdir(input.dir);
        names = entries
            .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.txt'))
            .map((d) => input.dir.replace(/[\\/]+$/, '') + '/' + d.name);
    } catch (err) {
        // 目录整体不可读: 没有任何可靠信息, 只能全部清空并让用户重试
        plan.warnings.push(
            '读取书库目录失败：' +
            (err instanceof Error ? err.message : String(err)) +
            '（暂时无法访问，本次不做任何改动）'
        );
        return plan;
    }
    plan.scanned = names.length;

    // ---- 2) 待补录: 路径未登记 && 同书键未登记 ----
    const known = new Set(input.shelf.map((b) => b.filePath.toLowerCase()));
    const knownKeys = new Set(input.shelf.map((b) => shelfBookKey(b.title, b.author, b.totalChapters)));
    for (const file of names) {
        if (known.has(file.toLowerCase())) {
            continue;
        }
        try {
            const buf = await input.fs.readFile(file);
            const { text, encoding } = input.decode(buf);
            const novel = input.parse(text, file, encoding);
            const key = shelfBookKey(novel.bookTitle, novel.author, novel.chapters.length);
            if (knownKeys.has(key)) {
                // 同一本书已经在书架里(哪怕文件路径不同): 跳过, 避免重复出现
                plan.skipDuplicate.push(file);
                continue;
            }
            plan.add.push({
                filePath: file,
                title: novel.bookTitle,
                author: novel.author,
                totalChapters: novel.chapters.length,
            });
            knownKeys.add(key);
        } catch (err) {
            // 单个文件解析失败: 跳过, 不影响其余（与旧实现一致）
            plan.warnings.push(
                '「' + baseName(file) + '」解析失败，已跳过：' +
                (err instanceof Error ? err.message : String(err))
            );
        }
    }

    // ---- 3) 书名纠偏: 仅当文件名含《书名》且文件**确实存在且可访问**时才改 ----
    for (const b of input.shelf) {
        if (!input.isInsideDir(b.filePath, input.dir)) {
            continue;
        }
        // probe 非 null = 不存在或不可访问 -> 一律不改（不改"看不见的文件"的记录）
        if ((await input.fs.probe(b.filePath)) !== null) {
            continue;
        }
        if (!/《[^》]{1,60}》/.test(baseName(b.filePath))) {
            continue;
        }
        const derived = input.deriveTitleAuthor(b.filePath, '');
        if (derived.bookTitle !== b.title || derived.author !== b.author) {
            plan.retitle.push({
                filePath: b.filePath,
                from: b.title,
                to: derived.bookTitle,
                author: derived.author,
                totalChapters: b.totalChapters,
            });
        }
    }

    // ---- 4) 合并同书重复记录(只删记录, 不动文件) ----
    const dupPlans = planDuplicateRemoval(
        input.shelf,
        input.dir,
        (p) => input.fs.exists(p),
        input.isInsideDir
    );
    for (const dup of dupPlans) {
        plan.merge.push({
            keep: dup.keep.filePath,
            removals: dup.removals.map((b) => b.filePath),
        });
    }

    // ---- 5) 清理失效: **只有 ENOENT** 才算已删除 ----
    const removedByMerge = new Set<string>();
    for (const m of plan.merge) {
        for (const p of m.removals) { removedByMerge.add(p); }
    }
    for (const b of input.shelf) {
        if (!input.isInsideDir(b.filePath, input.dir)) {
            continue;
        }
        // 已被"合并"覆盖的记录不重复清理（否则计数会重复）
        if (removedByMerge.has(b.filePath)) {
            continue;
        }
        const code = await input.fs.probe(b.filePath);
        if (code === null) {
            continue;
        }
        if (code === 'ENOENT') {
            plan.prune.push({ filePath: b.filePath, title: b.title });
        } else {
            plan.inaccessible.push({ filePath: b.filePath, reason: code });
        }
    }
    if (plan.inaccessible.length > 0) {
        plan.warnings.push(
            plan.inaccessible.length + ' 个文件暂时无法访问（' +
            plan.inaccessible.map((x) => x.reason).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('/') +
            '），本次不做清理'
        );
    }
    return plan;
}

/**
 * 执行：只按 plan 逐项执行。
 *
 * 单条失败不影响其余项（与旧实现一致），但会被记入 `failed`，
 * 让 webview 能给出"部分成功"的准确数字而不是笼统报错。
 */
export async function applyShelfRefresh(
    plan: ShelfRefreshPlan,
    api: ShelfApplyApi
): Promise<ShelfRefreshResult> {
    const result: ShelfRefreshResult = {
        planId: plan.planId,
        added: 0,
        skippedDup: plan.skipDuplicate.length,
        merged: 0,
        retitled: 0,
        pruned: 0,
        failed: [],
    };
    const fail = (filePath: string, err: unknown): void => {
        result.failed.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    };

    for (const a of plan.add) {
        try {
            await api.upsert(a);
            result.added += 1;
        } catch (err) {
            fail(a.filePath, err);
        }
    }

    // retitle 需要的 author/totalChapters: 用执行时的书架快照兜住（预演之后可能被别处改过）
    const current = new Map(api.list().map((b) => [b.filePath, b]));
    for (const r of plan.retitle) {
        const live = current.get(r.filePath);
        const author = r.author !== undefined ? r.author : (live ? live.author : '');
        const totalChapters = r.totalChapters !== undefined ? r.totalChapters : (live ? live.totalChapters : 0);
        if (!live) {
            // 预演之后这条记录已被删除: 记差异而不是硬写
            result.failed.push({ filePath: r.filePath, error: '记录已不存在' });
            continue;
        }
        try {
            await api.upsert({ filePath: r.filePath, title: r.to, author, totalChapters });
            result.retitled += 1;
        } catch (err) {
            fail(r.filePath, err);
        }
    }

    for (const m of plan.merge) {
        for (const p of m.removals) {
            try {
                await api.remove(p);
                result.merged += 1;
            } catch (err) {
                fail(p, err);
            }
        }
    }

    for (const p of plan.prune) {
        try {
            await api.remove(p.filePath);
            result.pruned += 1;
        } catch (err) {
            fail(p.filePath, err);
        }
    }

    if (result.failed.length > 0) {
        result.driftNote = result.failed.length + ' 项未能执行，其余已完成（可再次刷新重试）';
    }
    return result;
}

/**
 * 把预演计划压成给确认框看的几行文字。
 *
 * 规定（PRD R7-01 的一致性要求）：至少含"数量 + 对象名"，
 * 清理/不可访问必须写清"会不会删东西"，让用户在点确认前就知道后果。
 */
export function summarizePlan(plan: ShelfRefreshPlan): string[] {
    const lines: string[] = [];
    lines.push('书库：' + (plan.dir || '（未设置）') + '（扫描到 ' + plan.scanned + ' 个 txt）');
    lines.push(
        '将新增 ' + plan.add.length + ' 本 / 跳过重复副本 ' + plan.skipDuplicate.length +
        ' 个 / 合并重复记录 ' + plan.merge.reduce(function (n, m) { return n + m.removals.length; }, 0) +
        ' 条 / 修正书名 ' + plan.retitle.length + ' 条 / 清理失效记录 ' + plan.prune.length + ' 条'
    );
    if (plan.inaccessible.length > 0) {
        lines.push('⚠ ' + plan.inaccessible.length + ' 个文件暂时无法访问，本次不做清理（不会删任何东西）');
    }
    if (plan.prune.length > 0) {
        const names = plan.prune.slice(0, 3).map(function (p) { return p.title; }).join('、');
        lines.push('将被清理的书架记录：' + names + (plan.prune.length > 3 ? ' 等 ' + plan.prune.length + ' 条' : ''));
    }
    lines.push('只改动书架记录，不会删除书库里的 txt 文件。');
    for (const w of plan.warnings) { lines.push('注意：' + w); }
    return lines;
}
