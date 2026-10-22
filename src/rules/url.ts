/**
 * rules/url.ts — URL 拼接(书源里的相对地址解析)
 *
 * 书源站点大量使用 `/book/123`、`//cdn.x.com/a.jpg`、`../next.html`，
 * 统一在这里处理; 解析失败返回空串由调用方丢弃该条结果。
 */

export function isAbsoluteUrl(url: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url || '');
}

/** 解析相对地址为绝对地址; 失败返回空串 */
export function resolveUrl(base: string, relative: string): string {
    const rel = (relative || '').trim();
    if (!rel) { return ''; }
    if (isAbsoluteUrl(rel)) { return rel; }
    const b = (base || '').trim();
    if (!b) { return ''; }
    try {
        return new URL(rel, b).toString();
    } catch {
        // 回退: 手工拼 base 的 origin + 路径
    }
    try {
        const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)(\/.*)?$/.exec(b);
        if (!m) { return ''; }
        const origin = m[1];
        if (rel.startsWith('//')) { return 'http:' + rel; }
        if (rel.startsWith('/')) { return origin + rel; }
        const basePath = m[2] || '/';
        const dir = basePath.slice(0, basePath.lastIndexOf('/') + 1) || '/';
        return origin + dir + rel;
    } catch {
        return '';
    }
}

/** 在 URL 上追加查询参数(已存在同名参数则覆盖) */
export function withQuery(url: string, key: string, value: string): string {
    try {
        const u = new URL(url);
        u.searchParams.set(key, value);
        return u.toString();
    } catch {
        const sep = url.indexOf('?') >= 0 ? '&' : '?';
        return url + sep + encodeURIComponent(key) + '=' + encodeURIComponent(value);
    }
}

/** 取 URL 的 origin(协议+主机), 失败返回空串 */
export function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}
