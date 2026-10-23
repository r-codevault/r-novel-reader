/**
 * rules/jsonPath.ts — JSONPath 子集(legado 的 JSON API 书源用)
 *
 * 支持: `$.a.b` `a.b` `$.list[0]` `$.list[-1]` `$.list[*].name`
 *       `$..name`(递归取键) `['key']` / `["key"]`
 * 不支持: 过滤表达式 `[?(@.x)]`、切片 `[0:2]`、函数 —— 抛 JsonPathError。
 */

export class JsonPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JsonPathError';
    }
}

type Seg =
    | { kind: 'key'; key: string }
    | { kind: 'index'; index: number }
    | { kind: 'slice'; start?: number; end?: number }
    | { kind: 'wildcard' }
    | { kind: 'recursive'; key: string };

export function parseJsonPath(path: string): Seg[] {
    const src = path.trim();
    if (!src) { throw new JsonPathError('JSONPath 为空'); }
    if (src.indexOf('[?') >= 0 || src.indexOf('[(') >= 0) {
        throw new JsonPathError('暂不支持 JSONPath 过滤表达式: ' + src);
    }
    const segs: Seg[] = [];
    let i = 0;
    if (src[i] === '$') { i++; }
    while (i < src.length) {
        const ch = src[i];
        if (ch === '.' && src[i + 1] === '.') {
            i += 2;
            let j = i;
            while (j < src.length && /[A-Za-z0-9_$.-]/.test(src[j]) && src[j] !== '.') { j++; }
            if (i === j) { throw new JsonPathError('递归键名为空: ' + src); }
            segs.push({ kind: 'recursive', key: src.slice(i, j) });
            i = j;
            continue;
        }
        if (ch === '.') {
            i++;
            if (src[i] === '*') { segs.push({ kind: 'wildcard' }); i++; continue; }
            let j = i;
            while (j < src.length && /[A-Za-z0-9_$-]/.test(src[j])) { j++; }
            if (i === j) { continue; } // 宽容: 结尾多一个点
            segs.push({ kind: 'key', key: src.slice(i, j) });
            i = j;
            continue;
        }
        if (ch === '[') {
            const end = src.indexOf(']', i);
            if (end < 0) { throw new JsonPathError('JSONPath 中括号未闭合: ' + src); }
            const body = src.slice(i + 1, end).trim();
            i = end + 1;
            if (body === '*') { segs.push({ kind: 'wildcard' }); continue; }
            if (/^-?\d+$/.test(body)) { segs.push({ kind: 'index', index: parseInt(body, 10) }); continue; }
            if (/^-?\d*:-?\d*$/.test(body)) {
                const parts = body.split(':');
                const start = parts[0] === '' ? undefined : parseInt(parts[0], 10);
                const end = parts[1] === '' ? undefined : parseInt(parts[1], 10);
                segs.push({ kind: 'slice', start, end });
                continue;
            }
            if ((body[0] === '"' || body[0] === "'") && body[body.length - 1] === body[0]) {
                segs.push({ kind: 'key', key: body.slice(1, -1) });
                continue;
            }
            throw new JsonPathError('无法解析的 JSONPath 片段: [' + body + ']');
        }
        if (ch === '*') { segs.push({ kind: 'wildcard' }); i++; continue; }
        // 无前缀的键名(legado 允许 "data.books")
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$-]/.test(src[j])) { j++; }
        if (i === j) { throw new JsonPathError('无法解析的 JSONPath: ' + src); }
        segs.push({ kind: 'key', key: src.slice(i, j) });
        i = j;
    }
    if (segs.length === 0) { throw new JsonPathError('JSONPath 为空: ' + src); }
    return segs;
}

function collectRecursive(value: unknown, key: string, out: unknown[], depth: number): void {
    if (depth > 20 || value === null || typeof value !== 'object') { return; }
    if (Array.isArray(value)) {
        for (const v of value) { collectRecursive(v, key, out, depth + 1); }
        return;
    }
    const obj = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, key)) { out.push(obj[key]); }
    for (const k of Object.keys(obj)) { collectRecursive(obj[k], key, out, depth + 1); }
}

/** 按路径求值, 返回所有命中值(标量也会被包成数组) */
export function queryJson(data: unknown, path: string): unknown[] {
    const segs = parseJsonPath(path);
    let cur: unknown[] = [data];
    for (const seg of segs) {
        const next: unknown[] = [];
        for (const v of cur) {
            if (v === null || v === undefined) { continue; }
            if (seg.kind === 'key') {
                if (typeof v === 'object' && !Array.isArray(v)) {
                    const obj = v as Record<string, unknown>;
                    if (Object.prototype.hasOwnProperty.call(obj, seg.key)) { next.push(obj[seg.key]); }
                }
            } else if (seg.kind === 'index') {
                if (Array.isArray(v)) {
                    const idx = seg.index < 0 ? v.length + seg.index : seg.index;
                    if (idx >= 0 && idx < v.length) { next.push(v[idx]); }
                }
            } else if (seg.kind === 'slice') {
                if (Array.isArray(v)) {
                    const len = v.length;
                    let start = seg.start === undefined ? 0 : seg.start;
                    let end = seg.end === undefined ? len : seg.end;
                    if (start < 0) { start += len; }
                    if (end < 0) { end += len; }
                    start = Math.max(0, Math.min(len, start));
                    end = Math.max(0, Math.min(len, end));
                    if (start < end) { next.push(...v.slice(start, end)); }
                }
            } else if (seg.kind === 'wildcard') {
                if (Array.isArray(v)) { next.push(...v); }
                else if (typeof v === 'object') {
                    const obj = v as Record<string, unknown>;
                    for (const k of Object.keys(obj)) { next.push(obj[k]); }
                }
            } else {
                collectRecursive(v, seg.key, next, 0);
            }
        }
        cur = next;
        if (cur.length === 0) { break; }
    }
    return cur;
}

/** 取第一个标量值(对象/数组用 JSON 字符串兜底) */
export function firstScalar(values: unknown[]): string {
    for (const v of values) {
        if (v === null || v === undefined) { continue; }
        if (typeof v === 'string') { return v; }
        if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
        if (Array.isArray(v) && v.length && typeof v[0] !== 'object') { return String(v[0]); }
    }
    return '';
}
