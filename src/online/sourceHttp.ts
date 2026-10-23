/**
 * online/sourceHttp.ts — 按书源隔离的请求上下文
 *
 * 每个书源一个 CookieJar(站点登录态/校验 cookie 互不串),
 * 统一注入书源 header、charset, 并给 @js 规则提供 java.ajax。
 */
import { BookSource } from '../bookSource';
import { HttpClient, HttpOptions, HttpResponse } from '../http';
import { SandboxHttp } from '../rules/jsSandbox';

export class SourceHttpPool {
    private clients = new Map<string, HttpClient>();

    clientFor(sourceId: string): HttpClient {
        let client = this.clients.get(sourceId);
        if (!client) {
            client = new HttpClient();
            this.clients.set(sourceId, client);
        }
        return client;
    }

    drop(sourceId: string): void {
        this.clients.delete(sourceId);
    }

    clear(): void {
        this.clients.clear();
    }
}

/** 解析书源 header(JSON 字符串) */
export function parseSourceHeader(header: string | undefined): Record<string, string> {
    if (!header) { return {}; }
    try {
        const parsed = JSON.parse(header) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const k of Object.keys(parsed)) {
            const v = parsed[k];
            if (typeof v === 'string' && v) { out[k] = v; }
        }
        return out;
    } catch {
        return {};
    }
}

/** 书源 header 里的模板变量(主要是 {{baseUrl}}) */
export function interpolateHeader(header: Record<string, string>, sourceUrl: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(header)) {
        out[key] = header[key].replace(/\{\{\s*baseUrl\s*\}\}/g, sourceUrl);
    }
    return out;
}

/** 某书源的请求函数(带 header / charset) */
export async function fetchForSource(
    source: BookSource,
    pool: SourceHttpPool,
    url: string,
    opts: HttpOptions = {}
): Promise<HttpResponse> {
    const headers = { ...interpolateHeader(parseSourceHeader(source.header), source.bookSourceUrl), ...(opts.headers || {}) };
    return pool.clientFor(source.id).request(url, {
        ...opts,
        headers,
        charset: opts.charset || source.charset || '',
    });
}

/** 给 @js 规则用的 java.ajax(返回文本; 失败返回空串由脚本自行处理) */
export function sandboxHttpFor(source: BookSource, pool: SourceHttpPool): SandboxHttp {
    return {
        ajax: async (url: string) => {
            try {
                const res = await fetchForSource(source, pool, url);
                return res.text;
            } catch {
                return '';
            }
        },
    };
}
