/**
 * test-geometry-tokens.js — 「同数两源」与几何令牌的回归线
 *
 * 对应 方案.md 的 A1 / A2 / A3 / C1 / E1 / G1：
 *  1. A1: 列表行高只由 --src-result-h 决定, JS 只给行数(--src-alloc-rows)
 *  2. A2: 菜单宽度只有一份真源(html.menu-collapsed), 不再有 48px 兜底 + JS 写内联 px
 *  3. A3: 侧边箭头尺寸从 --side-nav-w / --side-nav-gap 读, JS 不再写死 56/12
 *  4. C1: 微字号有 --ui-font-xs 令牌, 不再靠 calc(sub - 1px) 临时凑
 *  5. E1: 正文留白按字号等比(em), 不写死像素
 *  6. G1: 注释不再声称「已经改好了」
 *
 * 全部是源码字符串契约（不依赖 happy-dom 的变量求值能力），改坏任一处即红。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CSS = read('webview/reader/reader.css');
const CSS_NO_COMMENT = stripComments(CSS);
const cssSrc = CSS;   // 需要看注释时用原文

// ---------------------------------------------------------------- A1 行高单一来源
assert(CSS_NO_COMMENT.indexOf('calc(var(--src-result-h, 44px) * var(--src-alloc-rows') >= 0,
  '.src-pane 的高度必须由 --src-result-h × --src-alloc-rows 计算');

const srcSearch = read('webview/reader/components/SourceSearchView.vue');
const srcSearchCode = stripComments(srcSearch);   // 注释里可能解释历史, 只查代码
assert(!/\*\s*44\b/.test(srcSearchCode), 'SourceSearchView 不应再出现 * 44(行高必须走变量)');
assert(srcSearchCode.indexOf("'--src-alloc-rows'") >= 0, 'SourceSearchView 应输出 --src-alloc-rows');
assert(srcSearchCode.indexOf("'--src-alloc-h'") < 0, 'SourceSearchView 不应再输出 --src-alloc-h');

const histRule = /\n\s*#historyPopup \.hist-list\s*\{([^}]*)\}/.exec(CSS_NO_COMMENT);
assert(histRule, '找不到 #historyPopup .hist-list 规则');
assert(/max-height:\s*calc\(var\(--src-result-h[^)]*\)\s*\*\s*15\)/.test(histRule[1]),
  '历史列表的 15 行容量也必须用 --src-result-h, 不能写 calc(44px * 15)');

// 令牌定义在 :root(历史面板和书源面板共用)
assert(/--src-result-h:\s*44px/.test(CSS_NO_COMMENT), ':root 应定义 --src-result-h');

// ---------------------------------------------------------------- A2 菜单宽度单一真源
assert(!/var\(--menu-w\s*,\s*48px\)/.test(CSS_NO_COMMENT),
  'CSS 里不应再有 var(--menu-w, 48px) 兜底(真源在 :root)');
assert(/--menu-w:\s*var\(--menu-w-expanded\)/.test(CSS_NO_COMMENT),
  ':root 应定义 --menu-w = var(--menu-w-expanded)');
assert(/html\.menu-collapsed\s*\{[^}]*--menu-w:\s*var\(--menu-w-collapsed\)/.test(CSS_NO_COMMENT),
  '应收起态规则 html.menu-collapsed -> --menu-w-collapsed');

const appVue = read('webview/reader/App.vue');
assert(appVue.indexOf("setProperty('--menu-w'") < 0, 'App.vue 不应再用 JS 写 --menu-w 的像素值');
assert(appVue.indexOf("classList.toggle('menu-collapsed'") >= 0, 'App.vue 应通过 class 切换菜单宽度');

// ---------------------------------------------------------------- A3 箭头尺寸
assert(/--side-nav-w:\s*56px/.test(CSS_NO_COMMENT), ':root 应定义 --side-nav-w');
assert(/--side-nav-gap:\s*12px/.test(CSS_NO_COMMENT), ':root 应定义 --side-nav-gap');

const readerArea = read('webview/reader/components/ReaderArea.vue');
assert(!/const NAV_W = 56/.test(readerArea), 'ReaderArea 不应写死 NAV_W = 56');
assert(!/const NAV_GAP = 12/.test(readerArea), 'ReaderArea 不应写死 NAV_GAP = 12');
assert(readerArea.indexOf("readCssPx('--side-nav-w'") >= 0, 'ReaderArea 应从 --side-nav-w 读箭头宽度');
assert(readerArea.indexOf("readCssPx('--side-nav-gap'") >= 0, 'ReaderArea 应从 --side-nav-gap 读间距');

// ---------------------------------------------------------------- C1 微字号令牌
assert(/--ui-font-xs:\s*11px/.test(CSS_NO_COMMENT), ':root 应定义 --ui-font-xs = 11px(首帧兜底)');
assert(CSS_NO_COMMENT.indexOf('calc(var(--ui-font-sub) - 1px)') < 0,
  '不应再用 calc(var(--ui-font-sub) - 1px) 临时凑微字号');
assert(CSS_NO_COMMENT.indexOf('var(--ui-font-xs)') >= 0, '至少有一处规则应使用 --ui-font-xs');

const storeTs = read('webview/reader/store.ts');
assert(storeTs.indexOf("setProperty('--ui-font-xs'") >= 0, 'applyThemeVars 应写 --ui-font-xs');

// ---------------------------------------------------------------- E1 正文留白等比
const contentRule = /\n\s*#content\s*\{([^}]*)\}/.exec(CSS_NO_COMMENT);
assert(contentRule, '找不到 #content 规则');
assert(/padding:\s*1\.6em 2\.1em 2\.9em/.test(contentRule[1]),
  '#content 的 padding 应改为 em 等比(当前: ' + contentRule[1].match(/padding:[^;]*/) + ')');
assert(contentRule[1].indexOf('26px 34px 46px') < 0, '#content 不应再写死 26px 34px 46px');

// ---------------------------------------------------------------- G1 注释不谎报
assert(cssSrc.indexOf('条目字号与正文一致') < 0, '.cat-item 上方的注释不应再声称「与正文一致」');
assert(cssSrc.indexOf('目录字号与阅读区同步') < 0, '.cat-title 上方的注释不应再声称「与阅读区同步」');
assert(srcSearch.indexOf('不再写死 *44') < 0, 'SourceSearchView 的注释不应再声称「不再写死 *44」');
assert(cssSrc.indexOf('不跟随正文字号') >= 0, '目录字号注释应说明「不跟随正文字号」');

console.log('几何令牌(A1 行高 / A2 菜单宽 / A3 箭头 / C1 微字号 / E1 留白 / G1 注释): 通过');
process.exit(0);
