/**
 * online/ruleApply.ts — 把一次搜索响应按书源规则映射成书籍列表
 *
 * 列表规则(ruleSearch.bookList)为 HTML 时选出节点、逐项求值;
 * 为 JSON 时按 JSONPath 取出数组元素、逐项求值。
 * 缺书名或书地址的条目直接丢弃(真实书源里很常见)。
 */
import { BookSource, RuleSearch } from '../bookSource';
import { HNode, nodeText, outerHtml } from '../rules/html';
import { collapseSpace } from '../rules/entities';
import { evalRuleList, evalRuleOne, RuleContext, UnsupportedRuleError } from '../rules/evalRule';
import { resolveUrl } from '../rules/url';
import { SandboxHttp } from '../rules/jsSandbox';

export interface SearchBookItem {
    sourceId: string;
    sourceName: string;
    title: string;
    author: string;
    bookUrl: string;
    coverUrl?: string;
    intro?: string;
    kind?: string;
    lastChapter?: string;
    wordCount?: number;
}

export const MAX_RESULTS_PER_SOURCE = 50;

function toNumber(text: string): number | undefined {
    const digits = (text || '').replace(/[^\d]/g, '');
    if (!digits) { return undefined; }
    const n = parseInt(digits, 10);
    // 站点常写 "1.2万" -> 去掉非数字会变 12, 这种情况宁可不要字数
    if (!isFinite(n) || n <= 0 || n > 100000000) { return undefined; }
    return n;
}

export async function parseSearchPage(
    source: BookSource,
    content: string,
    pageUrl: string,
    http?: SandboxHttp
): Promise<SearchBookItem[]> {
    const rule: RuleSearch = source.ruleSearch || {};
    if (!rule.bookList) {
        throw new UnsupportedRuleError('书源未配置 ruleSearch.bookList');
    }
    const baseUrl = pageUrl || source.bookSourceUrl;
    const out: SearchBookItem[] = [];
    const seen = new Set<string>();

    const pushItem = (item: SearchBookItem): void => {
        if (out.length >= MAX_RESULTS_PER_SOURCE) { return; }
        if (!item.title || !item.bookUrl) { return; }
        const key = item.bookUrl;
        if (seen.has(key)) { return; }
        seen.add(key);
        out.push(item);
    };

    // 字段级隔离: 可选字段规则写错(如 XPath/残缺选择器)不应让整源判死
    const readFields = async (ctx: RuleContext) => {
        const safe = async (r?: string): Promise<string> => {
            if (!r) { return ''; }
            try { return await evalRuleOne(r, ctx); } catch { return ''; }
        };
        const title = collapseSpace(await safe(rule.name));
        if (!title) { return null; }
        const rawBookUrl = (await safe(rule.bookUrl)).trim();
        const bookUrl = rawBookUrl ? resolveUrl(baseUrl, rawBookUrl) : '';
        if (!bookUrl) { return null; }
        const coverRaw = (await safe(rule.coverUrl)).trim();
        const coverUrl = coverRaw ? resolveUrl(baseUrl, coverRaw) : '';
        const intro = collapseSpace(await safe(rule.intro));
        const kind = collapseSpace(await safe(rule.kind));
        const lastChapter = collapseSpace(await safe(rule.lastChapter));
        const wordCount = toNumber(await safe(rule.wordCount));
        return { title, author: collapseSpace(await safe(rule.author)), bookUrl, coverUrl, intro, kind, lastChapter, wordCount };
    };

    const parsed = await evalRuleList(rule.bookList, {
        html: content,
        baseUrl,
        http,
        sourceName: source.bookSourceName,
    });

    if (parsed.kind === 'json') {
        for (const item of parsed.items) {
            if (out.length >= MAX_RESULTS_PER_SOURCE) { break; }
            if (!item || typeof item !== 'object') { continue; }
            const fields = await readFields({ json: item, baseUrl, http, sourceName: source.bookSourceName });
            if (!fields) { continue; }
            pushItem({ sourceId: source.id, sourceName: source.bookSourceName, ...fields, coverUrl: fields.coverUrl || undefined });
        }
        return out;
    }

    for (const node of parsed.nodes) {
        if (out.length >= MAX_RESULTS_PER_SOURCE) { break; }
        // 节点上下文: CSS 直接在节点子树上求值, 避免整页重复解析
        const ctx: RuleContext = { node, baseUrl, http, sourceName: source.bookSourceName, html: outerHtml(node) };
        const fields = await readFields(ctx);
        if (!fields) { continue; }
        pushItem({ sourceId: source.id, sourceName: source.bookSourceName, ...fields, coverUrl: fields.coverUrl || undefined });
    }
    return out;
}

/** 搜索结果去重键: 书名 + 作者(忽略空白与大小写) */
export function resultKey(item: SearchBookItem): string {
    return (item.title + '|' + item.author).replace(/\s+/g, '').toLowerCase();
}

/**
 * 相关性排序: 书名完全匹配 > 前缀 > 包含 > 其它; 同档按书源自定义顺序。
 * `sourceOrder` 用于同档时保持用户书源列表顺序。
 */
export function relevanceScore(title: string, key: string): number {
    const t = (title || '').replace(/\s+/g, '').toLowerCase();
    const k = (key || '').replace(/\s+/g, '').toLowerCase();
    if (!k) { return 3; }
    if (t === k) { return 0; }
    if (t.startsWith(k)) { return 1; }
    if (t.indexOf(k) >= 0) { return 2; }
    return 3;
}

/** 搜索结果里的纯文本摘要(给 webview 用, 避免传整段 HTML) */
export function cleanIntro(intro: string, max = 120): string {
    const text = collapseSpace((intro || '').replace(/<[^>]+>/g, ' '));
    return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 目录页/正文页也复用同一套 HTML 工具 */
export { nodeText };
