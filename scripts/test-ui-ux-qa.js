/**
 * test-ui-ux-qa.js — UI/UX 增量改造的**独立** QA 回归（不复用 smoke 的时序状态）
 *
 * 与 `smoke-reader-vue.js` 的分工：
 *  - smoke 是"工程师视角"的长链路回归，断言写在同一个巨大状态机里；
 *  - 本文件是"QA 视角"的**反向/边界**断言：只做三件事，每件事都以"证明实现真能达标"
 *    为目标，而不是"检查某个字符串存在过"。
 *
 * A. 静态 CSS 审计（作用域感知）
 *    用极简 CSS 扫描器把规则拆成 {media, selectors, decls}，再按**选择器**取声明，
 *    避免 `css.indexOf('width:24px') >= 0` 这种"任意元素满足即通过"的空转断言。
 *    覆盖 R3-01/02/03/04、R4-01/03/04、R10-02/03、R12-01、R3-06。
 *
 * B. 主题令牌对比度独立复算（R10-01/02）
 *    自己实现 WCAG 相对亮度公式，**不**调用 `src/settings.ts` 的 `contrastRatio` ——
 *    否则"公式写错"和"取色写错"会一起被同一条错误断言放过。
 *
 * C. DOM 行为审计（happy-dom 执行 dist-webview 产物）
 *    C1 关闭设置面板不得残留未保存的主题预览（R8-03 / R8-06）
 *    C2 主题单选组方向键移动 + 实时应用 + 落盘（R8-01）
 *    C3 严格归属：异书 / 无归属的章节回包必须被丢弃（R2-03 的 webview 兜底）
 *    C4 别的书的下载进度只进任务表，不动当前书进度条（R2-04 / R9-06）
 *    C5 笔记组头三件套 + 原生复选框 + 半选 indeterminate（R1-07）
 *    C6 笔记条目的选择框必须是可聚焦、有名称的原生控件（R12-03/R12-04）
 *
 * 运行: node scripts/test-ui-ux-qa.js（需先 npm test 的 pretest 或手动 compile+build:webview）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { Window } = require('happy-dom');

const ROOT = path.join(__dirname, '..');
const CSS_SRC = path.join(ROOT, 'webview', 'reader', 'reader.css');
const CSS_DIST = path.join(ROOT, 'dist-webview', 'reader.css');
const JS_DIST = path.join(ROOT, 'dist-webview', 'reader.js');

for (const f of [CSS_SRC, CSS_DIST, JS_DIST]) {
    assert(fs.existsSync(f), f + ' 不存在, 请先 npm run compile && npm run build:webview');
}

// ================================================================ A. CSS 扫描器
/** 去掉注释：断言不能被注释里的文字骗过 */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 极简 CSS 解析：返回 [{ media, selectors: string[], decls: [{prop, value}] }]，保持源文件顺序。
 * 只处理本项目用到的语法（普通规则 + @media/@supports 嵌套 + @keyframes 跳过）。
 */
function parseCss(text, media) {
    const src = stripComments(text);
    const rules = [];
    let i = 0;
    while (i < src.length) {
        const brace = src.indexOf('{', i);
        if (brace < 0) { break; }
        const prelude = src.slice(i, brace).trim();
        let depth = 1;
        let j = brace + 1;
        while (j < src.length && depth > 0) {
            if (src[j] === '{') { depth += 1; }
            else if (src[j] === '}') { depth -= 1; }
            j += 1;
        }
        const body = src.slice(brace + 1, j - 1);
        if (/^@(media|supports)/.test(prelude)) {
            rules.push.apply(rules, parseCss(body, (media ? media + ' && ' : '') + prelude));
        } else if (prelude.startsWith('@')) {
            // @keyframes / @font-face 等：不参与选择器断言
        } else {
            rules.push({
                media: media || null,
                selectors: prelude.split(',').map(function (s) { return s.trim(); }),
                decls: parseDecls(body),
            });
        }
        i = j;
    }
    return rules;
}

/** 拆声明（尊重括号，避免 url(a;b) 被切断） */
function parseDecls(body) {
    const out = [];
    let buf = '';
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === '(') { depth += 1; }
        if (ch === ')') { depth -= 1; }
        if (ch === ';' && depth === 0) {
            pushDecl(out, buf);
            buf = '';
            continue;
        }
        buf += ch;
    }
    pushDecl(out, buf);
    return out;
}
function pushDecl(out, chunk) {
    const idx = chunk.indexOf(':');
    if (idx <= 0) { return; }
    out.push({
        prop: chunk.slice(0, idx).trim().toLowerCase(),
        value: chunk.slice(idx + 1).trim(),
    });
}

const rules = parseCss(fs.readFileSync(CSS_SRC, 'utf8'), null);
const distCss = stripComments(fs.readFileSync(CSS_DIST, 'utf8'));

/** 取某选择器某属性的全部声明（按出现顺序，含所属 media） */
function declsOf(selector, prop) {
    const hits = [];
    for (const r of rules) {
        if (r.selectors.indexOf(selector) < 0) { continue; }
        for (const d of r.decls) {
            if (d.prop === prop) { hits.push({ media: r.media, value: d.value }); }
        }
    }
    return hits;
}
/** 该选择器最终生效的声明（后出现的赢；这里只用于"必须有/必须没有"这类判断） */
function lastValue(selector, prop) {
    const hits = declsOf(selector, prop);
    return hits.length ? hits[hits.length - 1].value : null;
}
/** 窄屏（<=576px）下最终生效的声明：基础声明 + max-width:576 的 media */
function narrowValue(selector, prop) {
    const hits = declsOf(selector, prop);
    let base = null;
    let narrow = null;
    for (const h of hits) {
        const isNarrow = !!h.media && /max-width:\s*576px/.test(h.media);
        if (isNarrow) { narrow = h.value; } else if (!h.media) { base = h.value; }
    }
    return narrow !== null ? narrow : base;
}
function isZero(v) {
    return v !== null && /^(0|0px|none|auto)$/.test(String(v).trim());
}

const failures = [];
function check(name, fn) {
    try {
        fn();
        console.log('  ✔ ' + name);
    } catch (err) {
        failures.push({ name: name, message: err && err.message ? err.message : String(err) });
        console.log('  ✘ ' + name + ' -> ' + (err && err.message ? err.message : err));
    }
}

console.log('[A. 静态 CSS 审计]');
const POPUPS = ['#shelfPopup', '#storagePopup', '#notesPopup', '#sourcePopup', '#historyPopup'];

// A1. R3-01：浮层不得有固定 min-width（窄屏必须能收缩到视口内）
for (const sel of POPUPS) {
    check('R3-01 ' + sel + ' 窄屏有效 min-width 必须为 0（禁止固定值覆盖视口约束）', function () {
        const v = narrowValue(sel, 'min-width');
        assert(isZero(v), sel + ' 窄屏 min-width = ' + v + '，320px 视口会横向溢出');
    });
}

// A1b. 修窄屏不能连宽屏一起砍：notes/source 仍有各自的更宽上限
check('R3-01 宽屏可读性下限保留（#notesPopup 460px / #sourcePopup 560px 的 min() 上限不变）', function () {
    assert(/min\(460px/.test(baseValue('#notesPopup', 'width') || ''),
        '#notesPopup 宽屏 width 应仍为 min(460px, …), 实际 ' + baseValue('#notesPopup', 'width'));
    assert(/min\(560px/.test(baseValue('#sourcePopup', 'width') || ''),
        '#sourcePopup 宽屏 width 应仍为 min(560px, …), 实际 ' + baseValue('#sourcePopup', 'width'));
});

// A2. R3-01/R3-02：≤576px 时贴左 8px 且宽度按视口计算
for (const sel of POPUPS) {
    check('R3-02 ' + sel + ' 在 ≤576px 块里按视口宽度布点', function () {
        const lefts = declsOf(sel, 'left').filter(function (d) { return d.media && /576px/.test(d.media); });
        const widths = declsOf(sel, 'width').filter(function (d) { return d.media && /576px/.test(d.media); });
        assert(lefts.length > 0, sel + ' 缺少 ≤576px 的 left 规则');
        assert(/var\(--menu-w[^)]*\)\s*\+\s*8px/.test(lefts[lefts.length - 1].value),
            sel + ' 窄屏 left 应为 menu-w + 8px, 实际 ' + lefts[lefts.length - 1].value);
        assert(widths.length > 0, sel + ' 缺少 ≤576px 的 width 规则');
        assert(/calc\(100vw - var\(--menu-w[^)]*\) - 16px\)/.test(widths[widths.length - 1].value),
            sel + ' 窄屏 width 应为 100vw - menu-w - 16px, 实际 ' + widths[widths.length - 1].value);
    });
}

// A3. R3-03：侧栏可纵向滚动、不横向滚动
check('R3-03 .menu 应 overflow-y:auto / overflow-x:hidden', function () {
    assert(lastValue('.menu', 'overflow-y') === 'auto', '.menu overflow-y = ' + lastValue('.menu', 'overflow-y'));
    assert(lastValue('.menu', 'overflow-x') === 'hidden', '.menu overflow-x = ' + lastValue('.menu', 'overflow-x'));
});

// A4. R3-04：结果区吃剩余高度（两条既有约定必须保留）
check('R3-04 .src-results 保留 display:flex + overflow:hidden，且 flex:1 1 auto / min-height:0', function () {
    assert.strictEqual(lastValue('.src-results', 'display'), 'flex',
        '.src-results display = ' + lastValue('.src-results', 'display'));
    assert.strictEqual(lastValue('.src-results', 'overflow'), 'hidden',
        '.src-results overflow = ' + lastValue('.src-results', 'overflow'));
    assert(/^1\s+1\s+auto$/.test((lastValue('.src-results', 'flex') || '').trim()),
        '.src-results flex = ' + lastValue('.src-results', 'flex'));
    assert(isZero(lastValue('.src-results', 'min-height')), '.src-results 需要 min-height:0 才能收缩');
    // 契约: 高度 = 行高令牌 × 行数(JS 只给 --src-alloc-rows), 不再由 JS 直接算 px
    assert(/calc\(var\(--src-result-h[^)]*\)\s*\*\s*var\(--src-alloc-rows/.test(lastValue('.src-pane', 'max-height') || ''),
        '.src-pane max-height 应由 --src-result-h × --src-alloc-rows 决定, 实际 ' + lastValue('.src-pane', 'max-height'));
});

// A5. R4-03：密集列表固定高改 min-height
for (const sel of ['.src-result', '.src-row']) {
    check('R4-03 ' + sel + ' 用 min-height 而非固定 height', function () {
        const h = lastValue(sel, 'height');
        assert(h === null, sel + ' 仍然写死 height: ' + h);
        assert(/var\(--src-/.test(lastValue(sel, 'min-height') || ''),
            sel + ' min-height 应取行高变量, 实际 ' + lastValue(sel, 'min-height'));
    });
}

// A6. R4-01：面板字号不得由 --font-size 推导（只允许正文两处）
check('R4-01 仅正文规则可用 var(--font-size) 推导字号', function () {
    const offenders = [];
    for (const r of rules) {
        for (const d of r.decls) {
            if (d.prop !== 'font-size') { continue; }
            if (d.value.indexOf('var(--font-size)') < 0) { continue; }
            const isBodyRule = r.selectors.some(function (s) {
                return /^#content(\b|$|\s|\[)/.test(s) || /\.chapter-title\b/.test(s)
                    || /\.chapter-skeleton\b/.test(s) || s === 'html' || s === 'body';
            });
            if (!isBodyRule) { offenders.push(r.selectors.join(',') + ' { font-size: ' + d.value + ' }'); }
        }
    }
    assert.strictEqual(offenders.length, 0, '这些 UI 规则仍在跟随正文字号: ' + offenders.join(' | '));
    assert(lastValue(':root', '--ui-font') === '14px', '--ui-font 应固定 14px');
    assert(lastValue(':root', '--ui-font-sub') === '12px', '--ui-font-sub 应固定 12px');
});

// A7. R10-03：四处状态色接入令牌，且不再有硬编码回退
check('R10-03 危险/成功四处使用语义令牌，无 #fff / #2ea043 / charts-green 回退', function () {
    assert(/var\(--danger-fg\).*$/.test(lastValue('.popup-danger', 'color') || ''),
        '.popup-danger color 应取 var(--danger-fg), 实际 ' + lastValue('.popup-danger', 'color'));
    assert(/var\(--danger-fg\)/.test(lastValue('.src-tab-num', 'color') || ''),
        '.src-tab-num color 应取 var(--danger-fg), 实际 ' + lastValue('.src-tab-num', 'color'));
    assert(/var\(--success\)/.test(lastValue('.src-ok', 'color') || ''),
        '.src-ok color 应取 var(--success), 实际 ' + lastValue('.src-ok', 'color'));
    assert(/var\(--success\)/.test(lastValue('.src-status.is-ok', 'color') || ''),
        '.src-status.is-ok color 应取 var(--success), 实际 ' + lastValue('.src-status.is-ok', 'color'));
    for (const bad of ['#2ea043', 'charts-green']) {
        assert(distCss.indexOf(bad) < 0, '产物 CSS 不应再出现 ' + bad);
    }
});

// A8. R12-01：书源复选框/图标按钮 24×24，粗指针 40
/** 基础（不含 media 覆盖）声明 */
function baseValue(selector, prop) {
    const hits = declsOf(selector, prop).filter(function (d) { return !d.media; });
    return hits.length ? hits[hits.length - 1].value : null;
}
check('R12-01 .src-check / .src-ico 达 24×24，粗指针下 40×40', function () {
    assert.strictEqual(baseValue('.src-check', 'width'), '24px', '.src-check 基础 width = ' + baseValue('.src-check', 'width'));
    assert.strictEqual(baseValue('.src-check', 'height'), '24px', '.src-check 基础 height = ' + baseValue('.src-check', 'height'));
    assert.strictEqual(baseValue('.src-ico', 'width'), '24px', '.src-ico 基础 width = ' + baseValue('.src-ico', 'width'));
    assert.strictEqual(baseValue('.src-ico', 'height'), '24px', '.src-ico 基础 height = ' + baseValue('.src-ico', 'height'));
    const coarse = rules.filter(function (r) { return r.media && /pointer:\s*coarse/.test(r.media); });
    const coarseCheck = coarse.some(function (r) {
        return r.selectors.indexOf('.src-check') >= 0 && r.decls.some(function (d) {
            return d.prop === 'width' && d.value === '40px';
        });
    });
    assert(coarseCheck, '缺少 .src-check 在 pointer:coarse 下的 40px 目标');
});

// A9. R3-06：长名称省略/换行策略
check('R3-06 长章节名省略、副标题两行截断', function () {
    assert(/ellipsis/.test(lastValue('.cat-item .cat-name', 'text-overflow') || ''),
        '.cat-item .cat-name 应 text-overflow:ellipsis');
    const clamp = declsOf('.bk-sub', '-webkit-line-clamp').concat(declsOf('.hist-meta', '-webkit-line-clamp'));
    assert(clamp.length > 0 && clamp.every(function (d) { return d.value === '2'; }),
        '.bk-sub / .hist-meta 应双行截断(line-clamp:2), 实际 ' + JSON.stringify(clamp));
    assert(/ellipsis/.test(lastValue('.src-result-title', 'text-overflow') || ''),
        '.src-result-title 应 text-overflow:ellipsis');
});

// A10. 目录行内边距不能被通用 button reset 抹平
check('目录卷头/章节恢复左右内边距与卷头浅底（1.48.9 回归）', function () {
    assert.strictEqual(baseValue('.cat-item', 'padding'), '9px 6px',
        '.cat-item padding 被重置, 实际 ' + baseValue('.cat-item', 'padding'));
    assert.strictEqual(baseValue('.cat-group-head', 'padding'), '10px 12px',
        '.cat-group-head padding 被重置, 实际 ' + baseValue('.cat-group-head', 'padding'));
    assert(/var\(--input-bg\)/.test(baseValue('.cat-group-head', 'background') || ''),
        '.cat-group-head 卷头浅底丢失');
    const zeroPad = rules.filter(function (r) {
        return (r.selectors.indexOf('.cat-item') >= 0 || r.selectors.indexOf('.cat-group-head') >= 0);
    }).some(function (r) {
        return r.decls.some(function (d) { return d.prop === 'padding' && /^0(\s|$)/.test(d.value); });
    });
    assert(!zeroPad, '仍有规则把目录卷头/条目的 padding 归零');
    assert.strictEqual(baseValue('.cat-body', 'padding'), '10px 14px 12px',
        '目录列表缺少左右留白, 实际 ' + baseValue('.cat-body', 'padding'));
    // 折叠只认两个终态: 收起 0 高度 / 展开 auto; 中间过程由 JS 用 px 高度跑
    assert.strictEqual(baseValue('.cat-group-body', 'height'), '0',
        '收起的卷内容应为 0 高度, 实际 ' + baseValue('.cat-group-body', 'height'));
    assert.strictEqual(baseValue('.cat-group-body', 'overflow'), 'hidden',
        '折叠容器要 overflow:hidden 才能裁剪内容');
    assert.strictEqual(baseValue('.cat-group-body.open', 'height'), 'auto',
        '展开态应回到自然高度, 实际 ' + baseValue('.cat-group-body.open', 'height'));
    assert.strictEqual(baseValue('.cat-group-body', 'visibility'), 'hidden',
        '收起动画结束后应 visibility:hidden');
    assert.strictEqual(baseValue('.cat-group-body.open', 'visibility'), 'visible',
        '展开态应可见');
});

// A10b. 目录卷卡片整行单列（展开不重排）+ 章名不带外框（1.48.14 视觉）
check('目录卷卡片整行单列，展开只动高度，章名不带外框', function () {
    // 两列卡片在展开时要把"半宽卡片"变成整行 -> 整片重排, 视觉上会闪
    assert.strictEqual(baseValue('.cat-body', 'grid-template-columns'), null,
        '.cat-body 不应再是网格(两列卡片展开会重排), 实际 ' +
        baseValue('.cat-body', 'grid-template-columns'));
    assert.strictEqual(baseValue('.cat-group', 'grid-column'), null,
        '卷分组不应再声明 grid-column');
    assert.strictEqual(baseValue('.cat-group-head', 'width'), '100%',
        '.cat-group-head 应撑满整行, 实际 ' + baseValue('.cat-group-head', 'width'));
    // 展开动画只允许动高度: 再叠 opacity 淡入会有"重影/闪一下"的观感
    assert.strictEqual(baseValue('.cat-group-body', 'opacity'), null,
        '展开态不应再叠 opacity 动画');
    assert.strictEqual(baseValue('.cat-group-body', 'display'), null,
        '折叠容器不应再用 grid 行高撑开(动画改由 JS 的 px 高度驱动)');
    // 章名行: 平时 1px 透明占位(看不出边框, 也不会在 hover 时挤动文字);
    // 悬浮 = 淡色底不描边, 描边只留给当前章（1.48.13）
    assert.strictEqual(baseValue('.cat-item', 'border'), '1px solid transparent',
        '.cat-item 应留 1px 透明描边占位, 实际 ' + baseValue('.cat-item', 'border'));
    assert(/var\(--sp-hover\)/.test(baseValue('.cat-item:hover', 'background') || ''),
        '悬浮应铺淡色底 var(--sp-hover), 实际 ' + baseValue('.cat-item:hover', 'background'));
    assert.strictEqual(baseValue('.cat-item:hover', 'border-color'), null,
        '悬浮不应再描边, 实际 ' + baseValue('.cat-item:hover', 'border-color'));
    assert(/var\(--accent\)/.test(baseValue('.cat-item.cur', 'border-color') || ''),
        '当前章应用强调色描边, 实际 ' + baseValue('.cat-item.cur', 'border-color'));
    const curBg = rules.filter(function (r) {
        return r.selectors.some(function (s) { return /\.cat-item\.cur$/.test(s); });
    }).reduce(function (acc, r) {
        return acc.concat(r.decls.filter(function (d) {
            return d.prop === 'background' || d.prop === 'background-color';
        }));
    }, []);
    assert.strictEqual(curBg.length, 0, '当前章不应铺底色: ' + JSON.stringify(curBg));
});

// A11. 书源子菜单必须脱离文档流，不能挤压工具条
check('书源下拉菜单为锚定浮层且不被面板裁剪', function () {
    assert.strictEqual(lastValue('.src-tools', 'position'), 'relative',
        '.src-tools 应作为菜单定位上下文');
    assert.strictEqual(lastValue('.src-menu', 'position'), 'absolute',
        '.src-menu 必须绝对定位，否则参与 flex 排版');
    assert.strictEqual(lastValue('.src-menu', 'white-space'), 'nowrap',
        '.src-menu 不应允许菜单项换行');
    assert(/calc\(100% \+ 6px\)/.test(lastValue('.src-menu', 'top') || ''),
        '.src-menu 应在工具条下方锚定, 实际 top=' + lastValue('.src-menu', 'top'));
    assert.strictEqual(lastValue('#srcMoreMenu', 'right'), '18px',
        '右侧「更多」菜单应右对齐');
    assert.strictEqual(lastValue('.src-tools .popup-primary', 'width'), 'auto',
        '工具条主按钮不能继承 width:100%');
    assert.strictEqual(lastValue('#sourcePopup .src-manage-body', 'overflow'), 'visible',
        'src-manage-body 不应裁掉下拉菜单');
});

// ================================================================ B. 对比度独立复算
console.log('[B. 主题令牌对比度(独立实现 WCAG)]');

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: function () {
                    return { get: function () { return undefined; }, has: function () { return false; }, update: async function () {} };
                },
            },
            window: {},
            commands: {},
            Uri: {},
        };
    }
    return origLoad.call(this, request, parent, isMain);
};
const settings = require('../dist/settings.js');
const { PROVINCES } = require('../dist/provinceColors.js');
const { SOLAR_TERMS } = require('../dist/solarTerms.js');
const { FESTIVALS } = require('../dist/festivals.js');
Module._load = origLoad;

function srgb(c) {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function toRgb(hex) {
    let x = String(hex).trim().replace('#', '');
    if (x.length === 3) { x = x.split('').map(function (c) { return c + c; }).join(''); }
    assert(/^[0-9a-fA-F]{6}$/.test(x), '非法颜色值: ' + hex);
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
function luminance(hex) {
    const rgb = toRgb(hex);
    return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
}
function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

const allThemes = []
    .concat(settings.THEMES.map(function (t) { return { key: 'preset:' + t.id, theme: t }; }))
    .concat(PROVINCES.map(function (p) { return { key: 'province:' + p.code, theme: settings.themeById('province', p.code) }; }))
    .concat(SOLAR_TERMS.map(function (t) { return { key: 'term:' + t.id, theme: settings.themeById('term', t.id) }; }))
    .concat(FESTIVALS.map(function (f) { return { key: 'festival:' + f.id, theme: settings.themeById('festival', f.id) }; }));

check('R10-01/02 全部 ' + allThemes.length + ' 套主题的 dangerFg/danger ≥4.5 且 success/chromeBg ≥4.5', function () {
    const bad = [];
    for (const row of allThemes) {
        const t = row.theme;
        if (!t.dangerFg || !t.success) { bad.push(row.key + ' 缺令牌'); continue; }
        const a = contrast(t.dangerFg, t.danger);
        const b = contrast(t.success, t.chromeBg);
        if (a < 4.5) { bad.push(row.key + ' dangerFg/danger=' + a.toFixed(2)); }
        if (b < 4.5) { bad.push(row.key + ' success/chromeBg=' + b.toFixed(2)); }
    }
    assert.strictEqual(bad.length, 0, '未达标主题: ' + bad.slice(0, 8).join(' | ') +
        (bad.length > 8 ? ' …共 ' + bad.length + ' 项' : ''));
});

check('R10-02 黑夜主题 dangerFg 必须是深色字（浅色 danger 底配白字只有 ~2:1）', function () {
    const dark = settings.THEMES.filter(function (t) { return t.id === 'dark'; })[0];
    assert(dark, '应存在 dark 预设');
    assert(contrast('#ffffff', dark.danger) < 4.5, '前置: 黑夜 danger 配白字应不达标');
    assert.strictEqual(dark.dangerFg.toLowerCase(), '#191919', '黑夜 dangerFg 应为 #191919, 实际 ' + dark.dangerFg);
});

// ================================================================ C. DOM 行为审计
console.log('[C. DOM 行为审计(happy-dom)]');

const READER_JS = fs.readFileSync(JS_DIST, 'utf8');
const READER_CSS = fs.readFileSync(CSS_DIST, 'utf8');

function bootWebview() {
    const win = new Window({ url: 'https://localhost/' });
    const document = win.document;
    document.head.innerHTML = '<style>' + READER_CSS + '</style>';
    document.body.innerHTML = '<div id="app"></div>';
    const posted = [];
    win.acquireVsCodeApi = function () {
        return {
            postMessage: function (m) {
                try { posted.push(structuredClone(m)); } catch (e) { posted.push(m); }
                return Promise.resolve(true);
            },
            getState: function () { return undefined; },
            setState: function () {},
        };
    };
    win.scrollTo = function () {};
    win.Element.prototype.scrollIntoView = function () {};
    if (!win.PointerEvent) {
        win.PointerEvent = class extends win.MouseEvent {
            constructor(type, params) {
                super(type, params);
                this.pointerId = (params && params.pointerId) || 1;
                this.button = (params && params.button) || 0;
            }
        };
    }
    if (!win.ResizeObserver) {
        win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    }
    vm.createContext(win);
    vm.runInContext(READER_JS, win, { filename: 'reader-bundle.js' });
    return { win: win, document: document, posted: posted };
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

const DEFAULT_SETTINGS = require('../dist/settings.js').DEFAULT_SETTINGS;
const QA_NOVEL = {
    filePath: 'D:/qa.txt',
    bookTitle: 'QA 之书',
    author: 'QA',
    chapters: Array.from({ length: 5 }, function (_, i) {
        return { index: i, title: '第' + (i + 1) + '章 QA' + (i + 1) };
    }),
    totalWords: 999,
};

(async function run() {
    const env = bootWebview();
    const win = env.win;
    const document = env.document;
    const posted = env.posted;
    const root = document.documentElement;

    const send = function (msg) {
        win.dispatchEvent(new win.MessageEvent('message', { data: msg }));
    };
    const dispatch = function (type, payload) {
        send({ type: type, payload: payload });
    };
    const $ = function (sel) { return document.querySelector(sel); };
    /** 笔记失败瞬间页面上同时存在的 role=alert 数量（P3 观察用） */
    let notesAlertCount = 0;
    const click = function (el) {
        el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    };
    /** 真实指针序列的第一步：确认框内 mousedown 不能触发"点浮层外关闭" */
    const down = function (el) {
        el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    };
    const menuItem = function (name) { return $('.menu-item[data-menu="' + name + '"]'); };

    await sleep(30);
    assert(posted.some(function (m) { return m.type === 'ready'; }), 'webview 挂载后应发送 ready');

    dispatch('init', {
        filePath: QA_NOVEL.filePath,
        bookTitle: QA_NOVEL.bookTitle,
        author: QA_NOVEL.author,
        chapters: QA_NOVEL.chapters,
        chapterIndex: 1,
        chapterTitle: QA_NOVEL.chapters[1].title,
        paragraphs: ['甲段。', '乙段。', '丙段。'],
        totalChapters: 5,
        totalWords: 999,
        scrollRatio: 0.2,
        chapterWords: 9,
        settings: Object.assign({}, DEFAULT_SETTINGS),
        protocolVersion: 2,
        downloadTasks: [],
        shelf: [],
        notes: [],
        libraryPath: 'D:/qa-lib',
    });
    await sleep(60);

    // ------------------------------------------------ C1 设置面板关闭后不得残留预览
    const savedBg = root.style.getPropertyValue('--bg');
    assert(savedBg, '前置: init 后应写入 --bg');

    click(menuItem('settings'));
    await sleep(50);
    assert($('#settingsPanel').classList.contains('open'), '前置: 设置面板应打开');

    const otherDot = $('#settingsPanel .sp-dot[data-theme="dark"]');
    assert(otherDot, '前置: 应存在 dark 主题色块');
    // 键盘/悬停预览（focus 与 mouseenter 都走 previewPreset）
    otherDot.dispatchEvent(new win.Event('focus'));
    await sleep(20);
    const previewedBg = root.style.getPropertyValue('--bg');
    if (previewedBg === savedBg) {
        // focus 事件在 happy-dom 未触发时，退回 mouseenter
        otherDot.dispatchEvent(new win.MouseEvent('mouseenter'));
        await sleep(20);
    }
    const previewBg2 = root.style.getPropertyValue('--bg');
    check('R8-01 前置: 聚焦/悬停主题色块应实时预览（不落盘）', function () {
        assert(previewBg2 !== savedBg, '预览没有生效, 后续断言无意义');
    });
    const previewed = previewBg2;

    // 用键盘 Esc 关闭面板：这是 R8-06 明确要求的路径（纯键盘，不会触发 mouseleave）
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(60);
    check('R8-03/R8-06 关闭设置面板（Esc 键盘路径）后 --bg 必须回到已保存主题', function () {
        assert(!$('#settingsPanel').classList.contains('open'), '前置: Esc 应关闭设置面板');
        assert.strictEqual(root.style.getPropertyValue('--bg'), savedBg,
            '关闭面板后仍是预览色 ' + previewed + '，已保存值 ' + savedBg +
            '（R8-03「三个下拉与 settingsOpen 必须统一监听，关闭时全部 restoreTheme()」/ R8-06）');
    });
    // 重新打开设置：面板里高亮的仍是已保存主题，与正文色一致（不能"面板说 sepia、正文是 dark"）
    click(menuItem('settings'));
    await sleep(50);
    check('R8-06 重开设置后高亮项与正文主题变量一致（无预览残留导致的状态错位）', function () {
        const checkedNow = $('#settingsPanel .sp-theme-dots [role="radio"][aria-checked="true"]');
        assert(checkedNow, '重开后应有选中项');
        assert.strictEqual(root.dataset.theme, checkedNow.dataset.theme,
            '正文主题(' + root.dataset.theme + ')与面板高亮(' + checkedNow.dataset.theme + ')不一致');
    });
    // 悬停预览后点「关闭」（鼠标路径）也要回到已保存主题：真实浏览器里鼠标离开 .sp-themes 会触发 mouseleave，
    // happy-dom 不派发，所以这里显式模拟 mouseleave，只断言"面板不会把预览色留在页面上"。
    const dot2 = $('#settingsPanel .sp-theme-dots [role="radio"][data-theme="xuan"]');
    dot2.dispatchEvent(new win.MouseEvent('mouseenter'));
    const themesBox = $('#settingsPanel .sp-themes');
    themesBox.dispatchEvent(new win.MouseEvent('mouseleave'));
    click($('#settingsPanel .popup-close'));
    await sleep(50);
    check('R8-03 悬停预览后关闭面板不残留（mouseleave 归位 + 关闭后仍为已保存值）', function () {
        assert.strictEqual(root.style.getPropertyValue('--bg'), savedBg,
            '关闭后主题变量应为已保存值 ' + savedBg + ', 实际 ' + root.style.getPropertyValue('--bg'));
    });

    // ------------------------------------------------ C2 主题单选组方向键
    click(menuItem('settings'));
    await sleep(50);
    const group = $('#settingsPanel .sp-theme-dots');
    const checked = group.querySelector('[role="radio"][aria-checked="true"]');
    assert(checked, '前置: 应有选中项');
    checked.focus();
    posted.length = 0;
    checked.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await sleep(40);
    check('R8-01 方向键在主题组内移动、实时应用并落盘', function () {
        const nowChecked = group.querySelector('[role="radio"][aria-checked="true"]');
        assert(nowChecked && nowChecked !== checked,
            'ArrowRight 后选中项应移动到下一个主题');
        assert.strictEqual(root.dataset.theme, nowChecked.dataset.theme,
            '主题变量应实时切到 ' + nowChecked.dataset.theme + ', 实际 ' + root.dataset.theme);
        assert(posted.some(function (m) {
            return m.type === 'updateSettings' && m.patch && m.patch.theme === nowChecked.dataset.theme;
        }), '方向键选中应提交 updateSettings(持久化), posted=' + posted.map(function (m) { return m.type; }).join(','));
        assert.strictEqual(group.querySelectorAll('[role="radio"]').length, 7, '仍应有 7 个单选项');
        assert.strictEqual(group.querySelectorAll('[role="radio"][aria-checked="true"]').length, 1,
            '任何时刻只应有一个 aria-checked=true');
    });
    click($('#settingsPanel .popup-close'));
    await sleep(40);

    // ------------------------------------------------ C3 严格归属
    const beforeTitle = $('#content .chapter-title').textContent;
    dispatch('chapter', {
        index: 3, title: '串书章节', paragraphs: ['串书正文'],
        totalChapters: 5, chapterWords: 4, scrollRatio: 0,
        filePath: 'online://s/other', reqId: 9,
    });
    await sleep(30);
    check('R2-03 严格模式下异书章节回包必须被丢弃', function () {
        assert.strictEqual($('#content .chapter-title').textContent, beforeTitle,
            '异书回包改写了正文（严格模式未生效）');
    });
    dispatch('chapter', {
        index: 3, title: '无归属章节', paragraphs: ['无归属正文'],
        totalChapters: 5, chapterWords: 4, scrollRatio: 0,
    });
    await sleep(30);
    check('R2-03 严格模式下缺 filePath 的章节回包必须被拒绝', function () {
        assert.strictEqual($('#content .chapter-title').textContent, beforeTitle,
            '无归属回包被应用（init.protocolVersion=2 时应拒绝）');
    });
    dispatch('chapter', {
        index: 3, title: '本书记载', paragraphs: ['本书记载正文'],
        totalChapters: 5, chapterWords: 6, scrollRatio: 0,
        filePath: QA_NOVEL.filePath, reqId: 10,
    });
    await sleep(40);
    check('R2-03 当前书 + 更高 reqId 的回包必须正常应用（严格模式不能误杀）', function () {
        assert(/本书记载/.test($('#content .chapter-title').textContent),
            '当前书的合法回包被丢弃了, 实际 ' + $('#content .chapter-title').textContent);
    });
    const seqHigh = $('#content .chapter-title').textContent;
    dispatch('chapter', {
        index: 2, title: '回退轮次', paragraphs: ['回退正文'],
        totalChapters: 5, chapterWords: 4, scrollRatio: 0,
        filePath: QA_NOVEL.filePath, reqId: 8,
    });
    await sleep(30);
    check('R2-02 reqId 回退（迟到旧轮）的回包必须被丢弃', function () {
        assert.strictEqual($('#content .chapter-title').textContent, seqHigh,
            'reqId=8 的迟到回包覆盖了 reqId=10 的正文');
    });

    // ------------------------------------------------ C4 下载进度按 key 路由
    dispatch('init', {
        filePath: 'online://s/cur',
        bookTitle: '当前在线书',
        author: '源作者',
        chapters: [{ index: 0, title: '第1章' }, { index: 1, title: '第2章' }],
        chapterIndex: 0,
        chapterTitle: '第1章',
        paragraphs: ['在线正文。'],
        totalChapters: 2,
        totalWords: 50,
        scrollRatio: 0,
        settings: Object.assign({}, DEFAULT_SETTINGS),
        protocolVersion: 2,
        downloadTasks: [],
        online: { sourceName: '测试源', bookUrl: 'https://src/book/1', preview: false },
        shelf: [],
        notes: [],
    });
    await sleep(60);
    click(menuItem('catalog'));
    await sleep(50);

    dispatch('downloadProgress', {
        done: 3, total: 20, failed: 0, running: true, paused: false,
        filePath: 'online://s/other', bookTitle: '别的书',
    });
    await sleep(40);
    check('R2-04 别的书的下载进度不得改动当前书进度条', function () {
        const bar = $('#catalogPanel .cat-bar');
        assert(!bar || bar.getAttribute('aria-valuenow') === '0',
            '当前书进度条被别的书进度驱动了: ' +
            (bar ? bar.getAttribute('aria-valuenow') : '无进度条'));
        const text = $('#catalogPanel [data-cat-dl-text]');
        assert(!text || !/3\s*\/\s*20/.test(text.textContent || ''),
            '当前书进度文案被别的书进度污染: ' + (text ? text.textContent : ''));
    });

    dispatch('downloadProgress', {
        done: 5, total: 10, failed: 0, running: true, paused: false, added: [0],
        filePath: 'online://s/cur', bookTitle: '当前在线书',
    });
    await sleep(40);
    check('R2-04 当前书的进度必须照常驱动进度条（按 key 路由不能一刀切）', function () {
        const bar = $('#catalogPanel .cat-bar');
        assert(bar, '当前书进度条应出现');
        assert.strictEqual(bar.getAttribute('aria-valuenow'), '50', '进度应为 5/10=50, 实际 ' + bar.getAttribute('aria-valuenow'));
        assert.strictEqual(bar.getAttribute('role'), 'progressbar', '进度条应有 role=progressbar(R9-04)');
        assert(bar.getAttribute('aria-valuemin') === '0' && bar.getAttribute('aria-valuemax') === '100',
            'progressbar 应有 aria-valuemin/max');
    });
    click($('#catalogPanel .cat-btn'));
    await sleep(30);

    click(menuItem('storage'));
    await sleep(50);
    check('R9-06 切到存储面板仍能查到别的书的下载任务（任务表全局视图）', function () {
        const row = $('#storagePopup [data-sp-task="online://s/other"]');
        assert(row, '存储面板任务表应列出 online://s/other');
        assert(/别的书/.test(row.textContent), '任务行应显示书名, 实际 ' + row.textContent);
        const btn = row.querySelector('[data-sp-task-toggle]');
        assert(btn && btn.getAttribute('data-sp-task-toggle') === 'online://s/other',
            '任务行按钮必须带 filePath, 才能"在 B 的界面里暂停 A"');
    });
    click($('#storagePopup .popup-close'));
    await sleep(30);

    // ------------------------------------------------ C5 笔记组头三件套
    send({
        type: 'notes',
        items: [
            {
                id: 'n1', bookPath: QA_NOVEL.filePath, bookTitle: QA_NOVEL.bookTitle,
                chapterTitle: QA_NOVEL.chapters[0].title, chapterIndex: 0, paragraphIndex: 0,
                quote: '甲段。', text: '笔记一', createdAt: 1, updatedAt: 1,
            },
            {
                id: 'n2', bookPath: QA_NOVEL.filePath, bookTitle: QA_NOVEL.bookTitle,
                chapterTitle: QA_NOVEL.chapters[0].title, chapterIndex: 0, paragraphIndex: 1,
                quote: '乙段。', text: '笔记二', createdAt: 2, updatedAt: 2,
            },
        ],
    });
    await sleep(40);
    click(menuItem('notes'));
    await sleep(50);
    const manageBtn = $('#notesPopup [data-note-manage]');
    assert(manageBtn, '前置: 应有「管理」入口');
    click(manageBtn);
    await sleep(50);

    check('R1-07 笔记组头为「容器 + 展开按钮 + 原生复选框 + 删除按钮」，无按钮嵌套', function () {
        const head = $('#notesPopup .nt-book-head');
        assert(head, '应存在书组头');
        assert.notStrictEqual(head.tagName, 'BUTTON', '组头外层不能再是 button（会与内部控件嵌套）');
        assert(head.querySelector(':scope > .nt-expand'), '应存在独立展开按钮');
        const cb = head.querySelector('input[type="checkbox"]');
        assert(cb, '管理模式应渲染原生 <input type="checkbox">');
        assert((cb.getAttribute('aria-label') || '').indexOf(QA_NOVEL.bookTitle) >= 0,
            '复选框名称应含书名, 实际 ' + cb.getAttribute('aria-label'));
        assert.strictEqual(document.querySelectorAll('#notesPopup button button').length, 0,
            '不允许按钮嵌套');
        assert.strictEqual(document.querySelectorAll('#notesPopup button input').length, 0,
            '不允许 input 嵌在 button 里');
        const controls = head.querySelectorAll('button, input');
        assert(controls.length >= 2, '组头至少应有展开按钮 + 复选框两个并列控件');
    });

    // 单选一条 → 半选
    click($('#notesPopup [data-note-id="n1"]'));
    await sleep(40);
    check('R1-07 部分选中时组头复选框应为原生 indeterminate（半选三态可被读屏区分）', function () {
        const head = $('#notesPopup .nt-book-head');
        const cb = head.querySelector('input[type="checkbox"]');
        assert(cb, '组头复选框应存在');
        assert.strictEqual(cb.indeterminate, true, '半选时 indeterminate 必须为 true');
        assert.strictEqual(cb.checked, false, '半选时 checked 应为 false');
    });
    click($('#notesPopup [data-note-select-all]'));
    await sleep(40);
    check('R1-07 全选后组头复选框 checked=true 且 indeterminate=false', function () {
        const cb = $('#notesPopup .nt-book-head input[type="checkbox"]');
        assert.strictEqual(cb.checked, true, '全选后 checked 应为 true');
        assert.strictEqual(cb.indeterminate, false, '全选后不应残留 indeterminate');
    });

    // ------------------------------------------------ C6 笔记条目选择框
    check('R12-03/R12-04 笔记条目的选择控件必须是可聚焦、有名称的原生复选框', function () {
        const item = $('#notesPopup [data-note-id="n1"]');
        assert(item, '前置: 应存在笔记条目');
        const span = item.querySelector('[data-note-check]');
        if (span && span.tagName !== 'INPUT') {
            assert.fail('笔记条目选择框是 ' + span.tagName + '[role=' + span.getAttribute('role') +
                ']：无 tabindex、无 aria-label，键盘与读屏都无法选中单条（R12-03 要求名称含对象）');
        }
        const cb = item.querySelector('input[type="checkbox"]');
        assert(cb, '条目应有原生复选框');
        assert((cb.getAttribute('aria-label') || '').length > 0, '条目复选框应有可访问名称');
    });
    // 真实浏览器的坑：click.preventDefault 会让浏览器在派发尾部回滚 checked。
    const cbN2 = $('#notesPopup [data-note-id="n2"] [data-note-check]');
    const cbBefore = cbN2.checked;
    const cbClick = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    cbN2.dispatchEvent(cbClick);
    await sleep(30);
    check('R12-03 条目复选框 click 不得 preventDefault（否则视觉与状态分叉）', function () {
        assert.strictEqual(cbClick.defaultPrevented, false,
            'checkbox click 被 preventDefault，Chromium 会回滚原生 checked');
        assert.strictEqual(cbN2.checked, !cbBefore, '点击后原生 checkbox 状态应正常翻转');
    });
    click(cbN2);
    await sleep(30);

    // ------------------------------------------------ C5b 笔记批量删除必须有统一确认 + 终态
    posted.length = 0;
    const removeNoteBtn = $('#notesPopup [data-note-remove-selected]');
    assert(removeNoteBtn, '前置: 管理模式应有「删除所选」');
    assert(!removeNoteBtn.disabled, '前置: 全选后「删除所选」应可用');
    click(removeNoteBtn);
    await sleep(40);
    const okBtn = $('[data-confirm-ok]');
    check('R7-01 批量删笔记必须先弹统一确认框（数量 + 对象名）', function () {
        assert(okBtn, '「删除所选」没有弹出统一确认框（R7-01 明确把"批量删笔记"列为必须复用确认框的三类之一）');
        assert(!posted.some(function (m) { return m.type === 'removeNotes'; }),
            '未确认就发出了 removeNotes');
        const text = document.querySelector('.confirm-dlg') ? document.querySelector('.confirm-dlg').textContent : '';
        assert(/删除\s*\d+\s*条|\d+\s*条笔记/.test(text), '确认框应写明删除数量, 实际: ' + text);
    });
    check('R9-05 批量删笔记必须携带 opId（否则没有终态，也无法防重复提交）', function () {
        if (!okBtn) {
            assert.fail('没有确认框 -> 消息里也不会有 opId（当前实现直接 send({type:"removeNotes", ids})）');
        }
    });

    if (okBtn) {
        // 取消：不清选择
        click($('[data-confirm-cancel]'));
        await sleep(30);
        check('R7-01 取消确认框不清空选择', function () {
            assert.strictEqual($('[data-note-sel-count]').textContent.replace(/\s/g, ''), '已选2条',
                '取消后选择应保留, 实际 ' + $('[data-note-sel-count]').textContent);
        });
        // 确认 → 宿主回失败
        posted.length = 0;
        click($('#notesPopup [data-note-remove-selected]'));
        await sleep(30);
        click($('[data-confirm-ok]'));
        await sleep(40);
        const rmNoteMsg = posted.filter(function (m) { return m.type === 'removeNotes'; }).pop();
        check('R9-05 确认后的 removeNotes 必须带 opId', function () {
            assert(rmNoteMsg, '确认后应发 removeNotes');
            assert(typeof rmNoteMsg.opId === 'string' && rmNoteMsg.opId.length > 0, 'removeNotes 必须带 opId');
        });
        if (rmNoteMsg && rmNoteMsg.opId) {
            send({ type: 'opResult', payload: { opId: rmNoteMsg.opId, op: 'notes:remove', ok: false, message: '磁盘写入失败' } });
            await sleep(50);
            check('R7-03 失败时保留管理模式与选择', function () {
                assert($('#notesPopup [data-note-remove-selected]'), '失败后应仍在管理模式');
                assert.strictEqual($('[data-note-sel-count]').textContent.replace(/\s/g, ''), '已选2条',
                    '失败后选择应保留, 实际 ' + $('[data-note-sel-count]').textContent);
                assert(document.querySelectorAll('#notesPopup [data-note-id]').length === 2, '笔记不应被删除');
            });
            check('R7-03/R9-05 失败原因必须就地可见（role=alert）', function () {
                const alertEl = document.querySelector('#notesPopup [role="alert"], #notesPopup .op-error');
                assert(alertEl, '失败后没有任何可见错误提示（确认框被关闭，面板也没有 role=alert）');
                assert(/磁盘写入失败/.test(alertEl.textContent || ''), '错误提示应包含宿主返回的原因');
                notesAlertCount = document.querySelectorAll('[role="alert"]').length;
            });
            // 失败后确认框按设计保留；这里显式取消，避免残留的 confirm 影响后续用例
            if ($('.confirm-dlg')) { click($('[data-confirm-cancel]')); await sleep(30); }
        }
    } else {
        check('R7-03 失败/回包前不得直接清空选择与退出管理模式', function () {
            assert(document.querySelectorAll('#notesPopup [data-note-check]').length > 0,
                '点「删除所选」后管理模式与选择被立即清空了（不等宿主终态，失败就丢了上下文）');
        });
    }
    click($('#notesPopup .popup-close'));
    await sleep(30);

    // 面板级 + 确认框级同时存在同文案 alert 只是"播报两份"，不构成功能缺陷(P3 观察)
    console.log('  (观察) 笔记失败瞬间同时存在的 role=alert 数 = ' + notesAlertCount +
        '（确认框一份 + NotesPopup 面板一份，同文案；R9-03 只要求"不逐次播报"，未禁止两处存在）');

    // ------------------------------------------------ C7 失败终态：确认框不能吞掉错误
    dispatch('init', {
        filePath: QA_NOVEL.filePath,
        bookTitle: QA_NOVEL.bookTitle,
        author: QA_NOVEL.author,
        chapters: QA_NOVEL.chapters,
        chapterIndex: 1,
        chapterTitle: QA_NOVEL.chapters[1].title,
        paragraphs: ['甲段。', '乙段。', '丙段。'],
        totalChapters: 5,
        totalWords: 999,
        scrollRatio: 0.2,
        chapterWords: 9,
        settings: Object.assign({}, DEFAULT_SETTINGS),
        protocolVersion: 2,
        downloadTasks: [],
        shelf: [
            { filePath: QA_NOVEL.filePath, title: QA_NOVEL.bookTitle, author: 'QA', chapterIndex: 1, totalChapters: 5, current: true },
            { filePath: 'D:/qa2.txt', title: 'QA 之二', author: 'QA', chapterIndex: -1, totalChapters: 3, current: false },
        ],
        notes: [],
    });
    await sleep(60);
    click(menuItem('shelf'));
    await sleep(50);
    click($('#shelfPopup [data-shelf-batch]'));
    await sleep(40);
    click($('#shelfPopup [data-shelf-select-all]'));
    await sleep(30);
    posted.length = 0;
    click($('#shelfPopup [data-shelf-remove-selected]'));
    await sleep(40);
    const ok2 = $('[data-confirm-ok]');
    check('R7-01 移除所选先弹确认框（书架）', function () {
        assert(ok2, '书架「移除所选」应先弹确认框');
    });
    if (ok2) {
        click(ok2);
        await sleep(40);
        const rmBooks = posted.filter(function (m) { return m.type === 'removeBooks'; }).pop();
        assert(rmBooks && rmBooks.opId, '前置: removeBooks 带 opId');
        send({ type: 'opResult', payload: { opId: rmBooks.opId, op: 'books:removeMany', ok: false, message: '书架文件写入失败' } });
        await sleep(60);
        check('R7-03 失败后选择保留且未退出管理模式', function () {
            assert($('#shelfPopup [data-shelf-select-all]'), '失败后应仍在管理模式');
            assert(/已选\s*2/.test($('#shelfPopup [data-shelf-sel-count]').textContent || ''),
                '失败后选择应保留, 实际 ' + ($('#shelfPopup [data-shelf-sel-count]') || {}).textContent);
        });
        check('R7-03/R9-05 失败原因在发起操作的面板内可见（确认框关闭后仍能看到）', function () {
            const visible = Array.from(document.querySelectorAll('#shelfPopup [role="alert"], #shelfPopup .op-error, .confirm-dlg [role="alert"]'))
                .filter(function (el) { return el && el.textContent && /书架文件写入失败/.test(el.textContent); });
            assert(visible.length > 0,
                '失败后用户看不到任何原因：确认框在 opResult(ok:false) 时被无条件关闭，而各面板都没有渲染 state.opError（R7-03「错误就地可见」/R9-05）');
        });
        if ($('.confirm-dlg')) { click($('[data-confirm-cancel]')); await sleep(30); }
    }
    click($('#shelfPopup .popup-close'));
    await sleep(30);

    // ================================================================ D. 第 2 轮：A–E 修复的反向复核
    console.log('[D. A–E 修复复核]');

    // ------ D1 窄屏几何：320/400px 下右缘必须 <= 视口宽度
    // 只断言"min-width 是 0"还不够 —— 真正要证明的是"算出来的右缘没出界"。
    const MENU = 48;
    for (const vw of [320, 400, 576]) {
        for (const sel of POPUPS) {
            check('R3-01 几何: ' + vw + 'px 视口下 ' + sel + ' 右缘不得超过视口', function () {
                const pivot = vw <= 576;
                const leftRaw = pivot ? narrowValue(sel, 'left') : lastValue(sel, 'left');
                const widthRaw = pivot ? narrowValue(sel, 'width') : lastValue(sel, 'width');
                const minRaw = pivot ? narrowValue(sel, 'min-width') : lastValue(sel, 'min-width');
                assert(leftRaw && widthRaw, sel + ' 缺少 left/width 声明');
                const px = function (v) {
                    const m = String(v).match(/calc\(100vw - var\(--menu-w(?:,\s*48px)?\)\s*-\s*(\d+)px\)/);
                    if (m) { return vw - MENU - Number(m[1]); }
                    const m2 = String(v).match(/calc\(var\(--menu-w(?:,\s*48px)?\)\s*\+\s*(\d+)px\)/);
                    if (m2) { return MENU + Number(m2[1]); }
                    const m3 = String(v).match(/^(\d+)px$/);
                    if (m3) { return Number(m3[1]); }
                    return null;
                };
                const left = px(leftRaw);
                const width = px(widthRaw);
                assert(left !== null && width !== null,
                    sel + ' 的 left/width 无法静态求值(需人工)：left=' + leftRaw + ' width=' + widthRaw);
                const min = minRaw === null || isZero(minRaw) ? 0 : px(minRaw);
                const used = Math.max(width, min || 0);
                const right = left + used;
                assert(right <= vw,
                    sel + ' 在 ' + vw + 'px 视口下右缘 ' + right + 'px 超出视口 ' + (right - vw) + 'px'
                    + '（left=' + left + ', width=' + width + ', min-width=' + minRaw + '）');
            });
        }
    }

    // ------ D2 设置面板：下拉打开 + 预览 + Esc 两层关闭，最后不得残留/回弹
    const savedBg2 = root.style.getPropertyValue('--bg');
    const savedTheme2 = root.dataset.theme;
    click(menuItem('settings'));
    await sleep(50);
    click($('#settingsPanel .sp-province-btn'));
    await sleep(40);
    const provItem = $('#settingsPanel .sp-province-menu .sp-province-item');
    assert(provItem, '前置: 省份下拉应有选项');
    provItem.dispatchEvent(new win.MouseEvent('mouseenter'));
    await sleep(30);
    check('R8-03 前置: 省份悬浮应实时预览', function () {
        assert(root.style.getPropertyValue('--bg') !== savedBg2, '省份预览没有生效');
    });
    // 第 1 次 Esc: 关下拉(内部一层)
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(50);
    check('R5-05/R8-03 第 1 次 Esc 只关下拉并还原主题（不关面板）', function () {
        assert($('#settingsPanel').classList.contains('open'), '第 1 次 Esc 不应关闭面板');
        assert(!$('#settingsPanel .sp-province-menu'), '下拉应已收起');
        assert.strictEqual(root.style.getPropertyValue('--bg'), savedBg2,
            '关下拉后主题应回到已保存值, 实际 ' + root.style.getPropertyValue('--bg'));
    });
    // 第 2 次 Esc: 关面板；再多等两拍确认没有 watcher 事后把预览重新写回去
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(80);
    check('R8-03 关闭面板后若干净: 主题不应被任何 watcher 事后回弹', function () {
        assert(!$('#settingsPanel').classList.contains('open'), '第 2 次 Esc 应关闭面板');
        assert.strictEqual(root.style.getPropertyValue('--bg'), savedBg2,
            '关闭后主题被回弹成 ' + root.style.getPropertyValue('--bg') + '（watcher 顺序问题）');
        assert.strictEqual(root.dataset.theme, savedTheme2,
            '关闭后 data-theme 被回弹成 ' + root.dataset.theme);
    });

    // ------ D3 笔记批量删除：文案准确 / 单次提交 / pending 防重复 / 成功后清理
    const NOTE_ITEMS = [
        {
            id: 'n1', bookPath: QA_NOVEL.filePath, bookTitle: QA_NOVEL.bookTitle,
            chapterTitle: QA_NOVEL.chapters[0].title, chapterIndex: 0, paragraphIndex: 0,
            quote: '甲段。', text: '笔记一', createdAt: 1, updatedAt: 1,
        },
        {
            id: 'n2', bookPath: QA_NOVEL.filePath, bookTitle: QA_NOVEL.bookTitle,
            chapterTitle: QA_NOVEL.chapters[0].title, chapterIndex: 0, paragraphIndex: 1,
            quote: '乙段。', text: '笔记二', createdAt: 2, updatedAt: 2,
        },
        {
            id: 'n3', bookPath: 'D:/other.txt', bookTitle: '另一本书',
            chapterTitle: '第9章', chapterIndex: 8, paragraphIndex: 0,
            quote: '丙段。', text: '笔记三', createdAt: 3, updatedAt: 3,
        },
    ];
    send({ type: 'notes', items: NOTE_ITEMS });
    await sleep(40);
    click(menuItem('notes'));
    await sleep(50);
    click($('#notesPopup [data-note-manage]'));
    await sleep(40);
    // 只勾 n1 + n3：跨 2 本书 / 2 章
    click($('#notesPopup [data-note-id="n1"] [data-note-check]'));
    click($('#notesPopup [data-note-id="n3"] [data-note-check]'));
    await sleep(40);
    check('R12-03 条目复选框点击一次只切换一次（不因整行 click 二次切换）', function () {
        assert.strictEqual($('[data-note-sel-count]').textContent.replace(/\s/g, ''), '已选2条',
            '点两个复选框后应恰好选中 2 条, 实际 ' + $('[data-note-sel-count]').textContent);
        const cb = $('#notesPopup [data-note-id="n1"] [data-note-check]');
        assert.strictEqual(cb.tagName, 'INPUT', '条目复选框应为原生 input');
        assert.strictEqual(cb.type, 'checkbox', 'type 应为 checkbox');
        assert.strictEqual(cb.checked, true, ':checked 必须反映选中状态');
        assert.strictEqual(cb.tabIndex, 0, '复选框必须可 Tab 到达(tabIndex=0)');
    });
    check('R12-01/02 条目复选框有 label 包裹、命中区 ≥24×24、视觉框 16px', function () {
        const cb = $('#notesPopup [data-note-id="n1"] [data-note-check]');
        const label = cb.closest('label');
        assert(label, '复选框应被 <label> 包裹以扩大命中区');
        assert(document.querySelectorAll('#notesPopup label[for]').length === 0 ||
            true, '（label 包裹即可，不强制 for）');
        const labelW = baseValue('.nt-item .nt-check-label', 'width');
        const labelH = baseValue('.nt-item .nt-check-label', 'height');
        assert(labelW === '24px' && labelH === '24px',
            'label 命中区应为 24×24, 实际 ' + labelW + '×' + labelH);
        const visualW = baseValue('.nt-item .nt-check', 'width');
        assert(visualW === '16px', '视觉框应为 16px, 实际 ' + visualW);
    });
    check('R12-01 笔记书/章组头命中区 24×24、视觉框与条目统一 16px', function () {
        const cb = $('#notesPopup .nt-book-head input[type="checkbox"]');
        assert(cb, '管理态书组头应有原生复选框');
        assert(cb.closest('label'), '组头复选框应被 <label> 包裹以扩大命中区');
        const w = baseValue('.nt-head-check-label', 'width');
        const h = baseValue('.nt-head-check-label', 'height');
        assert(w === '24px' && h === '24px', '组头命中区应为 24×24, 实际 ' + w + '×' + h);
        const vis = baseValue('.nt-head-check', 'width');
        assert(vis === '16px', '组头视觉框应与条目统一为 16px, 实际 ' + vis);
    });
    check('笔记模式下线：正文不再有段落笔记徽章', function () {
        assert(document.querySelectorAll('#content .rd-note-btn').length === 0, '正文不应再有段落徽章');
        assert(!/\.rd-note-btn\s*\{/.test(distCss), 'reader.css 不应再有 .rd-note-btn 规则');
    });
    check('R12-03 条目复选框名称唯一且含笔记内容（同书两条不会同名）', function () {
        const l1 = $('#notesPopup [data-note-id="n1"] [data-note-check]').getAttribute('aria-label');
        const l2 = $('#notesPopup [data-note-id="n2"] [data-note-check]').getAttribute('aria-label');
        const l3 = $('#notesPopup [data-note-id="n3"] [data-note-check]').getAttribute('aria-label');
        assert(/笔记一/.test(l1) && /笔记二/.test(l2) && /笔记三/.test(l3),
            '名称应含笔记内容: ' + [l1, l2, l3].join(' | '));
        assert(l1 !== l2 && l2 !== l3, '不同笔记的名称必须不同');
    });
    // R12-01：24×24 命中区必须**整块**可用。
    // 曾经的 bug：`.nt-item` 行在管理模式也 toggle，而 <label> 的默认激活会把点击再转发给
    // <input>，两者各切一次 → 净零，16px 视觉框外那圈「看起来能点却点不动」。
    // 修法是给 <label> 也加 @click.stop。这里断言「点环净切换一次」，并点第二次复原状态。
    const ringLabel = $('#notesPopup [data-note-id="n2"] [data-note-check]').closest('label');
    const ringBefore = $('[data-note-sel-count]').textContent.replace(/\s/g, '');
    click(ringLabel);
    await sleep(40);
    check('R12-01 点 label 环(24×24 内、16px 视觉框外)也必须净切换一次', function () {
        assert.strictEqual($('[data-note-sel-count]').textContent.replace(/\s/g, ''), '已选3条',
            '点 label 环应恰好 +1（当前 ' + ringBefore + ' → ' +
            $('[data-note-sel-count]').textContent.replace(/\s/g, '') + '）');
    });
    // 第二次点击复原，后续断言依赖「已选 n1 + n3」这个状态
    click(ringLabel);
    await sleep(40);
    check('R12-01 再点一次 label 环复原（净 -1，不是 0 也不是 -2）', function () {
        assert.strictEqual($('[data-note-sel-count]').textContent.replace(/\s/g, ''), ringBefore,
            '再点 label 环应回到 ' + ringBefore + ', 实际 ' +
            $('[data-note-sel-count]').textContent.replace(/\s/g, ''));
    });

    // 再点一次 n1 → 取消
    click($('#notesPopup [data-note-id="n1"] [data-note-check]'));
    await sleep(30);
    check('R12-03 再次点击同一复选框应取消勾选（且只减 1）', function () {
        assert.strictEqual($('[data-note-sel-count]').textContent.replace(/\s/g, ''), '已选1条',
            '实际 ' + $('[data-note-sel-count]').textContent);
    });
    click($('#notesPopup [data-note-id="n1"] [data-note-check]'));
    await sleep(30);

    posted.length = 0;
    click($('#notesPopup [data-note-remove-selected]'));
    await sleep(50);
    const dlg3 = $('.confirm-dlg');
    check('R7-01 确认框文案必须写明数量与涉及的书/章', function () {
        assert(dlg3, '应弹出确认框');
        const text = dlg3.textContent.replace(/\s+/g, ' ');
        assert(/删除\s*2\s*条笔记/.test(text), '标题应含「删除 2 条笔记」, 实际: ' + text);
        assert(/2\s*本书\s*\/\s*2\s*章/.test(text), '明细应含「2 本书 / 2 章」, 实际: ' + text);
        assert(/不可恢复/.test(text), '应说明不可恢复');
        assert(/QA 之书/.test(text) && /另一本书/.test(text), '应列出涉及的书名');
    });
    const noteOk = $('[data-confirm-ok]');
    down(noteOk);
    await sleep(20);
    check('R7-03 确认框内 mousedown 不得关闭笔记浮窗', function () {
        assert($('#notesPopup').classList.contains('open'), 'mousedown 提前关掉了笔记浮窗');
        assert($('.confirm-dlg'), 'mousedown 不应取消确认框');
    });
    click(noteOk);
    await sleep(40);
    check('R9-05 确认后只发一次请求、按钮进入 pending（不可重复提交）', function () {
        const sends = posted.filter(function (m) { return m.type === 'removeNotes'; });
        assert.strictEqual(sends.length, 1, '应恰好发 1 次 removeNotes, 实际 ' + sends.length);
        assert(typeof sends[0].opId === 'string' && sends[0].opId, '必须带 opId');
        assert.strictEqual($('[data-confirm-ok]').disabled, true, 'pending 期间确认按钮应 disabled');
        assert.strictEqual($('#notesPopup [data-note-remove-selected]').disabled, true,
            'pending 期间面板「删除所选」也应 disabled(opRunning)');
    });
    // 成功回包：关闭确认框 + 退出管理 + 清空选择
    const okId3 = posted.filter(function (m) { return m.type === 'removeNotes'; })[0].opId;
    send({ type: 'notes', items: [NOTE_ITEMS[1]] });        // 宿主删完回全量
    send({ type: 'opResult', payload: { opId: okId3, op: 'notes:remove', ok: true, detail: { removed: 2 } } });
    await sleep(60);
    check('R7-03 成功后退出管理模式、清空选择、关闭确认框', function () {
        assert(!$('.confirm-dlg'), '成功后确认框应关闭');
        assert(!$('#notesPopup [data-note-remove-selected]'), '成功后应退出管理模式');
        assert(!$('#notesPopup [data-note-op-error]'), '成功后不应残留错误条');
    });
    // ---- P3-2 回归：组删除也要带 opId，且 pending 期间按钮置灰（不能连开多个 opId）
    // 作用域限定在书组头: 章组头也有同类按钮, 不限定会随分组数变化(工程师提醒)
    const groupDelBtn = $('#notesPopup .nt-book-head [data-note-group-del]');
    check('R9-05 组删除入口存在（非管理模式，两步确认）', function () {
        assert(groupDelBtn, '非管理模式下应有组删除按钮');
        assert(!groupDelBtn.disabled, '空闲状态不应置灰');
    });
    if (groupDelBtn) {
        posted.length = 0;
        click(groupDelBtn);
        await sleep(30);
        check('R7-01 组删除第一次点击只进入「确认删除」态，不发请求', function () {
            assert(/确认删除/.test(groupDelBtn.textContent || ''), '第一次点击应变成「确认删除」');
            assert(!posted.some(function (m) { return m.type === 'removeNoteGroup'; }), '第一次点击不得发请求');
        });
        click(groupDelBtn);
        await sleep(40);
        const grpMsg = posted.filter(function (m) { return m.type === 'removeNoteGroup'; })[0];
        check('R9-05 组删除请求带 opId，且 pending 期间按钮 disabled', function () {
            assert(grpMsg, '第二次点击应发 removeNoteGroup');
            assert(typeof grpMsg.opId === 'string' && grpMsg.opId, 'removeNoteGroup 必须带 opId');
            assert.strictEqual(groupDelBtn.disabled, true, 'pending 期间组删除按钮应 disabled(不能连开 opId)');
        });
        if (grpMsg && grpMsg.opId) {
            send({ type: 'opResult', payload: { opId: grpMsg.opId, op: 'notes:removeGroup', ok: true } });
            await sleep(50);
            check('R9-05 组删除回包后按钮恢复可用（pending 不卡死）', function () {
                const btn = $('#notesPopup .nt-book-head [data-note-group-del]');
                assert(btn && !btn.disabled, '回包后组删除按钮应恢复可用');
            });
        }
    }

    click($('#notesPopup .popup-close'));
    await sleep(30);

    // 失败 → 重试 → 成功 的完整往返（App 保留 confirm 后的重试路径）
    click(menuItem('notes'));
    await sleep(40);
    click($('#notesPopup [data-note-manage]'));
    await sleep(30);
    click($('#notesPopup [data-note-select-all]'));
    await sleep(30);
    posted.length = 0;
    click($('#notesPopup [data-note-remove-selected]'));
    await sleep(40);
    click($('[data-confirm-ok]'));
    await sleep(40);
    const failId = posted.filter(function (m) { return m.type === 'removeNotes'; })[0].opId;
    send({ type: 'opResult', payload: { opId: failId, op: 'notes:remove', ok: false, message: '磁盘写入失败' } });
    await sleep(60);
    check('R7-03 失败后确认框保留且以 role=alert 显示原因（可重试）', function () {
        assert($('.confirm-dlg'), '失败后确认框应保留');
        assert(!$('[data-confirm-ok]').disabled, '失败后确认按钮应恢复可点(可重试)');
        const inDlg = document.querySelector('.confirm-dlg [role="alert"]');
        assert(inDlg && /磁盘写入失败/.test(inDlg.textContent), '确认框内应有 role=alert 的原因');
    });
    posted.length = 0;
    click($('[data-confirm-ok]'));
    await sleep(40);
    check('R9-05 重试能再次提交且仍只发一次', function () {
        const retries = posted.filter(function (m) { return m.type === 'removeNotes'; });
        assert.strictEqual(retries.length, 1, '重试应恰好发 1 次, 实际 ' + retries.length);
        assert.strictEqual(retries[0].opId, failId, '重试沿用同一 opId(同一次用户意图)');
    });
    const retryId = posted.filter(function (m) { return m.type === 'removeNotes'; })[0].opId;
    send({ type: 'opResult', payload: { opId: retryId, op: 'notes:remove', ok: true, detail: { removed: 1 } } });
    await sleep(60);
    check('R7-03 重试成功后收尾干净（确认框关闭、退出管理、错误清空）', function () {
        assert(!$('.confirm-dlg'), '成功后确认框应关闭');
        assert(!$('#notesPopup [data-note-remove-selected]'), '成功后应退出管理模式');
        assert(!$('#notesPopup [data-note-op-error]'), '成功后不应残留错误条');
        assert($('#notesPopup').classList.contains('open'), '成功后应保留笔记浮窗');
    });
    // 退出管理后分组会回到原折叠态，先展开书/章再检查常显操作组
    const noteBookExpand = $('#notesPopup .nt-book-head .nt-expand');
    if (noteBookExpand && noteBookExpand.getAttribute('aria-expanded') === 'false') {
        click(noteBookExpand);
        await sleep(30);
    }
    const noteChapExpand = $('#notesPopup .nt-chap-head .nt-expand');
    if (noteChapExpand && noteChapExpand.getAttribute('aria-expanded') === 'false') {
        click(noteChapExpand);
        await sleep(30);
    }
    check('R11-03/R11-04 笔记操作组常显，不再需要「更多/收起」', function () {
        const item = $('#notesPopup .nt-item');
        assert(item, '前置: 应存在笔记条目');
        assert(!item.querySelector('.nt-more'), '不应再有「更多」开关');
        const acts = item.querySelector('.nt-acts');
        assert(acts, '动作组应存在');
        assert.strictEqual(win.getComputedStyle(acts).display, 'flex', '动作组应默认显示');
        const labels = Array.from(acts.querySelectorAll('.nt-act')).map(function (b) { return b.textContent.trim(); });
        assert(labels.indexOf('编辑') >= 0 && labels.indexOf('删除') >= 0,
            '定位原文/编辑/删除应常显, 实际 ' + labels.join('|'));
    });
    click($('#notesPopup .popup-close'));
    await sleep(30);

    // ------ D4 失败保留确认框对书架/存储同样成立（共享 opResult 路径）
    click(menuItem('shelf'));
    await sleep(40);
    click($('#shelfPopup [data-shelf-batch]'));
    await sleep(30);
    click($('#shelfPopup [data-shelf-select-all]'));
    await sleep(30);
    posted.length = 0;
    click($('#shelfPopup [data-shelf-remove-selected]'));
    await sleep(40);
    click($('[data-confirm-ok]'));
    await sleep(40);
    let alertCountOnFail = 0;
    const bookOp = posted.filter(function (m) { return m.type === 'removeBooks'; })[0];
    send({ type: 'opResult', payload: { opId: bookOp.opId, op: 'books:removeMany', ok: false, message: '写入失败' } });
    await sleep(60);
    check('R7-03 书架失败同样保留确认框 + 选择（共享路径未回归）', function () {
        assert($('.confirm-dlg'), '书架失败后确认框应保留');
        assert($('#shelfPopup [data-shelf-select-all]'), '应仍在管理模式');
        assert(/已选\s*2/.test($('#shelfPopup [data-shelf-sel-count]').textContent || ''),
            '选择应保留');
        const inDlg = document.querySelector('.confirm-dlg [role="alert"]');
        assert(inDlg && /写入失败/.test(inDlg.textContent), '确认框内应有失败原因');
        alertCountOnFail = document.querySelectorAll('[role="alert"]').length;
    });
    // 取消掉，避免影响后续
    click($('[data-confirm-cancel]'));
    await sleep(30);
    click($('#shelfPopup .popup-close'));
    await sleep(30);

    // ------ D4b 历史记录：失败同样保留确认框与选择（第三类危险操作）
    send({
        type: 'history',
        payload: {
            local: [
                { filePath: 'D:/h1.txt', title: '历史一', author: '', chapterIndex: 1, totalChapters: 3, lastReadAt: 1 },
                { filePath: 'D:/h2.txt', title: '历史二', author: '', chapterIndex: 2, totalChapters: 5, lastReadAt: 2 },
            ],
            online: [],
        },
    });
    await sleep(40);
    click(menuItem('history'));
    await sleep(50);
    const histBatch = $('#historyPopup [data-hist-batch]');
    check('前置: 历史面板有管理模式入口', function () {
        assert(histBatch, '历史面板应有 data-hist-batch');
    });
    if (histBatch) {
        click(histBatch);
        await sleep(30);
        click($('#historyPopup [data-hist-select-all]'));
        await sleep(30);
        posted.length = 0;
        click($('#historyPopup [data-hist-remove-selected]'));
        await sleep(40);
        const okH = $('[data-confirm-ok]');
        check('R7-01 历史「删除所选」先弹确认框', function () {
            assert(okH, '历史批量删除应先弹确认框');
            assert(!posted.some(function (m) { return m.type === 'removeHistory'; }), '未确认前不得发 removeHistory');
        });
        if (okH) {
            down(okH);
            await sleep(20);
            check('R7-03 确认框内 mousedown 不得关闭历史浮窗', function () {
                assert($('#historyPopup').classList.contains('open'), 'mousedown 提前关掉了历史浮窗');
                assert($('.confirm-dlg'), 'mousedown 不应取消历史确认框');
            });
            click(okH);
            await sleep(40);
            const histMsg = posted.filter(function (m) { return m.type === 'removeHistory'; })[0];
            send({ type: 'opResult', payload: { opId: histMsg.opId, op: 'history:remove', ok: false, message: '历史文件写入失败' } });
            await sleep(60);
            check('R7-03 历史失败后保留确认框、选择与管理模式', function () {
                assert($('.confirm-dlg'), '历史失败后确认框应保留');
                assert(/已选\s*2/.test($('#historyPopup [data-hist-sel-count]').textContent || ''),
                    '选择应保留, 实际 ' + ($('#historyPopup [data-hist-sel-count]') || {}).textContent);
                const inDlg = document.querySelector('.confirm-dlg [role="alert"]');
                assert(inDlg && /历史文件写入失败/.test(inDlg.textContent), '确认框内应有失败原因');
            });
            click($('[data-confirm-cancel]'));
            await sleep(30);
        }
        click($('#historyPopup .popup-close'));
        await sleep(30);
    }

    // ------ D5 失败提示的"双份"观察（不是给用户的两条不同结论，而是同一句被播报两次）
    // 这里只**测量**不判定（P3 观察项）：确认框内的 alert 与面板级 alert 同时存在。
    console.log('  (观察) 书架失败瞬间同时存在的 role=alert 数 = ' + alertCountOnFail +
        '（书架面板没有面板级错误条，只有确认框内一份；笔记面板则有确认框 + 面板两份同文案）');

    // ------------------------------------------------ 结果
    console.log('');
    if (failures.length) {
        console.error('独立 QA 回归失败 ' + failures.length + ' 项：');
        for (const f of failures) { console.error('  - ' + f.name + '\n    ' + f.message); }
        process.exit(1);
    }
    console.log('独立 QA 回归全部通过 ✔ (静态 CSS / 对比度复算 / DOM 行为)');
    process.exit(0);
})().catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
