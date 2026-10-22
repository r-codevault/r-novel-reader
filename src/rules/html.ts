/**
 * rules/html.ts — 容错 HTML 解析(轻量 DOM)
 *
 * 为什么自研: 扩展保持零运行时依赖, 不引入 cheerio/parse5。
 * 目标不是完整 HTML5 规范, 而是"能稳定喂给 CSS 选择器"的容错解析:
 *  - void 元素 / 可选自闭合
 *  - 常见的隐含闭合(li/tr/td/option/p)
 *  - script/style 内容整体跳过(书源站点常内嵌大段 JS)
 *  - `<br>` 保留为元素, 取文本时转成换行
 *  - 未闭合标签在 EOF 自愈
 *
 * 已知不支持(遇到原样当文本): 命名空间/自定义实体/SVG 语义。
 */
import { decodeEntities } from './entities';

export interface HNode {
    type: 'element' | 'text';
    /** 小写标签名; 文本节点为空串; 根节点为 '#root' */
    tag: string;
    attrs: Record<string, string>;
    children: HNode[];
    /** 仅文本节点有值 */
    text: string;
    parent: HNode | null;
}

const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 内容整体跳过的标签(不影响外层文本提取) */
const RAW_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** 打开这些块级标签时, 若栈顶是 <p> 则先隐式闭合 */
const CLOSES_P = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer',
    'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav',
    'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

/** 同标签互相隐式闭合 */
const SELF_CLOSING_PAIRS: Record<string, string[]> = {
    li: ['li'],
    tr: ['tr'],
    td: ['td', 'th'],
    th: ['td', 'th'],
    option: ['option'],
    dt: ['dt', 'dd'],
    dd: ['dt', 'dd'],
};

const MAX_ELEMENTS = 20000;

function el(tag: string, attrs: Record<string, string>, parent: HNode | null): HNode {
    return { type: 'element', tag, attrs, children: [], text: '', parent };
}

function textNode(text: string, parent: HNode | null): HNode {
    return { type: 'text', tag: '', attrs: {}, children: [], text, parent };
}

/** 解析 HTML 片段, 返回根节点(children 为顶层节点) */
export function parseHtml(html: string): HNode {
    const src = html || '';
    const root = el('#root', {}, null);
    const stack: HNode[] = [root];
    let count = 0;
    let i = 0;

    const top = (): HNode => stack[stack.length - 1];
    const pushText = (raw: string): void => {
        if (!raw) { return; }
        const text = decodeEntities(raw);
        if (!text) { return; }
        const parent = top();
        const last = parent.children[parent.children.length - 1];
        if (last && last.type === 'text') {
            last.text += text; // 相邻文本合并
            return;
        }
        parent.children.push(textNode(text, parent));
    };
    const closeTo = (tag: string): void => {
        for (let d = stack.length - 1; d > 0; d--) {
            if (stack[d].tag === tag) {
                stack.length = d; // 弹出该节点及其所有后代
                return;
            }
        }
    };
    /** 处理隐式闭合: 返回 true 表示当前标签应作为 void 处理(不压栈) */
    const applyImplicitClose = (tag: string): void => {
        const self = SELF_CLOSING_PAIRS[tag];
        if (self) {
            while (stack.length > 1 && self.indexOf(top().tag) >= 0) { stack.pop(); }
        }
        if (CLOSES_P.has(tag)) {
            if (top().tag === 'p') { stack.pop(); }
        }
    };

    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt < 0) {
            pushText(src.slice(i));
            break;
        }
        if (lt > i) { pushText(src.slice(i, lt)); }

        // 注释 / doctype / CDATA
        if (src.startsWith('<!--', lt)) {
            const end = src.indexOf('-->', lt + 4);
            i = end < 0 ? src.length : end + 3;
            continue;
        }
        if (src.startsWith('<![CDATA[', lt)) {
            const end = src.indexOf(']]>', lt + 9);
            pushText(src.slice(lt + 9, end < 0 ? src.length : end));
            i = end < 0 ? src.length : end + 3;
            continue;
        }
        if (src[lt + 1] === '!' || src[lt + 1] === '?') {
            const end = src.indexOf('>', lt + 2);
            i = end < 0 ? src.length : end + 1;
            continue;
        }

        // 结束标签
        if (src[lt + 1] === '/') {
            const gt = src.indexOf('>', lt + 2);
            const name = src.slice(lt + 2, gt < 0 ? src.length : gt).trim().toLowerCase();
            if (gt < 0) { break; }
            const tag = name.split(/\s/)[0];
            if (tag) { closeTo(tag); }
            i = gt + 1;
            continue;
        }

        // 开始标签: 必须是字母开头, 否则当文本
        if (!/[a-zA-Z]/.test(src[lt + 1] || '')) {
            pushText('<');
            i = lt + 1;
            continue;
        }

        // 解析标签名
        let p = lt + 1;
        while (p < src.length && /[a-zA-Z0-9:_-]/.test(src[p])) { p++; }
        const tag = src.slice(lt + 1, p).toLowerCase();

        // 解析属性
        const attrs: Record<string, string> = {};
        let selfClose = false;
        while (p < src.length) {
            while (p < src.length && /\s/.test(src[p])) { p++; }
            if (src[p] === '>') { p++; break; }
            if (src[p] === '/' && src[p + 1] === '>') { selfClose = true; p += 2; break; }
            if (p >= src.length) { break; }
            // 属性名
            const nameStart = p;
            while (p < src.length && !/[\s=\/>]/.test(src[p])) { p++; }
            const name = src.slice(nameStart, p).toLowerCase();
            if (!name) { p++; continue; }
            while (p < src.length && /\s/.test(src[p])) { p++; }
            let value = '';
            if (src[p] === '=') {
                p++;
                while (p < src.length && /\s/.test(src[p])) { p++; }
                const quote = src[p];
                if (quote === '"' || quote === "'") {
                    p++;
                    const end = src.indexOf(quote, p);
                    value = src.slice(p, end < 0 ? src.length : end);
                    p = end < 0 ? src.length : end + 1;
                } else {
                    const vs = p;
                    while (p < src.length && !/[\s>]/.test(src[p])) { p++; }
                    value = src.slice(vs, p);
                }
            }
            if (attrs[name] === undefined) { attrs[name] = decodeEntities(value); }
        }
        i = p;

        // script/style 整体跳过
        if (RAW_SKIP_TAGS.has(tag)) {
            const re = new RegExp('</' + tag + '\\s*>', 'i');
            const m = re.exec(src.slice(i));
            i = m ? i + m.index + m[0].length : src.length;
            continue;
        }

        applyImplicitClose(tag);
        if (count < MAX_ELEMENTS) {
            const node = el(tag, attrs, top());
            top().children.push(node);
            count++;
            if (!selfClose && !VOID_TAGS.has(tag)) { stack.push(node); }
        }
    }

    return root;
}

/** 元素的直接元素子节点 */
export function childElements(node: HNode): HNode[] {
    return node.children.filter((c) => c.type === 'element');
}

/** 深度优先遍历(含自身), 返回第一个命中的元素 */
export function findFirst(node: HNode, pred: (n: HNode) => boolean): HNode | null {
    if (node.type === 'element' && pred(node)) { return node; }
    for (const c of node.children) {
        const hit = findFirst(c, pred);
        if (hit) { return hit; }
    }
    return null;
}

const BLOCK_FOR_TEXT = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dd', 'dl', 'dt', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]);

/**
 * 节点文本: 拼接所有后代文本; `<br>` 记一个换行; 块级元素之间补换行。
 * `own` = true 时只取直接文本子节点(legado 的 @ownText)。
 */
export function nodeText(node: HNode, own = false): string {
    if (node.type === 'text') { return node.text; }
    if (own) {
        let out = '';
        for (const c of node.children) {
            if (c.type === 'text') { out += c.text; }
            else if (c.tag === 'br') { out += '\n'; }
        }
        return out;
    }
    let out = '';
    for (const c of node.children) {
        if (c.type === 'text') { out += c.text; continue; }
        if (c.tag === 'br') { out += '\n'; continue; }
        const inner = nodeText(c);
        out += inner;
        if (BLOCK_FOR_TEXT.has(c.tag) && !inner.endsWith('\n')) { out += '\n'; }
    }
    return out;
}

function escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const VOID_SERIALIZE = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** 内部 HTML(子节点序列化) */
export function innerHtml(node: HNode): string {
    return node.children.map(outerHtml).join('');
}

/** 外部 HTML(自身及子节点序列化, 属性按解析值回写) */
export function outerHtml(node: HNode): string {
    if (node.type === 'text') { return escapeText(node.text); }
    if (node.tag === '#root') { return innerHtml(node); }
    const attrs = Object.keys(node.attrs)
        .map((k) => ' ' + k + '="' + node.attrs[k].replace(/"/g, '&quot;') + '"')
        .join('');
    const open = '<' + node.tag + attrs;
    if (VOID_SERIALIZE.has(node.tag)) { return open + '>'; }
    return open + '>' + innerHtml(node) + '</' + node.tag + '>';
}
