/**
 * online/searchUrl.ts — 把书源的 searchUrl 变成一次真实请求
 *
 * legado 的 searchUrl 有几种形态:
 *   1. 纯 URL 模板: `https://x.com/search?q={{key}}&p={{page}}`
 *   2. 带选项: `https://x.com/search, {"method":"POST","body":"q={{key}}","headers":{...}}`
 *   3. 脚本: `@js: ...` / `<js>...</js>`(可能返回上面两种之一)
 *   4. 空: 该源无法搜索 -> 抛 UnsupportedRuleError
 *
 * 查询串统一 UTF-8 编码; 书源声明的 charset 只用于响应解码。
 */
import { BookSource } from '../bookSource';
import { interpolate, UnsupportedRuleError } from '../rules/evalRule';
import { runJsScript, SandboxHttp } from '../rules/jsSandbox';

export interface SearchRequest {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
}

interface UrlOptions {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
}

/** 拆出 `URL, {json}` 形式里的选项 */
export function splitUrlOptions(raw: string): { url: string; options: UrlOptions } {
    const text = raw.trim();
    const m = /^(.*?),\s*(\{[\s\S]*\})\s*$/.exec(text);
    if (!m) { return { url: text, options: {} }; }
    try {
        const options = JSON.parse(m[2]) as UrlOptions;
        return { url: m[1].trim(), options: options && typeof options === 'object' ? options : {} };
    } catch {
        return { url: text, options: {} };
    }
}

/** 模板里没有关键词占位符时, 按 `?key=` 追加(书源约定俗成的兜底) */
function withKeyQuery(url: string, key: string): string {
    if (!key) { return url; }
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'key=' + encodeURIComponent(key);
}

export async function buildSearchRequest(
    source: BookSource,
    key: string,
    page: number,
    http?: SandboxHttp
): Promise<SearchRequest> {
    const raw = (source.searchUrl || '').trim();
    if (!raw) {
        throw new UnsupportedRuleError('书源未配置 searchUrl, 无法搜索');
    }

    let text = raw;
    const jsMatch = /^@js:\s*([\s\S]*)$/.exec(raw) || /^<js>\s*([\s\S]*?)\s*<\/js>$/.exec(raw);
    if (jsMatch) {
        text = await runJsScript(jsMatch[1], {
            baseUrl: source.bookSourceUrl,
            key,
            page,
            sourceName: source.bookSourceName,
            http,
        });
        if (!text) {
            throw new UnsupportedRuleError('searchUrl 脚本没有返回地址');
        }
    } else {
        text = interpolate(raw, { baseUrl: source.bookSourceUrl, key, page });
    }

    const { url: basePart, options } = splitUrlOptions(text);
    let url = basePart.trim();
    if (!/^https?:\/\//i.test(url)) {
        throw new UnsupportedRuleError('searchUrl 不是有效地址: ' + url.slice(0, 80));
    }
    // 模板没有用到 key 时, 以 query 参数形式补上
    if (raw.indexOf('{{key}}') < 0 && !jsMatch && url.indexOf('key=' + encodeURIComponent(key)) < 0) {
        url = withKeyQuery(url, key);
    }
    return {
        url,
        method: (options.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
        headers: options.headers,
        body: options.body === undefined ? undefined : String(options.body),
    };
}
