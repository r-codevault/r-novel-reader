/**
 * rules/entities.ts — HTML 实体解码(仅常用集合 + 数字实体)
 *
 * 书源站点返回的正文里 `&nbsp;` `&amp;` `&#39;` 很常见,
 * 不解码会出现在搜索标题与正文里。命名实体只收常用的一批,
 * 未知实体原样保留(比错误替换更安全)。
 */

const NAMED: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ensp: '\u2002',
    emsp: '\u2003',
    thinsp: '\u2009',
    copy: '\u00a9',
    reg: '\u00ae',
    trade: '\u2122',
    hellip: '\u2026',
    mdash: '\u2014',
    ndash: '\u2013',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    laquo: '\u00ab',
    raquo: '\u00bb',
    middot: '\u00b7',
    bull: '\u2022',
    times: '\u00d7',
    divide: '\u00f7',
    deg: '\u00b0',
    plusmn: '\u00b1',
    frac12: '\u00bd',
    sup2: '\u00b2',
    sup3: '\u00b3',
    euro: '\u20ac',
    pound: '\u00a3',
    yen: '\u00a5',
    cent: '\u00a2',
    sect: '\u00a7',
    para: '\u00b6',
    dagger: '\u2020',
    permil: '\u2030',
    prime: '\u2032',
    Prime: '\u2033',
    larr: '\u2190',
    rarr: '\u2192',
    uarr: '\u2191',
    darr: '\u2193',
};

/**
 * 解码 HTML 实体。
 * 支持 `&#123;` `&#x1F600;` 与命名实体(大小写敏感, 与浏览器一致)。
 */
export function decodeEntities(input: string): string {
    if (!input || input.indexOf('&') < 0) { return input; }
    return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, function (whole, body: string) {
        if (body.charCodeAt(0) === 35 /* # */) {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            if (!isFinite(code) || code <= 0 || code > 0x10ffff) { return whole; }
            try { return String.fromCodePoint(code); } catch { return whole; }
        }
        const hit = NAMED[body];
        return hit === undefined ? whole : hit;
    });
}

/** 折叠空白(保留单个空格), 用于标题/作者等单行字段 */
export function collapseSpace(input: string): string {
    return (input || '').replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}
