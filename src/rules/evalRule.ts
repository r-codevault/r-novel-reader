/**
 * rules/evalRule.ts — legado 规则求值(统一入口)
 *
 * 处理顺序(与 legado 的行为尽量一致):
 *   1. `a||b` 兜底: 前者无结果再用后者
 *   2. `{{...}}` 插值: `{{key}}` `{{page}}` `{{$.a.b}}`(JSON) / `{{book.title}}`
 *   3. 规则前缀: `@js:` / `<js>…</js>` / `@css:` / `@json:`, 无前缀按内容类型推断
 *   4. 提取后缀: `@text` `@ownText` `@html` `@href` `@src` `@attr=xxx`
 *   5. `##正则##替换` 后处理(全局替换, 支持 $1)
 *
 * 不支持 XPath: 抛出 UnsupportedRuleError, 由调用方把该源标为「暂不支持」。
 */
import { HNode, innerHtml, nodeText, parseHtml } from './html';
import { selectAll } from './css';
import { queryJson } from './jsonPath';
import { resolveUrl } from './url';
import { runJsScript, SandboxHttp, JsSandboxError } from './jsSandbox';

export type RuleErrorKind = 'unsupported' | 'syntax' | 'empty' | 'network' | 'js';

export class RuleError extends Error {
    constructor(public readonly kind: RuleErrorKind, message: string) {
        super(message);
        this.name = 'RuleError';
    }
}

export class UnsupportedRuleError extends RuleError {
    constructor(message: string) {
        super('unsupported', message);
        this.name = 'UnsupportedRuleError';
    }
}

export interface RuleContext {
    /** 当前书籍地址(详情/目录/正文页规则会用到) */
    bookUrl?: string;
    /** 页面文本(HTML/JSON 均可) */
    html?: string;
    /** 已解析的 JSON(内容像 JSON 时由调用方传入) */
    json?: unknown;
    /** 已解析的 DOM 子树(列表逐项求值时避免重复解析整页) */
    node?: HNode;
    baseUrl: string;
    key?: string;
    page?: number;
    book?: Record<string, unknown>;
    sourceName?: string;
    http?: SandboxHttp;
    vars?: Record<string, string>;
}

/** legado 的 `{{@@规则}}`: 在当前节点/JSON 项上再求值一次并嵌入结果 */
async function expandEmbedded(text: string, ctx: RuleContext, depth: number): Promise<string> {
    if (depth > 3 || text.indexOf('{{@@') < 0) { return text; }
    const re = /\{\{@@([\s\S]*?)\}\}/g;
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const value = await evalRuleOne(m[1], ctx, depth + 1);
        out += text.slice(last, m.index) + value;
        last = re.lastIndex;
    }
    return last > 0 ? out + text.slice(last) : text;
}

/** 按顶层 `||` 切分(尊重引号与括号) */
export function splitFallback(rule: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < rule.length; i++) {
        const ch = rule[i];
        if (quote) {
            if (ch === quote && rule[i - 1] !== '\\') { quote = ''; }
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(' || ch === '[') { depth++; continue; }
        if (ch === ')' || ch === ']') { depth--; continue; }
        if (ch === '|' && rule[i + 1] === '|' && depth === 0) {
            out.push(rule.slice(start, i));
            i++;
            start = i + 1;
        }
    }
    out.push(rule.slice(start));
    return out;
}

/** `{{key}}` / `{{page}}` / `{{$.a.b}}` / `{{book.title}}` 插值 */
export function interpolate(tpl: string, ctx: RuleContext): string {
    if (!tpl || tpl.indexOf('{{') < 0) { return tpl; }
    return tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, exprRaw: string) => {
        const expr = exprRaw.trim();
        if (expr === 'key') { return ctx.key || ''; }
        if (expr === 'page') { return String(ctx.page === undefined ? 1 : ctx.page); }
        if (expr === 'baseUrl') { return ctx.baseUrl || ''; }
        if (expr === 'bookUrl') { return ctx.book ? toStr(ctx.book['bookUrl']) : (ctx.bookUrl || ''); }
        if (expr.startsWith('$')) {
            const values = queryJson(ctx.json, expr);
            return values.length ? toStr(values[0]) : '';
        }
        if (expr.startsWith('book.') && ctx.book) {
            const v = ctx.book[expr.slice(5)];
            return v === undefined ? '' : toStr(v);
        }
        if (expr.startsWith('source.') && ctx.sourceName && expr === 'source.name') {
            return ctx.sourceName;
        }
        if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, expr)) {
            return ctx.vars[expr];
        }
        return whole;
    });
}

function toStr(v: unknown): string {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'string') { return v; }
    if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
    try { return JSON.stringify(v); } catch { return String(v); }
}

const EXTRACT_RE = /@(text|ownText|html|href|src|attr=([A-Za-z0-9_:-]+))$/;

interface ExtractSpec {
    kind: 'text' | 'ownText' | 'html' | 'href' | 'src' | 'attr';
    attr?: string;
}

function extractFromNode(node: HNode, spec: ExtractSpec | null, baseUrl: string): string {
    if (!spec) { return nodeText(node).trim(); }
    switch (spec.kind) {
        case 'text': return nodeText(node).trim();
        case 'ownText': return nodeText(node, true).trim();
        case 'html': return innerHtml(node);
        case 'href': return resolveUrl(baseUrl, node.attrs['href'] || '');
        case 'src': return resolveUrl(baseUrl, node.attrs['src'] || '');
        case 'attr': return node.attrs[spec.attr || ''] || '';
        default: return '';
    }
}

/** 判断一段内容是否像 JSON(书源站点大量 JSON API) */
export function looksLikeJson(text: string): boolean {
    const s = (text || '').trim();
    if (!s) { return false; }
    if (s[0] !== '{' && s[0] !== '[') { return false; }
    try { JSON.parse(s); return true; } catch { return false; }
}

function applyRegex(value: string, pattern: string, repl: string): string {
    if (!pattern) { return value; }
    try {
        return value.replace(new RegExp(pattern, 'g'), repl);
    } catch {
        // 非法正则不阻断整条规则: 保留原值
        return value;
    }
}

/** JSON 列表项的标量字段 -> 沙箱全局(legado 脚本可直接引用字段名) */
function jsonGlobals(json: unknown): Record<string, unknown> | undefined {
    if (!json || typeof json !== 'object' || Array.isArray(json)) { return undefined; }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[k] = v;
        }
    }
    return Object.keys(out).length ? out : undefined;
}

async function evalAlternative(raw: string, ctx: RuleContext, depth = 0): Promise<string[]> {
    const src = raw.trim();
    // 纯模板规则({{@@...}}{{...}} 拼接): 展开后的文本就是值, 不能再当选择器解析
    const pureTemplate = /^\{\{[\s\S]*\}\}$/.test(src);
    let rule = interpolate(src, ctx);
    if (rule.indexOf('{{@@') >= 0) { rule = await expandEmbedded(rule, ctx, depth); }
    if (src.indexOf('{{@@') >= 0 && rule.indexOf('{{') < 0) {
        const value = rule.trim();
        return value ? [value] : [];
    }
    if (!rule) { return []; }

    // ##正则##替换: 第三段省略时表示"匹配即删除"(legado 常见写法)
    let regex: { pattern: string; repl: string } | null = null;
    const hashParts = rule.split('##');
    if (hashParts.length >= 2) {
        rule = hashParts[0];
        regex = {
            pattern: hashParts[1],
            repl: hashParts.length >= 3 ? hashParts.slice(2).join('##') : '',
        };
    }

    // @js / <js>
    const jsMatch = /^@js:\s*([\s\S]*)$/.exec(rule);
    const tagMatch = /^<js>\s*([\s\S]*?)\s*<\/js>$/.exec(rule);
    if (jsMatch || tagMatch) {
        const script = (jsMatch ? jsMatch[1] : tagMatch![1]);
        let out = '';
        try {
            out = await runJsScript(script, {
                baseUrl: ctx.baseUrl,
                key: ctx.key,
                page: ctx.page,
                book: ctx.book,
                sourceName: ctx.sourceName,
                http: ctx.http,
                vars: ctx.vars,
                globals: jsonGlobals(ctx.json),
            });
        } catch (err) {
            if (err instanceof JsSandboxError) {
                const unsupported = /暂不支持/.test(err.message);
                throw new RuleError(unsupported ? 'unsupported' : 'js', err.message);
            }
            throw new RuleError('js', (err as Error).message);
        }
        if (!out) { return []; }
        let values = [out];
        if (regex) { values = values.map((v) => applyRegex(v, regex!.pattern, regex!.repl)); }
        return values.filter((v) => v.trim() !== '');
    }

    // XPath 明确不支持
    if (/^@xpath:/i.test(rule) || rule.startsWith('//') || rule.startsWith('/html')) {
        throw new UnsupportedRuleError('暂不支持 XPath 规则: ' + rule);
    }

    // 提取后缀
    let spec: ExtractSpec | null = null;
    const ex = EXTRACT_RE.exec(rule);
    if (ex) {
        spec = { kind: ex[2] ? 'attr' : (ex[1] as ExtractSpec['kind']), attr: ex[2] };
        rule = rule.slice(0, ex.index);
    }

    let values: string[] = [];
    // 裸属性名: legado 书源里大量写法 `href` / `src`(不带 @), 取当前节点属性
    const bareAttr = /^(href|src|html|ownText)$/i.exec(rule.trim());
    if (bareAttr) {
        const target = ctx.node || (ctx.html ? parseHtml(ctx.html) : null);
        if (target) {
            const kind = bareAttr[1].toLowerCase() as ExtractSpec['kind'];
            values = [extractFromNode(target, { kind }, ctx.baseUrl)];
        }
        if (regex) { values = values.map((v) => applyRegex(v, regex!.pattern, regex!.repl)); }
        return values.map((v) => v.trim()).filter((v) => v !== '');
    }
    // legado 的 `text`: 取当前节点文本(不是标签选择器)
    if (rule.trim().toLowerCase() === 'text') {
        const target = ctx.node || (ctx.html ? parseHtml(ctx.html) : null);
        const text = target ? nodeText(target) : '';
        values = text ? [text] : [];
        if (regex) { values = values.map((v) => applyRegex(v, regex!.pattern, regex!.repl)); }
        return values.map((v) => v.trim()).filter((v) => v !== '');
    }
    // `@text` / `@href` 这类"不写选择器"的规则: 直接取当前节点
    if (spec && !rule.trim()) {
        const target = ctx.node || (ctx.html ? parseHtml(ctx.html) : null);
        if (target) { values = [extractFromNode(target, spec, ctx.baseUrl)]; }
        if (regex) { values = values.map((v) => applyRegex(v, regex!.pattern, regex!.repl)); }
        return values.map((v) => v.trim()).filter((v) => v !== '');
    }
    const cssPrefix = /^@css:\s*([\s\S]*)$/i.exec(rule);
    const explicitJson = /^\$/.test(rule) || /^@json\b/i.test(rule);

    if (explicitJson) {
        // 显式 JSONPath: 即使同时拿到 html/node 也必须走 JSON
        let json = ctx.json;
        if (json === undefined && ctx.html) {
            try { json = JSON.parse(ctx.html); } catch { json = undefined; }
        }
        if (json !== undefined) {
            const expr = rule.replace(/^@json\s*:?\s*/i, '').trim();
            values = queryJson(json, expr).map(toStr);
        }
    } else if (cssPrefix) {
        if (!ctx.node && !ctx.html) { return []; }
        const nodes = selectAll(ctx.node || parseHtml(ctx.html || ''), cssPrefix[1].trim());
        values = nodes.map((n) => extractFromNode(n, spec, ctx.baseUrl));
    } else {
        // 无前缀: JSON 内容且规则像路径 -> JSON; 否则按 CSS
        const looksPath = /^[\w$.*\[\]'"-]+$/.test(rule) && (rule.indexOf('.') >= 0 || rule.indexOf('[') >= 0 || rule.startsWith('$'));
        if (ctx.json !== undefined && looksPath && ctx.html === undefined && ctx.node === undefined) {
            values = queryJson(ctx.json, rule).map(toStr);
        } else if (ctx.node || ctx.html) {
            const nodes = selectAll(ctx.node || parseHtml(ctx.html || ''), rule);
            values = nodes.map((n) => extractFromNode(n, spec, ctx.baseUrl));
        } else if (ctx.json !== undefined) {
            values = queryJson(ctx.json, rule).map(toStr);
        }
    }

    if (regex) { values = values.map((v) => applyRegex(v, regex!.pattern, regex!.repl)); }
    return values.map((v) => v.trim()).filter((v) => v !== '');
}

/** 求值一条规则, 返回所有候选值 */
export async function evalRule(rule: string | undefined | null, ctx: RuleContext, depth = 0): Promise<string[]> {
    if (!rule) { return []; }
    const alts = splitFallback(String(rule));
    let lastErr: Error | null = null;
    for (const alt of alts) {
        const text = alt.trim();
        if (!text) { continue; }
        try {
            const values = await evalAlternative(text, ctx, depth);
            if (values.length) { return values; }
        } catch (err) {
            lastErr = err as Error;
        }
    }
    if (lastErr) { throw lastErr; }
    return [];
}

/** 求值并取第一个值 */
export async function evalRuleOne(rule: string | undefined | null, ctx: RuleContext, depth = 0): Promise<string> {
    const values = await evalRule(rule, ctx, depth);
    return values.length ? values[0] : '';
}

/** 列表规则结果: HTML 节点或 JSON 项 */
export type RuleListResult =
    | { kind: 'html'; nodes: HNode[] }
    | { kind: 'json'; items: unknown[] };

/**
 * 列表规则统一入口(搜索 bookList / 目录 chapterList).
 * - 按顶层 `||` 兜底逐段尝试
 * - `@css:` 强制 CSS; `$` / `@json:` 强制 JSON; 其它按 CSS
 * - 返回第一个非空结果; 全部失败抛最后一个错误(源级失败)
 */
export async function evalRuleList(
    rule: string | undefined | null,
    ctx: RuleContext
): Promise<RuleListResult> {
    const text = String(rule || '').trim();
    if (!text) { return { kind: 'html', nodes: [] }; }
    let lastErr: Error | null = null;
    for (const alt of splitFallback(text)) {
        const item = alt.trim();
        if (!item) { continue; }
        try {
            // 内容本身是 JSON 且规则像路径(如 data.books)时也走 JSON
            let contentJson = ctx.json;
            if (contentJson === undefined && ctx.html) {
                const t = ctx.html.trim();
                if (t.startsWith('{') || t.startsWith('[')) {
                    try { contentJson = JSON.parse(t); } catch { contentJson = undefined; }
                }
            }
            const looksPath = /^[\w$.*\[\]'"-]+$/.test(item)
                && (item.indexOf('.') >= 0 || item.indexOf('[') >= 0 || item.startsWith('$'));
            const isJson = /^\$/.test(item) || /^@json\b/i.test(item) || (contentJson !== undefined && looksPath);
            if (isJson) {
                const json = contentJson;
                if (json === undefined) { continue; }
                const expr = item.replace(/^@json\s*:?\s*/i, '').trim();
                const values = queryJson(json, expr);
                const items: unknown[] = [];
                for (const v of values) {
                    if (Array.isArray(v)) { items.push(...v); } else { items.push(v); }
                }
                if (items.length) { return { kind: 'json', items }; }
                continue;
            }
            const cssRule = item.replace(/^@css:\s*/i, '');
            if (!ctx.node && !ctx.html) { continue; }
            const nodes = selectAll(ctx.node || parseHtml(ctx.html || ''), cssRule);
            if (nodes.length) { return { kind: 'html', nodes }; }
        } catch (err) {
            lastErr = err as Error;
        }
    }
    if (lastErr) { throw lastErr; }
    return { kind: 'html', nodes: [] };
}
