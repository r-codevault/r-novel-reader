/**
 * rules/css.ts — CSS 选择器子集(用于 legado 书源规则)
 *
 * 支持: `tag` `.class` `#id` `[attr]` `[attr=v]` `[attr^=v]` `[attr$=v]`
 *       `[attr*=v]` `[attr~=v]` `[attr|=v]`、后代(空格)、子(`>`)、
 *       相邻(`+`)、兄弟(`~`)、逗号分组;
 * 伪类: `:first-child` `:last-child` `:nth-child(n|odd|even)` `:not(simple)`
 *       `:contains(text)` 与结果集伪类 `:eq(n)` `:gt(n)` `:lt(n)` `:first` `:last`
 *
 * 不支持(抛 CssSyntaxError, 由上层标为「暂不支持」): XPath、`:has()`、属性正则等。
 */
import { HNode, childElements, nodeText } from './html';

export class CssSyntaxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CssSyntaxError';
    }
}

type Comb = 'desc' | 'child' | 'adj' | 'sib';

interface AttrTest {
    name: string;
    op: '' | '=' | '^=' | '$=' | '*=' | '~=' | '|=';
    value: string;
}

interface Compound {
    tag: string;              // '' = 任意
    id: string;
    classes: string[];
    attrs: AttrTest[];
    pseudo: string[];         // first-child / last-child / nth-child(2) / not(.x) / contains(t)
    index?: number;           // legado 的 .N: 在当前匹配集中取第 N 个(0 基)
}

interface Part {
    comb: Comb;
    compound: Compound;
}

interface Group {
    parts: Part[];
    /** 结果集伪类(按出现顺序应用) */
    setFilters: string[];
}

/** 解析一个选择器组(逗号分隔返回多个) */
/** legado 的取值后缀(text/href/attr=…), 出现在选择器链末尾时不属于选择器 */
const LEGADO_EXTRACT = /^(text|ownText|html|href|src|attr=[A-Za-z0-9_:-]+)$/;

/** 单个逗号分组: `class.a@tag.b` -> `.a b` */
function normalizeLegadoGroup(raw: string): string {
    const text = raw.trim();
    // 纯 CSS 也支持 legado 的 `.N` / `.-N` 序号(转成 :index)
    const withIndex = (css: string): string =>
        css.replace(/\.(-?\d+)(?=$|[\s>+~])/g, ':index($1)');
    if (text.indexOf('@') < 0 && !/^(class|id|tag|text)\./.test(text)) { return withIndex(text); }
    const selectors: string[] = [];
    for (const part of splitTopLevel(text, '@')) {
        const seg = part.trim();
        if (!seg) { continue; }
        if (LEGADO_EXTRACT.test(seg)) { break; } // 值提取不是选择器
        // text.分类 -> *:contains(分类): 按文本内容匹配(legado 的 text. 前缀)
        const textHit = /^text\.(.+)$/.exec(seg);
        if (textHit) {
            selectors.push('*:contains(' + textHit[1] + ')');
            continue;
        }
        let css = seg.replace(/^class\./, '.').replace(/^id\./, '#').replace(/^tag\./, '');
        // legado 的 `.N` 序号: `div.card-other.1` -> `div.card-other:index(1)`
        const idx = /^(.*)\.(-?\d+)$/.exec(css);
        if (idx) { css = idx[1] + ':index(' + idx[2] + ')'; }
        selectors.push(withIndex(css));
    }
    return selectors.length ? selectors.join(' ') : withIndex(text);
}

/**
 * 兼容 legado 书源的选择器写法:
 *   class.list-group-item -> .list-group-item
 *   id.content            -> #content
 *   tag.h5                -> h5
 *   class.mb-1@a@text     -> .mb-1 a   (中间的 @ 是逐级向下选取)
 * 纯 CSS 选择器原样返回。
 */
export function normalizeLegadoSelector(selector: string): string {
    return splitTopLevel(selector, ',')
        .map((raw) => normalizeLegadoGroup(raw))
        .join(', ');
}

export function parseSelector(selector: string): Group[] {
    const groups: Group[] = [];
    for (const raw of splitTopLevel(normalizeLegadoSelector(selector), ',')) {
        const text = raw.trim();
        if (!text) { throw new CssSyntaxError('选择器为空'); }
        if (text.startsWith('//') || text.startsWith('/html')) {
            throw new CssSyntaxError('暂不支持 XPath: ' + text);
        }
        groups.push(parseGroup(text));
    }
    if (groups.length === 0) { throw new CssSyntaxError('选择器为空'); }
    return groups;
}

function splitTopLevel(input: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (quote) {
            if (ch === quote && input[i - 1] !== '\\') { quote = ''; }
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '[' || ch === '(') { depth++; continue; }
        if (ch === ']' || ch === ')') { depth--; continue; }
        if (ch === sep && depth === 0) {
            out.push(input.slice(start, i));
            start = i + 1;
        }
    }
    out.push(input.slice(start));
    return out;
}

function parseGroup(text: string): Group {
    const parts: Part[] = [];
    const setFilters: string[] = [];
    let i = 0;
    let comb: Comb = 'desc';
    let first = true;

    while (i < text.length) {
        // 组合器
        while (i < text.length && /\s/.test(text[i])) { i++; }
        if (i < text.length && '>+~'.indexOf(text[i]) >= 0) {
            comb = text[i] === '>' ? 'child' : text[i] === '+' ? 'adj' : 'sib';
            i++;
            while (i < text.length && /\s/.test(text[i])) { i++; }
        }
        if (i >= text.length) { throw new CssSyntaxError('选择器以组合器结尾: ' + text); }

        const start = i;
        const compound: Compound = { tag: '', id: '', classes: [], attrs: [], pseudo: [] };
        // 标签(含通配符 `*`)
        if (text[i] === '*') {
            compound.tag = '';
            i++;
        } else if (/[a-zA-Z]/.test(text[i])) {
            let j = i;
            while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) { j++; }
            compound.tag = text.slice(i, j).toLowerCase();
            i = j;
        }
        // 简单选择器序列
        while (i < text.length && text[i] !== '>' && text[i] !== '+' && text[i] !== '~' && !/\s/.test(text[i])) {
            const ch = text[i];
            if (ch === '.') {
                i++;
                const j = i;
                while (i < text.length && /[a-zA-Z0-9_-]/.test(text[i])) { i++; }
                if (i === j) { throw new CssSyntaxError('class 名为空'); }
                compound.classes.push(text.slice(j, i));
            } else if (ch === '#') {
                i++;
                const j = i;
                while (i < text.length && /[a-zA-Z0-9_-]/.test(text[i])) { i++; }
                if (i === j) { throw new CssSyntaxError('id 为空'); }
                compound.id = text.slice(j, i);
            } else if (ch === '[') {
                const end = text.indexOf(']', i);
                if (end < 0) { throw new CssSyntaxError('属性选择器未闭合'); }
                const body = text.slice(i + 1, end);
                if (/^-?\d*:-?\d*$/.test(body)) {
                    // legado 结果集切片: [1:3] / [:2] / [4:]
                    setFilters.push('slice(' + body + ')');
                } else {
                    compound.attrs.push(parseAttr(body));
                }
                i = end + 1;
            } else if (ch === '!') {
                // legado 排除索引链: !0 / !0:1:2
                i++;
                const m = /^\d+(?::\d+)*/.exec(text.slice(i));
                if (!m) { throw new CssSyntaxError('排除索引为空'); }
                setFilters.push('exclude(' + m[0].replace(/:/g, ',') + ')');
                i += m[0].length;
            } else if (ch === ':') {
                i++;
                let name = '';
                while (i < text.length && /[a-zA-Z-]/.test(text[i])) { name += text[i]; i++; }
                let arg = '';
                if (text[i] === '(') {
                    let depth = 1;
                    i++;
                    const j = i;
                    let quote = '';
                    while (i < text.length && depth > 0) {
                        const c = text[i];
                        if (quote) {
                            if (c === quote) { quote = ''; }
                        } else if (c === '"' || c === "'") { quote = c; }
                        else if (c === '(') { depth++; }
                        else if (c === ')') { depth--; }
                        i++;
                    }
                    arg = text.slice(j, i - 1).trim();
                }
                const lower = name.toLowerCase();
                if (lower === 'index') {
                    const n = parseInt(arg, 10);
                    if (!isNaN(n)) { compound.index = n; }
                } else if (lower === 'eq' || lower === 'gt' || lower === 'lt' || lower === 'first' || lower === 'last') {
                    setFilters.push(lower + (arg ? '(' + arg + ')' : ''));
                } else if (lower === 'first-child' || lower === 'last-child' || lower === 'nth-child'
                    || lower === 'not' || lower === 'contains') {
                    compound.pseudo.push(lower + (arg ? '(' + arg + ')' : ''));
                } else {
                    // 其它常见伪类(:hover/:visited 等)按"不过滤"处理, 与浏览器抓取时的默认态一致
                    if (arg) { compound.pseudo.push(lower + '(' + arg + ')'); }
                }
            } else {
                throw new CssSyntaxError('无法解析的选择器片段: ' + text.slice(i));
            }
        }
        if (i === start) { throw new CssSyntaxError('空选择器段: ' + text); }
        parts.push({ comb: first ? 'desc' : comb, compound });
        first = false;
        comb = 'desc';
    }
    if (parts.length === 0) { throw new CssSyntaxError('选择器为空'); }
    return { parts, setFilters };
}

function parseAttr(body: string): AttrTest {
    const m = /^\s*([a-zA-Z0-9_:-]+)\s*(?:([~^$*|]?=)\s*(.*?)\s*)?$/.exec(body);
    if (!m) { throw new CssSyntaxError('属性选择器不合法: [' + body + ']'); }
    let value = m[3] === undefined ? '' : m[3];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
        value = value.slice(1, -1);
    }
    return { name: m[1].toLowerCase(), op: (m[2] || '') as AttrTest['op'], value };
}

function elementSiblings(node: HNode): HNode[] {
    const parent = node.parent;
    if (!parent) { return [node]; }
    return parent.children.filter((c) => c.type === 'element');
}

function matchCompound(node: HNode, c: Compound): boolean {
    if (node.type !== 'element') { return false; }
    if (c.tag && node.tag !== c.tag) { return false; }
    if (c.id && node.attrs['id'] !== c.id) { return false; }
    for (const cls of c.classes) {
        const list = (node.attrs['class'] || '').split(/\s+/);
        if (list.indexOf(cls) < 0) { return false; }
    }
    for (const a of c.attrs) {
        const v = node.attrs[a.name];
        if (v === undefined) { return false; }
        switch (a.op) {
            case '': break;
            case '=': if (v !== a.value) { return false; } break;
            case '^=': if (!a.value || !v.startsWith(a.value)) { return false; } break;
            case '$=': if (!a.value || !v.endsWith(a.value)) { return false; } break;
            case '*=': if (!a.value || v.indexOf(a.value) < 0) { return false; } break;
            case '~=': if ((v.split(/\s+/)).indexOf(a.value) < 0) { return false; } break;
            case '|=': if (v !== a.value && !v.startsWith(a.value + '-')) { return false; } break;
            default: return false;
        }
    }
    for (const p of c.pseudo) {
        const m = /^([a-z-]+)(?:\((.*)\))?$/.exec(p);
        if (!m) { return false; }
        const name = m[1];
        const arg = m[2] === undefined ? '' : m[2];
        if (name === 'first-child' || name === 'last-child' || name === 'nth-child') {
            const sibs = elementSiblings(node);
            const idx = sibs.indexOf(node); // 0 基
            if (name === 'first-child' && idx !== 0) { return false; }
            if (name === 'last-child' && idx !== sibs.length - 1) { return false; }
            if (name === 'nth-child') {
                const a = arg.trim().toLowerCase();
                if (a === 'odd' && idx % 2 !== 0) { return false; }
                else if (a === 'even' && idx % 2 !== 1) { return false; }
                else if (a !== 'odd' && a !== 'even') {
                    const n = parseInt(a, 10);
                    if (!isFinite(n) || idx !== n - 1) { return false; }
                }
            }
        } else if (name === 'not') {
            const inner = parseGroup(arg.trim());
            if (inner.parts.length === 1 && inner.parts[0].compound && matchCompound(node, inner.parts[0].compound)) {
                return false;
            }
        } else if (name === 'contains') {
            const needle = arg.replace(/^['"]|['"]$/g, '');
            // 命中才保留(此前条件写反, 导致 text./:contains 全部匹配失败)
            if (needle && nodeText(node).indexOf(needle) < 0) { return false; }
        }
    }
    return true;
}

function descendants(node: HNode, out: HNode[]): HNode[] {
    for (const c of node.children) {
        if (c.type !== 'element') { continue; }
        out.push(c);
        descendants(c, out);
    }
    return out;
}

/** 应用 legado 的 .N 序号(对当前匹配集取第 N 个) */
function applyIndex(nodes: HNode[], index: number | undefined): HNode[] {
    if (index === undefined) { return nodes; }
    const i = index < 0 ? nodes.length + index : index;
    return i >= 0 && i < nodes.length ? [nodes[i]] : [];
}

function runGroup(root: HNode, group: Group): HNode[] {
    const first = group.parts[0];
    let cur = applyIndex(
        descendants(root, []).filter((n) => matchCompound(n, first.compound)),
        first.compound.index
    );
    for (let pi = 1; pi < group.parts.length; pi++) {
        const part = group.parts[pi];
        const next: HNode[] = [];
        const seen = new Set<HNode>();
        for (const node of cur) {
            let candidates: HNode[] = [];
            if (part.comb === 'desc') {
                candidates = descendants(node, []);
            } else if (part.comb === 'child') {
                candidates = childElements(node);
            } else if (part.comb === 'adj') {
                const sibs = elementSiblings(node);
                const idx = sibs.indexOf(node);
                candidates = idx >= 0 && idx + 1 < sibs.length ? [sibs[idx + 1]] : [];
            } else {
                const sibs = elementSiblings(node);
                const idx = sibs.indexOf(node);
                candidates = idx >= 0 ? sibs.slice(idx + 1) : [];
            }
            for (const cand of candidates) {
                if (seen.has(cand)) { continue; }
                if (matchCompound(cand, part.compound)) { seen.add(cand); next.push(cand); }
            }
        }
        cur = applyIndex(next, part.compound.index);
    }
    // 结果集后置操作(exclude/slice) + 伪类
    for (const f of group.setFilters) {
        if (f.startsWith('exclude(')) {
            const set = new Set(f.slice(8, -1).split(',').map(function (v) { return parseInt(v, 10); }));
            cur = cur.filter(function (_, i) { return !set.has(i); });
            continue;
        }
        if (f.startsWith('slice(')) {
            const body = f.slice(6, -1);
            const parts = body.split(':');
            const len = cur.length;
            let start = parts[0] === '' ? 0 : parseInt(parts[0], 10);
            let end = parts[1] === '' || parts[1] === undefined ? len : parseInt(parts[1], 10);
            if (start < 0) { start += len; }
            if (end < 0) { end += len; }
            start = Math.max(0, Math.min(len, start));
            end = Math.max(0, Math.min(len, end));
            cur = start >= end ? [] : cur.slice(start, end);
            continue;
        }
        const m = /^([a-z]+)(?:\((-?\d+)\))?$/.exec(f);
        if (!m) { continue; }
        const n = m[2] === undefined ? 0 : parseInt(m[2], 10);
        if (m[1] === 'first') { cur = cur.slice(0, 1); }
        else if (m[1] === 'last') { cur = cur.slice(-1); }
        else if (m[1] === 'eq') { cur = n >= 0 && n < cur.length ? [cur[n]] : []; }
        else if (m[1] === 'gt') { cur = cur.slice(n + 1); }
        else if (m[1] === 'lt') { cur = cur.slice(0, Math.max(0, n)); }
    }
    return cur;
}

/** 文档序索引: 逗号分组各自追加会打乱顺序(目录多卷时会乱章) */
function documentOrder(root: HNode): Map<HNode, number> {
    const order = new Map<HNode, number>();
    let seq = 0;
    const walk = function (node: HNode): void {
        order.set(node, seq++);
        for (const child of node.children) { walk(child); }
    };
    walk(root);
    return order;
}

/** 选择全部匹配节点(文档顺序, 去重) */
export function selectAll(root: HNode, selector: string): HNode[] {
    const groups = parseSelector(selector);
    const out: HNode[] = [];
    const seen = new Set<HNode>();
    for (const g of groups) {
        for (const node of runGroup(root, g)) {
            if (seen.has(node)) { continue; }
            seen.add(node);
            out.push(node);
        }
    }
    if (groups.length > 1) {
        const order = documentOrder(root);
        out.sort(function (a, b) { return (order.get(a) ?? 0) - (order.get(b) ?? 0); });
    }
    return out;
}

/** 选择第一个匹配节点 */
export function selectFirst(root: HNode, selector: string): HNode | null {
    const all = selectAll(root, selector);
    return all.length ? all[0] : null;
}
