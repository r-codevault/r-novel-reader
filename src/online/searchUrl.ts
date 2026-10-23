/**
 * online/searchUrl.ts — 把书源的 searchUrl 变成一次真实请求
 *
 * legado 的 searchUrl 有几种形态:
 *   1. 纯 URL 模板: `https://x.com/search?q={{key}}&p={{page}}`
 *   2. 相对地址: `/search/?keyword={{key}}`(按 bookSourceUrl 补全)
 *   3. 带选项: `https://x.com/search, {"method":"POST","body":"q={{key}}"}`
 *   4. 脚本: `@js: ...` / `<js>...</js>`(部分源缺闭合标签), 返回上面任意一种
 *   5. 内联脚本: `/s/?k=[[java.md5Encode(key)]]`
 *   6. 空: 该源无法搜索 -> UnsupportedRuleError
 *
 * 查询串统一 UTF-8 编码; 书源声明的 charset 只用于响应解码。
 */
import { BookSource } from '../bookSource';
import { interpolate, UnsupportedRuleError } from '../rules/evalRule';
import { runJsScript, SandboxHttp } from '../rules/jsSandbox';
import { resolveUrl } from '../rules/url';

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

/** legado 的 `[[js表达式]]` 内联脚本: 逐个就地求值 */
async function expandInlineJs(
    text: string,
    source: BookSource,
    key: string,
    page: number,
    http?: SandboxHttp
): Promise<string> {
    if (text.indexOf('[[') < 0) { return text; }
    let out = text;
    for (let i = 0; i < 5; i++) {
        const start = out.indexOf('[[');
        if (start < 0) { break; }
        const end = out.indexOf(']]', start + 2);
        if (end < 0) { break; }
        const expr = out.slice(start + 2, end);
        const value = await runJsScript(expr, {
            baseUrl: source.bookSourceUrl,
            key,
            page,
            sourceName: source.bookSourceName,
            http,
        });
        out = out.slice(0, start) + value + out.slice(end + 2);
    }
    return out;
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
    // `@js:` 与 `<js>…</js>`(部分书源的闭合标签缺失, 一并兼容)
    const jsMatch = /^@js:\s*([\s\S]*)$/i.exec(raw)
        || /^<js>\s*([\s\S]*?)(?:\s*<\/js>)?$/i.exec(raw);
    const isJs = !!jsMatch;
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

    // `[[...]]` 内联脚本(legado 支持, 常见于需要 cookie/签名的站点)
    text = await expandInlineJs(text, source, key, page, http);

    const { url: basePart, options } = splitUrlOptions(text);
    let url = basePart.trim();
    // 相对地址(如 `/tags-01/{{key}}.html`)按书源主地址补全
    if (url && !/^https?:\/\//i.test(url)) {
        url = resolveUrl(source.bookSourceUrl, url);
    }
    if (!/^https?:\/\//i.test(url)) {
        throw new UnsupportedRuleError('searchUrl 不是有效地址: ' + basePart.slice(0, 80));
    }
    // 模板没有用到 key 时, 以 query 参数形式补上
    if (raw.indexOf('{{key}}') < 0 && !isJs && url.indexOf('key=' + encodeURIComponent(key)) < 0) {
        url = withKeyQuery(url, key);
    }
    return {
        url,
        method: (options.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
        headers: options.headers,
        body: options.body === undefined ? undefined : String(options.body),
    };
}
