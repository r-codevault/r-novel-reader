/**
 * test-ui-font.js — 「界面字号」(uiFontSize) 契约
 *
 *  1. 默认值 14 / 范围 12–20 / 步进 1
 *  2. clampUiFont: 夹取 + 取整 + 非法输入回落
 *  3. uiFontVars:  main=主值, sub=max(11, 主-2), title=主+1
 *  4. 持久化: sanitize 白名单必须放行(漏放行 = 点了没反应) + reset 回默认
 *  5. 独立性: 改正文字号不动界面字号, 反之亦然
 *  6. 源码契约: reader.css 五处字面量已变量化, :root 兜底值不变,
 *     store 写的是 --ui-font* 而不是 --font-size
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// dist/settings.js 顶层 import 'vscode' —— 先打桩再 require(同 test-theme-presets.js)
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { UI_FONT, clampUiFont, uiFontVars } = require('../dist/uiFont');
const { DEFAULT_SETTINGS, SettingsStore } = require('../dist/settings');

// ---------------------------------------------------------------- 1. 默认值与范围
assert.strictEqual(DEFAULT_SETTINGS.uiFontSize, 14, '默认界面字号应为 14px');
assert.strictEqual(UI_FONT.min, 12, '下限应为 12px');
assert.strictEqual(UI_FONT.max, 20, '上限应为 20px');
assert.strictEqual(UI_FONT.step, 1, '步进应为 1px');

// ---------------------------------------------------------------- 2. 夹取 / 取整 / 非法输入
assert.strictEqual(clampUiFont(11), 12, '11 应夹到 12');
assert.strictEqual(clampUiFont(21), 20, '21 应夹到 20');
assert.strictEqual(clampUiFont(20.6), 20, '应取整后再夹取(21 -> 20)');
assert.strictEqual(clampUiFont(14.4), 14, '14.4 应取整为 14');
assert.strictEqual(clampUiFont(NaN), 14, 'NaN 应回落默认 14');
assert.strictEqual(clampUiFont(Infinity), 14, 'Infinity 应回落默认 14');
assert.strictEqual(clampUiFont('16'), 14, '字符串不应被当作数字');
assert.strictEqual(clampUiFont(undefined), 14, 'undefined 应回落默认 14');

// ---------------------------------------------------------------- 3. 派生量
const d14 = uiFontVars(14);
assert.deepStrictEqual([d14.main, d14.sub, d14.title], ['14px', '12px', '15px'], '14 档应为 14/12/15');
const d12 = uiFontVars(12);
assert.deepStrictEqual([d12.main, d12.sub, d12.title], ['12px', '11px', '13px'], '12 档副字号应被 11px 地板兜住');
const d20 = uiFontVars(20);
assert.deepStrictEqual([d20.main, d20.sub, d20.title], ['20px', '18px', '21px'], '20 档应为 20/18/21');
assert.strictEqual(uiFontVars(undefined).main, '14px', '非法输入应回落默认值');

// ---------------------------------------------------------------- 4/5. 持久化 + 独立性
const mem = {};
const store = new SettingsStore({
  get: (k, d) => (k in mem ? mem[k] : d),
  // 真实 Memento 在 value === undefined 时会删除键(而不是留一个 undefined),
  // 这里必须同构, 否则 reset() 后 get() 会把 undefined 送进 sanitize 抛错
  update: async (k, v) => { if (v === undefined) { delete mem[k]; } else { mem[k] = v; } },
});

(async function () {
  const a = await store.update({ uiFontSize: 18 });
  assert.strictEqual(a.uiFontSize, 18, 'uiFontSize 必须能落盘(sanitize 漏放行会静默丢弃)');
  assert.strictEqual(a.fontSize, DEFAULT_SETTINGS.fontSize, '改界面字号不得影响正文字号');

  const b = await store.update({ uiFontSize: 99 });
  assert.strictEqual(b.uiFontSize, 20, '超上限应夹到 20');
  const c = await store.update({ uiFontSize: 5 });
  assert.strictEqual(c.uiFontSize, 12, '低于下限应夹到 12');
  const c2 = await store.update({ uiFontSize: '16' });
  assert.strictEqual(c2.uiFontSize, 12, '非数字应被 sanitize 忽略(保留原值)');

  const d = await store.update({ fontSize: 32 });
  assert.strictEqual(d.uiFontSize, 12, '改正文字号不得影响界面字号');
  assert.strictEqual(d.fontSize, 32, '正文字号本身应正常保存');

  const e = await store.reset();
  assert.strictEqual(e.uiFontSize, 14, '恢复默认后界面字号应回到 14');
  assert.strictEqual(e.fontSize, DEFAULT_SETTINGS.fontSize, '恢复默认后正文字号应回默认');

  // ---------------------------------------------------------------- 6. 源码契约
  const ROOT = path.join(__dirname, '..');
  // 去注释: 断言不能被注释里的文字骗过(本文件刚在注释里写了 14/12/15)
  const css = fs.readFileSync(path.join(ROOT, 'webview', 'reader', 'reader.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  assert(/--ui-font:\s*14px/.test(css), ':root 应保留 --ui-font: 14px 首帧兜底');
  assert(/--ui-font-sub:\s*12px/.test(css), ':root 应保留 --ui-font-sub: 12px 首帧兜底');
  assert(/--ui-font-title:\s*15px/.test(css), ':root 应保留 --ui-font-title: 15px 首帧兜底');

  /** 取以该选择器开头的规则体(行首锚定, 避免匹配到 .cat-head .cat-btn 这类后代写法) */
  const ruleOf = function (sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('^\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm').exec(css);
    assert(m, '找不到规则 ' + sel);
    return m[1];
  };
  assert(/font-size:\s*var\(--ui-font-sub\)/.test(ruleOf('.cat-btn')), '.cat-btn 应跟随 --ui-font-sub');
  assert(/font-size:\s*var\(--ui-font-title\)/.test(ruleOf('.cat-close')), '.cat-close 应跟随 --ui-font-title');
  assert(/font-size:\s*calc\(var\(--ui-font\)\s*\+\s*4px\)/.test(ruleOf('.preview-add')),
    '.preview-add 图标字号应为 calc(var(--ui-font) + 4px)(默认仍 18px)');
  assert(/font-size:\s*var\(--ui-font-sub\)/.test(ruleOf('.preview-add::after')),
    '.preview-add 气泡应跟随 --ui-font-sub');
  assert(/font-size:\s*var\(--ui-font-sub\)/.test(ruleOf('.statusbar')), '.statusbar 应跟随 --ui-font-sub');

  // 这五条规则不允许再留固定字面量(默认档数值相同, 但必须走变量)
  for (const pair of [['.cat-btn', '12px'], ['.cat-close', '15px'], ['.preview-add', '18px'],
    ['.preview-add::after', '12px'], ['.statusbar', '12px']]) {
    assert(ruleOf(pair[0]).indexOf('font-size: ' + pair[1]) < 0, pair[0] + ' 不应再有固定 ' + pair[1]);
  }

  // store 侧: 三个变量真的被写进去(而不是只定义了常量)
  const storeSrc = fs.readFileSync(path.join(ROOT, 'webview', 'reader', 'store.ts'), 'utf8');
  for (const v of ['--ui-font', '--ui-font-sub', '--ui-font-title']) {
    assert(storeSrc.indexOf("setProperty('" + v + "'") >= 0, 'applyThemeVars 应写 ' + v);
  }
  assert(storeSrc.indexOf("setProperty('--font-size', s.uiFontSize") < 0,
    '界面字号绝不能写进 --font-size(R4-01 边界)');
  assert(storeSrc.indexOf('stepUiFontSize') >= 0, 'store 应导出 stepUiFontSize');

  // 面板侧: 入口存在且带可访问名称
  const panel = fs.readFileSync(path.join(ROOT, 'webview', 'reader', 'components', 'SettingsPanel.vue'), 'utf8');
  assert(panel.indexOf('界面字号') >= 0, '设置面板应有「界面字号」行');
  assert(/stepUiFontSize\(-1\)/.test(panel) && /stepUiFontSize\(1\)/.test(panel), '应有 ±1 步进');
  assert(/aria-label="[^"]*界面字号/.test(panel), '步进按钮应有 aria-label');

  console.log('界面字号(默认 14 / 范围 12–20 / 派生 11+ / 独立性 / 持久化 / CSS 契约): 通过');
  process.exit(0);
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
