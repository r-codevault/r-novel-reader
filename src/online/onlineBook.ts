/**
 * online/onlineBook.ts — 在线书: 目录与正文抓取(legado ruleToc / ruleContent)
 *
 * 只负责「拿规则 + 请求 + 解析」, 缓存与书架由上层(extension)编排。
 */
import { BookSource } from '../bookSource';
import { HNode, nodeText, outerHtml } from '../rules/html';
import { decodeEntities } from '../rules/entities';
import { evalRuleList, evalRuleOne, RuleContext, UnsupportedRuleError, interpolate } from '../rules/evalRule';
import { runJsScript } from '../rules/jsSandbox';
import { resolveUrl } from '../rules/url';
import { splitUrlOptions } from './searchUrl';
import { fetchForSource, sandboxHttpFor, SourceHttpPool } from './sourceHttp';

export interface OnlineChapter {
    index: number;
    title: string;
    url: string;
}

export interface TocResult {
    chapters: OnlineChapter[];
    tocUrl: string;
    fetchedAt: number;
}

export interface OnlineFetchOptions {
    pool: SourceHttpPool;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** 目录最多翻几页(默认 20) */
    maxTocPages?: number;
}

const MAX_TOC_CHAPTERS = 5000;

/** tocUrl 可能是 URL 模板, 也可能是书籍页上的选择器(legado 两种都允许) */
function isUrlRule(rule: string): boolean {
    const t = (rule || '').trim();
    if (!t) { return false; }
    if (/^https?:\/\//i.test(t)) { return true; }
    if (/^@js:/i.test(t) || /^<js>/i.test(t)) { return true; }
    if (t.indexOf('[[') >= 0) { return true; }
    return /\{\{\s*(baseUrl|bookUrl|book\.|\$|source\.)/.test(t);
}

/** 目录/正文 URL 规则: 支持 {{baseUrl}}/{{bookUrl}}、@js、<js>、相对地址 */
async function resolveRuleUrl(
    source: BookSource,
    rule: string | undefined,
    ctx: RuleContext,
    opts: OnlineFetchOptions
): Promise<string> {
    const raw = (rule || '').trim();
    if (!raw) { return ''; }
    let text = raw;
    const js = /^@js:\s*([\s\S]*)$/i.exec(raw) || /^<js>\s*([\s\S]*?)(?:\s*<\/js>)?$/i.exec(raw);
    if (js) {
        text = await runJsScript(js[1], {
            baseUrl: ctx.baseUrl || source.bookSourceUrl,
            book: ctx.book,
            sourceName: source.bookSourceName,
            http: sandboxHttpFor(source, opts.pool),
        });
    } else {
        text = interpolate(raw, ctx);
    }
    const { url } = splitUrlOptions(text);
    const clean = url.trim();
    if (!clean) { return ''; }
    return resolveUrl(ctx.baseUrl || source.bookSourceUrl, clean);
}

/** 展示用 URL: 去掉 query/hash/userinfo, 截断 */
function safeUrl(raw: string): string {
    const text = String(raw || '').trim();
    if (!text) { return '(空地址)'; }
    try {
        const u = new URL(text);
        const clean = u.origin + u.pathname;
        return clean.length > 60 ? clean.slice(0, 57) + '…' : clean;
    } catch {
        const clean = text.split('?')[0].split('#')[0];
        return clean.length > 60 ? clean.slice(0, 57) + '…' : clean;
    }
}

/** 规则片段: 折叠空白并截断 */
function clipRule(raw: string): string {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) { return '(未配置)'; }
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

function clipMessage(text: string, max = 220): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** 从一页目录里取章节(HTML 或 JSON); matched = 列表规则命中的节点/条目数 */
async function parseTocPage(
    source: BookSource,
    pageUrl: string,
    html: string,
    opts: OnlineFetchOptions
): Promise<{ chapters: OnlineChapter[]; matched: number }> {
    const toc = source.ruleToc || {};
    const listRule = (toc.chapterList || '').trim();
    if (!listRule) {
        throw new UnsupportedRuleError(clipMessage(
            '书源「' + source.bookSourceName + '」未配置 ruleToc.chapterList（目录页 ' + safeUrl(pageUrl) + '）'
        ));
    }
    const nameRule = (toc.chapterName || '@text').trim();
    const urlRule = (toc.chapterUrl || 'a@href').trim();
    const chapters: OnlineChapter[] = [];

    const push = async (ctx: RuleContext, fallbackTitle: string): Promise<void> => {
        let title = '';
        try { title = (await evalRuleOne(nameRule, ctx)).trim(); } catch { title = ''; }
        if (!title) { title = fallbackTitle; }
        let rawUrl = '';
        try { rawUrl = splitUrlOptions((await evalRuleOne(urlRule, ctx)).trim()).url.trim(); } catch { rawUrl = ''; }
        if (!title || !rawUrl) { return; }
        const url = resolveUrl(pageUrl, rawUrl);
        if (!/^https?:\/\//i.test(url)) { return; }
        chapters.push({ index: chapters.length, title, url });
    };

    const parsed = await evalRuleList(listRule, {
        html,
        baseUrl: pageUrl,
        bookUrl: source.bookSourceUrl,
        sourceName: source.bookSourceName,
    });

    const matched = parsed.kind === 'json' ? parsed.items.length : parsed.nodes.length;

    if (parsed.kind === 'json') {
        for (const item of parsed.items) {
            if (!item || typeof item !== 'object') { continue; }
            const obj = item as Record<string, unknown>;
            const fallback = String(obj.name || obj.title || obj.chapterName || '');
            await push(
                { json: item, baseUrl: pageUrl, bookUrl: source.bookSourceUrl, sourceName: source.bookSourceName },
                fallback
            );
        }
    } else {
        for (const node of parsed.nodes) {
            await push({
                node,
                baseUrl: pageUrl,
                bookUrl: source.bookSourceUrl,
                html: outerHtml(node),
                sourceName: source.bookSourceName,
            }, '');
        }
    }
    return { chapters, matched };
}

/** 抓目录(支持 nextTocUrl 翻页; 自动去重) */
export async function fetchToc(
    source: BookSource,
    bookUrl: string,
    opts: OnlineFetchOptions
): Promise<TocResult> {
    const info = source.ruleBookInfo || {};
    const firstCtx: RuleContext = {
        // {{baseUrl}} 是书源主地址; 书籍页地址用 {{bookUrl}}
        baseUrl: source.bookSourceUrl,
        bookUrl,
        book: { bookUrl },
        sourceName: source.bookSourceName,
    };
    let pageUrl = '';
    const tocRule = (info.tocUrl || '').trim();
    if (!tocRule) {
        pageUrl = bookUrl;
    } else if (isUrlRule(tocRule)) {
        pageUrl = await resolveRuleUrl(source, tocRule, firstCtx, opts);
    } else {
        // 选择器: 在书籍详情页上取目录链接
        const page = await fetchForSource(source, opts.pool, bookUrl, {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs || 15000,
        });
        const raw = (await evalRuleOne(tocRule, {
            html: page.text,
            baseUrl: page.url,
            bookUrl,
            sourceName: source.bookSourceName,
        })).trim();
        pageUrl = raw ? resolveUrl(page.url, splitUrlOptions(raw).url.trim()) : '';
    }
    if (!pageUrl) { pageUrl = bookUrl; }
    if (!/^https?:\/\//i.test(pageUrl)) {
        throw new UnsupportedRuleError('目录地址无效: ' + pageUrl.slice(0, 80));
    }

    const listRuleForError = (): string => (source.ruleToc?.chapterList || '').trim();
    const chapters: OnlineChapter[] = [];
    const seenUrls = new Set<string>();
    const seenPages = new Set<string>();
    let matchedTotal = 0;
    let tocUrl = pageUrl;
    const maxPages = Math.max(1, opts.maxTocPages || 20);

    for (let page = 0; page < maxPages; page++) {
        if (seenPages.has(pageUrl)) { break; }
        seenPages.add(pageUrl);
        if (page === 0) { tocUrl = pageUrl; }

        const res = await fetchForSource(source, opts.pool, pageUrl, {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs || 15000,
        });
        const pageResult = await parseTocPage(source, res.url, res.text, opts);
        matchedTotal += pageResult.matched;
        for (const ch of pageResult.chapters) {
            if (seenUrls.has(ch.url)) { continue; }
            seenUrls.add(ch.url);
            chapters.push({ index: chapters.length, title: ch.title, url: ch.url });
            if (chapters.length >= MAX_TOC_CHAPTERS) { break; }
        }
        if (chapters.length >= MAX_TOC_CHAPTERS) { break; }

        const nextRule = (source.ruleToc?.nextTocUrl || '').trim();
        if (!nextRule) { break; }
        const ctx: RuleContext = {
            html: res.text,
            baseUrl: res.url,
            bookUrl,
            book: { bookUrl },
            sourceName: source.bookSourceName,
        };
        const rawNext = (await evalRuleOne(nextRule, ctx)).trim();
        if (!rawNext) { break; }
        const nextUrl = resolveUrl(res.url, rawNext);
        if (!/^https?:\/\//i.test(nextUrl) || seenPages.has(nextUrl)) { break; }
        pageUrl = nextUrl;
    }

    if (!chapters.length) {
        const ctx = '源「' + source.bookSourceName + '」 目录页 ' + safeUrl(pageUrl)
            + ' · chapterList="' + clipRule(listRuleForError()) + '"';
        const pages = seenPages.size > 1 ? ' · 已翻 ' + seenPages.size + ' 页' : '';
        const tail = matchedTotal === 0
            ? '未匹配到节点(页面结构变更/需登录/反爬)'
            : '匹配 ' + matchedTotal + ' 个节点但 chapterName/chapterUrl 为空(检查 @text/@href)';
        throw new UnsupportedRuleError(clipMessage('目录解析结果为空: ' + ctx + pages + ' ' + tail));
    }
    return { chapters, tocUrl, fetchedAt: Date.now() };
}

/** HTML/纯文本正文 -> 段落数组 */
export function contentToParagraphs(raw: string): string[] {
    let text = String(raw || '');
    if (!text) { return []; }
    if (text.indexOf('<') >= 0) {
        text = text
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|h\d|li|section|article)>/gi, '\n')
            .replace(/<[^>]+>/g, '');
        text = decodeEntities(text);
    }
    text = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    return text.split('\n').map(function (line) { return line.trim(); }).filter(function (line) { return !!line; });
}

/** 抓一章正文(支持 nextContentUrl 续页) */
export async function fetchChapter(
    source: BookSource,
    chapterUrl: string,
    opts: OnlineFetchOptions & { referer?: string; maxPages?: number }
): Promise<{ paragraphs: string[]; title: string; url: string }> {
    const rule = source.ruleContent || {};
    if (!rule.content) {
        throw new UnsupportedRuleError('书源未配置 ruleContent.content, 无法读取正文');
    }
    const maxPages = Math.max(1, opts.maxPages || 5);
    let pageUrl = chapterUrl;
    const seen = new Set<string>();
    const parts: string[] = [];
    let title = '';

    for (let page = 0; page < maxPages; page++) {
        if (seen.has(pageUrl)) { break; }
        seen.add(pageUrl);
        const res = await fetchForSource(source, opts.pool, pageUrl, {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs || 15000,
            headers: opts.referer ? { Referer: opts.referer } : undefined,
        });
        const ctx: RuleContext = {
            html: res.text,
            baseUrl: res.url,
            bookUrl: chapterUrl,
            sourceName: source.bookSourceName,
        };
        const content = await evalRuleOne(rule.content, ctx);
        if (content) { parts.push(content); }
        if (!title && rule.title) {
            title = (await evalRuleOne(rule.title, ctx)).trim();
        }
        const nextRule = (rule.nextContentUrl || '').trim();
        if (!nextRule) { break; }
        const rawNext = (await evalRuleOne(nextRule, ctx)).trim();
        if (!rawNext) { break; }
        const nextUrl = resolveUrl(res.url, rawNext);
        if (!/^https?:\/\//i.test(nextUrl) || seen.has(nextUrl)) { break; }
        pageUrl = nextUrl;
    }

    const paragraphs = contentToParagraphs(parts.join('\n'));
    if (!paragraphs.length) {
        throw new UnsupportedRuleError('正文解析结果为空(检查 ruleContent 规则)');
    }
    return { paragraphs, title, url: chapterUrl };
}

/** 目录节点文本(供测试/调试) */
export function tocNodeText(node: HNode): string {
    return nodeText(node).trim();
}
