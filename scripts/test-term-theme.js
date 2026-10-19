/**
 * test-term-theme.js — 廿四节气主题单测
 *
 * 覆盖: 24 项齐全/唯一 + 全量对比度达标 + themeById 分发 + 设置落盘
 */
'use strict';
const assert = require('assert');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { termTheme, themeById, contrastRatio, SettingsStore, DEFAULT_SETTINGS } = require('../dist/settings');
const { SOLAR_TERMS, DEFAULT_TERM_ID } = require('../dist/solarTerms');

assert.strictEqual(SOLAR_TERMS.length, 24, '廿四节气应有 24 项');

const ids = new Set();
const names = new Set();
const failures = [];
for (const t of SOLAR_TERMS) {
  assert(!ids.has(t.id), '节气 id 应唯一: ' + t.id);
  assert(!names.has(t.name), '节气名应唯一: ' + t.name);
  ids.add(t.id);
  names.add(t.name);
  assert(/^#[0-9A-F]{6}$/.test(t.hex), `${t.name} 色值格式应为 #RRGGBB: ${t.hex}`);
  assert(['春', '夏', '秋', '冬'].indexOf(t.season) >= 0, `${t.name} 季节分组非法: ${t.season}`);
  assert(t.color && t.color.length > 0, `${t.name} 应有传统色名`);

  const theme = termTheme(t.id);
  const body = contrastRatio(theme.fg, theme.bg);
  const muted = contrastRatio(theme.muted, theme.bg);
  const accent = contrastRatio(theme.accent, theme.bg);
  if (theme.id !== 'term') { failures.push(`${t.name} 主题 id 应为 term`); }
  if (theme.name !== t.name) { failures.push(`${t.name} 主题名不匹配`); }
  if (body < 7) { failures.push(`${t.name} 正文对比度 ${body.toFixed(2)} < 7`); }
  if (muted < 4.5) { failures.push(`${t.name} 次要文字对比度 ${muted.toFixed(2)} < 4.5`); }
  if (accent < 4.5) { failures.push(`${t.name} 强调色对比度 ${accent.toFixed(2)} < 4.5`); }
}
assert.deepStrictEqual(failures, [], '存在不达标的节气:\n  ' + failures.join('\n  '));

// 四季各 6 个
for (const s of ['春', '夏', '秋', '冬']) {
  const n = SOLAR_TERMS.filter((t) => t.season === s).length;
  assert.strictEqual(n, 6, `${s} 季应有 6 个节气(实际 ${n})`);
}

// 纸面色应有区分度(不至于 24 个节气一个样)
const bgs = new Set(SOLAR_TERMS.map((t) => termTheme(t.id).bg));
assert(bgs.size >= 12, `节气纸面色应有明显差异(实际 ${bgs.size} 种)`);

// themeById 分发
assert.strictEqual(themeById('term', undefined, 'shuangjiang').name, '霜降', 'themeById(term, shuangjiang) 应为霜降');
assert.strictEqual(themeById('term', undefined, 'nope').name, themeById('term', undefined, DEFAULT_TERM_ID).name,
  '未知节气应回退默认节气');
assert.strictEqual(themeById('sepia').name, '羊皮纸', '预设主题不受影响');

// 设置落盘(白名单回归)
(async function () {
  const mem = {};
  const store = new SettingsStore({
    get: (k, d) => (k in mem ? mem[k] : d),
    update: async (k, v) => { mem[k] = v; },
  });
  const next = await store.update({ theme: 'term', term: 'daxue' });
  assert.strictEqual(next.theme, 'term', 'term 主题必须能保存(白名单)');
  assert.strictEqual(next.term, 'daxue', '节气 id 必须能保存');

  const bad = await store.update({ term: 'not-a-term' });
  assert.strictEqual(bad.term, 'daxue', '非法节气应被忽略(保留原值)');

  console.log(`廿四节气测试全部通过 ✔ (24 项, 最低正文对比度 ${Math.min.apply(null, SOLAR_TERMS.map((t) => contrastRatio(termTheme(t.id).fg, termTheme(t.id).bg))).toFixed(2)}:1)`);
})();
