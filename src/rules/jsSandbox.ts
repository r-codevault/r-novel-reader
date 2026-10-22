/**
 * rules/jsSandbox.ts — `@js:` 规则的执行沙箱
 *
 * 用 Node `vm` 执行书源里的 JS 片段, 并 polyfill legado 常用的 `java.*` API。
 *
 * 重要说明:
 *  - `vm` **不是安全边界**, 它只挡住 require/process 这类误伤与死循环(timeout)。
 *    导入第三方书源 = 信任该书源作者。UI 与 README 都会明确这一点。
 *  - legado 脚本是同步执行的(Rhino 会阻塞等待网络), 而 Node 的 fetch 是异步的。
 *    这里用「占位符 + 重放」策略: 脚本第一遍跑时 `java.ajax` 返回空串并记录待请求
 *    URL, 跑完后批量请求并缓存, 再重跑脚本; 最多 3 轮, 足以覆盖常见的
 *    「先取 token 再拼 URL」写法。
 */
import * as vm from 'vm';
import * as crypto from 'crypto';

export interface SandboxHttp {
    /** 返回响应文本; 失败应抛错 */
    ajax(url: string): Promise<string>;
}

export interface SandboxOptions {
    baseUrl: string;
    key?: string;
    page?: number;
    book?: Record<string, unknown>;
    sourceName?: string;
    http?: SandboxHttp;
    /** 运行前的变量表(legado 的 source.variable / book 等) */
    vars?: Record<string, string>;
    /** 额外全局变量(JSON 列表项的字段, 如 book_id) */
    globals?: Record<string, unknown>;
    timeoutMs?: number;
}

export class JsSandboxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JsSandboxError';
    }
}

/** 常用的未实现 API 清单: 命中时给出明确提示, 便于后续按需补 polyfill */
const UNSUPPORTED = [
    'base64DecodeToByteArray', 'androidId', 'downloadFile', 'importScript', 'webView',
    'startBrowser', 'startBrowserAwait', 'getWebViewUA', 'htmlFormat', 'strToBytes',
    'bytesToStr', 'hexDecodeToString', 'hexEncodeToString', 't2s', 's2t', 'toast',
];

function md5(s: string): string {
    return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function hmacHex(algo: 'sha1' | 'sha256' | 'md5', data: string, key: string): string {
    return crypto.createHmac(algo, key).update(data, 'utf8').digest('hex');
}

function timeFormat(ms: number, fmt?: string): string {
    const d = new Date(ms);
    const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
    const map: Record<string, string> = {
        yyyy: String(d.getFullYear()),
        MM: pad(d.getMonth() + 1),
        dd: pad(d.getDate()),
        HH: pad(d.getHours()),
        mm: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
    };
    const pattern = fmt || 'yyyy/MM/dd HH:mm';
    return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (m) => map[m] || m);
}

function toPrimitive(v: unknown): string {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'string') { return v; }
    if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * 执行一段 `@js:` 脚本并返回字符串结果。
 * 脚本可以是单个表达式, 也可以是语句列表(取最后一条表达式的值)。
 */
export async function runJsScript(script: string, opts: SandboxOptions): Promise<string> {
    const timeout = opts.timeoutMs || 3000;
    const ajaxCache = new Map<string, string>();
    const vars = new Map<string, string>(Object.entries(opts.vars || {}));
    const pending: string[] = [];
    const logs: string[] = [];

    const collect = (url: string): string => {
        const u = String(url || '');
        if (!u) { return ''; }
        const cached = ajaxCache.get(u);
        if (cached !== undefined) { return cached; }
        if (pending.indexOf(u) < 0) { pending.push(u); }
        return '';
    };

    const sandbox: Record<string, unknown> = {
        key: opts.key || '',
        page: opts.page === undefined ? 1 : opts.page,
        baseUrl: opts.baseUrl || '',
        result: '',
        book: opts.book || {},
        source: {
            bookSourceName: opts.sourceName || '',
            getKey: () => opts.key || '',
            getVariable: () => '',
            setVariable: () => '',
        },
        console: {
            log: (...args: unknown[]) => { logs.push(args.map(toPrimitive).join(' ')); },
        },
        java: {
            ajax: (url: unknown) => collect(toPrimitive(url)),
            ajaxAll: () => '',
            connect: (url: unknown) => collect(toPrimitive(url)),
            put: (k: unknown, v: unknown) => { vars.set(toPrimitive(k), toPrimitive(v)); },
            get: (k: unknown) => vars.get(toPrimitive(k)) || '',
            log: (...args: unknown[]) => { logs.push(args.map(toPrimitive).join(' ')); },
            md5Encode: (s: unknown) => md5(toPrimitive(s)),
            md5Encode16: (s: unknown) => md5(toPrimitive(s)).slice(8, 24),
            base64Encode: (s: unknown) => Buffer.from(toPrimitive(s), 'utf8').toString('base64'),
            base64Decode: (s: unknown) => Buffer.from(toPrimitive(s), 'base64').toString('utf8'),
            encodeURI: (s: unknown) => encodeURIComponent(toPrimitive(s)),
            HMacHex: (algo: unknown, data: unknown, key: unknown) =>
                hmacHex(('' + toPrimitive(algo)).toLowerCase().indexOf('256') >= 0 ? 'sha256'
                    : ('' + toPrimitive(algo)).toLowerCase().indexOf('md5') >= 0 ? 'md5' : 'sha1',
                toPrimitive(data), toPrimitive(key)),
            HMacBase64: (algo: unknown, data: unknown, key: unknown) => {
                const hex = hmacHex(('' + toPrimitive(algo)).toLowerCase().indexOf('256') >= 0 ? 'sha256' : 'sha1',
                    toPrimitive(data), toPrimitive(key));
                return Buffer.from(hex, 'hex').toString('base64');
            },
            timeFormat: (ms: unknown, fmt?: unknown) => timeFormat(Number(ms), fmt === undefined ? undefined : toPrimitive(fmt)),
            random: (n?: unknown) => Math.floor(Math.random() * (n === undefined ? 1000 : Number(n))),
            getString: () => '',
            base64DecodeToByteArray: () => { throw new JsSandboxError('暂不支持: java.base64DecodeToByteArray'); },
        },
    };
    for (const name of UNSUPPORTED) {
        if (name === 'base64DecodeToByteArray') { continue; }
        (sandbox.java as Record<string, unknown>)[name] = () => {
            throw new JsSandboxError('暂不支持: java.' + name);
        };
    }
    // JSON 列表项的字段直接暴露为全局(readFields 会传), 兼容 `@js: ... + book_id`
    if (opts.globals) {
        for (const k of Object.keys(opts.globals)) {
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && !(k in sandbox)) {
                sandbox[k] = opts.globals[k];
            }
        }
    }
    // JSON 列表项的字段直接暴露为全局(readFields 会传), 兼容 `@js: ... + book_id`
    if (opts.globals) {
        for (const k of Object.keys(opts.globals)) {
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && !(k in sandbox)) {
                sandbox[k] = opts.globals[k];
            }
        }
    }
    sandbox.globalThis = sandbox;

    const context = vm.createContext(sandbox);

    const runOnce = (code: string): unknown => {
        let value: unknown;
        try {
            value = vm.runInContext(code, context, { timeout });
        } catch (err) {
            const msg = (err as Error).message || String(err);
            if (/Illegal return statement/.test(msg)) {
                value = vm.runInContext('(function(){\n' + code + '\n})()', context, { timeout });
            } else {
                throw new JsSandboxError('脚本执行失败: ' + msg);
            }
        }
        return value;
    };

    let out = '';
    for (let round = 0; round < 3; round++) {
        pending.length = 0;
        const value = runOnce(script);
        if (value && typeof (value as Promise<unknown>).then === 'function') {
            // 脚本返回 Promise: 说明作者按异步写, 直接 await
            const resolved = await (value as Promise<unknown>);
            out = toPrimitive(resolved);
            break;
        }
        out = toPrimitive(value);
        if (pending.length === 0) { break; }
        if (!opts.http) {
            throw new JsSandboxError('脚本需要 java.ajax, 但未提供网络上下文');
        }
        const urls = pending.slice(0, 20);
        const responses = await Promise.all(urls.map((u) =>
            opts.http!.ajax(u).then((body) => ({ u, body })).catch(() => ({ u, body: '' }))));
        for (const r of responses) { ajaxCache.set(r.u, r.body); }
    }

    if (logs.length) {
        // 只保留最近几条, 避免把站点日志刷进输出通道
        sandbox.result = out;
    }
    return out.trim();
}
