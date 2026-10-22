/**
 * http.ts — 书源请求的 HTTP 客户端(扩展宿主内运行, 无 CORS 限制)
 *
 * 设计要点:
 *  - 手工跟随重定向(≤5 跳): 保留每一跳的 Set-Cookie, 很多站点靠 cookie 过校验页
 *  - 超时用 AbortController; 外部 signal 可叠加(下载取消)
 *  - 编码: 书源声明 charset → Content-Type → <meta charset> → decodeBuffer(GB18030 兜底)
 *  - 体积上限(默认 8MB), 超出直接失败, 避免被超大页面拖死
 *  - 错误分类, 供上层区分「可重试 / 不可重试 / 需提示用户」
 */
import { decodeBuffer } from './encoding';

export type HttpErrorKind = 'badUrl' | 'timeout' | 'abort' | 'network' | 'http' | 'tooLarge';

export class HttpError extends Error {
    constructor(public readonly kind: HttpErrorKind, message: string, public readonly status?: number) {
        super(message);
        this.name = 'HttpError';
    }
}

export interface HttpOptions {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    maxBytes?: number;
    /** 书源声明的内容编码(仅用于解码, 查询串始终 UTF-8) */
    charset?: string;
    signal?: AbortSignal;
}

export interface HttpResponse {
    url: string;
    status: number;
    text: string;
    bytes: number;
    contentType: string;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 单源 cookie 罐(内存, 会话级) */
export class CookieJar {
    private store = new Map<string, Map<string, string>>();

    addFromSetCookie(host: string, setCookies: string[]): void {
        if (!setCookies.length) { return; }
        let bucket = this.store.get(host);
        if (!bucket) { bucket = new Map(); this.store.set(host, bucket); }
        for (const raw of setCookies) {
            const first = raw.split(';')[0] || '';
            const eq = first.indexOf('=');
            if (eq <= 0) { continue; }
            const name = first.slice(0, eq).trim();
            const value = first.slice(eq + 1).trim();
            if (!name) { continue; }
            bucket.set(name, value);
        }
    }

    headerFor(host: string): string {
        const bucket = this.store.get(host);
        if (!bucket || bucket.size === 0) { return ''; }
        const parts: string[] = [];
        for (const [k, v] of bucket) { parts.push(k + '=' + v); }
        return parts.join('; ');
    }

    clear(): void { this.store.clear(); }
}

function charsetFromContentType(ct: string): string {
    const m = /charset=["']?([\w-]+)/i.exec(ct || '');
    return m ? m[1].toLowerCase() : '';
}

function charsetFromHtml(buf: Buffer): string {
    // 只扫描前 4KB, 避免大页面全量转字符串
    const head = buf.subarray(0, 4096).toString('latin1');
    const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
    return m ? m[1].toLowerCase() : '';
}

function normalizeCharset(cs: string): string {
    const c = (cs || '').toLowerCase();
    if (!c) { return ''; }
    if (c === 'gb2312' || c === 'gbk' || c === 'gb18030') { return 'gb18030'; }
    if (c === 'utf8') { return 'utf8'; }
    return c;
}

function decodeBody(buf: Buffer, contentType: string, declared?: string): string {
    const cs = normalizeCharset(declared || charsetFromContentType(contentType) || charsetFromHtml(buf));
    if (cs && cs !== 'utf8' && cs !== 'utf-8') {
        try {
            return new TextDecoder(cs).decode(buf);
        } catch {
            // 不支持的名字交给通用识别
        }
    }
    return decodeBuffer(buf).text;
}

function getSetCookies(res: Response): string[] {
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    if (typeof anyHeaders.getSetCookie === 'function') {
        return anyHeaders.getSetCookie();
    }
    const raw = res.headers.get('set-cookie');
    return raw ? [raw] : [];
}

export class HttpClient {
    constructor(private readonly jar: CookieJar = new CookieJar()) {}

    get cookieJar(): CookieJar { return this.jar; }

    async request(rawUrl: string, opts: HttpOptions = {}): Promise<HttpResponse> {
        let url = (rawUrl || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            throw new HttpError('badUrl', '非法地址: ' + url);
        }
        const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
        const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        const onAbort = (): void => controller.abort();
        if (opts.signal) {
            if (opts.signal.aborted) { controller.abort(); }
            else { opts.signal.addEventListener('abort', onAbort, { once: true }); }
        }

        try {
            let redirects = 0;
            for (;;) {
                const headers: Record<string, string> = {
                    'User-Agent': DEFAULT_UA,
                    'Accept': 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
                    ...(opts.headers || {}),
                };
                let host = '';
                try { host = new URL(url).host; } catch { /* ignore */ }
                const cookie = this.jar.headerFor(host);
                if (cookie && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
                    headers['Cookie'] = cookie;
                }
                if (opts.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
                    headers['Content-Type'] = 'application/x-www-form-urlencoded';
                }

                let res: Response;
                try {
                    res = await fetch(url, {
                        method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
                        headers,
                        body: opts.body,
                        redirect: 'manual',
                        signal: controller.signal,
                    });
                } catch (err) {
                    if (controller.signal.aborted) {
                        throw new HttpError(timedOut ? 'timeout' : 'abort',
                            timedOut ? '请求超时(' + timeoutMs + 'ms)' : '请求已取消');
                    }
                    throw new HttpError('network', '网络错误: ' + (err as Error).message);
                }

                this.jar.addFromSetCookie(host, getSetCookies(res));

                if (res.status >= 300 && res.status < 400) {
                    const loc = res.headers.get('location');
                    if (loc && redirects < MAX_REDIRECTS) {
                        redirects++;
                        const next = new URL(loc, url).toString();
                        url = next;
                        continue;
                    }
                }

                const contentType = res.headers.get('content-type') || '';
                const lenHeader = res.headers.get('content-length');
                if (lenHeader && Number(lenHeader) > maxBytes) {
                    throw new HttpError('tooLarge', '响应超过体积上限(' + Math.round(maxBytes / 1024) + 'KB)', res.status);
                }
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > maxBytes) {
                    throw new HttpError('tooLarge', '响应超过体积上限(' + Math.round(maxBytes / 1024) + 'KB)', res.status);
                }
                if (res.status >= 400) {
                    throw new HttpError('http', 'HTTP ' + res.status, res.status);
                }
                const text = decodeBody(buf, contentType, opts.charset);
                return { url, status: res.status, text, bytes: buf.length, contentType };
            }
        } finally {
            clearTimeout(timer);
            if (opts.signal) { opts.signal.removeEventListener('abort', onAbort); }
        }
    }
}

/** 进程级共享客户端(书源之间按源各持一个 jar 以便隔离) */
export function createClient(): HttpClient {
    return new HttpClient(new CookieJar());
}
