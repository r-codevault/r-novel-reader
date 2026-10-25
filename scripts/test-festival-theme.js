/**
 * test-festival-theme.js — 传统节日主题单测
 *
 * 覆盖: 23 套齐全(18 日景 + 5 夜场)/唯一 + 全量对比度契约(10 条) + §4.3 快照
 *       + 未知 id 回退 + themeById 四参分发 + 设置落盘(白名单回归)
 *
 * 与 test-term-theme.js 同构: 先桩掉 vscode 模块再 require dist/settings。
 */
'use strict';
const assert = require('assert');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        getConfiguration: () => ({ get: (_k, d) => d, has: () => false }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { festivalTheme, themeById, contrastRatio, SettingsStore, DEFAULT_SETTINGS } = require('../dist/settings');
const { FESTIVALS, FESTIVALS_DAYLIGHT, DEFAULT_FESTIVAL_ID } = require('../dist/festivals');

// ---------------------------------------------------------------- 数据层
assert.strictEqual(FESTIVALS.length, 23, '应为 18 日景 + 5 夜场');
assert.strictEqual(FESTIVALS.filter((f) => !f.night).length, 18, '日景应为 18 项');
assert.strictEqual(FESTIVALS.filter((f) => f.night).length, 5, '夜场应为 5 项');
assert.strictEqual(FESTIVALS_DAYLIGHT.length, 18, '手动可选(日景)应为 18 项');
assert(DEFAULT_FESTIVAL_ID === 'chunjie', '默认节日应为春节');

const ids = new Set();
const names = new Set();
const HEX = /^#[0-9A-Fa-f]{6}$/;
for (const f of FESTIVALS) {
  assert(!ids.has(f.id), '节日 id 应唯一: ' + f.id);
  assert(!names.has(f.name), '节日名应唯一: ' + f.name);
  ids.add(f.id);
  names.add(f.name);
  for (const key of ['main', 'aux', 'dot']) {
    assert(f[key] && typeof f[key].name === 'string' && f[key].name.length > 0, `${f.name} 缺少 ${key} 传统色名`);
    assert(HEX.test(f[key].hex), `${f.name}.${key} 色值格式应为 #RRGGBB: ${f[key].hex}`);
  }
  assert(['春', '夏', '秋', '冬'].indexOf(f.season) >= 0, `${f.name} 季节分组非法: ${f.season}`);
  assert(['木', '火', '土', '金', '水'].indexOf(f.wuxing) >= 0, `${f.name} 五行归属非法: ${f.wuxing}`);
  assert(typeof f.date === 'string' && f.date.length > 0, `${f.name} 缺少农历日期描述`);
  assert(typeof f.slogan === 'string' && f.slogan.length > 0, `${f.name} 缺少典故文案`);
  if (f.night) {
    assert(/-night$/.test(f.id), `${f.name} 夜场 id 应以 -night 结尾: ${f.id}`);
  } else {
    assert(!/-night$/.test(f.id), `${f.name} 日景 id 不应带 -night: ${f.id}`);
  }
}

// ---------------------------------------------------------------- 对比度契约(10 条)
const failures = [];
for (const f of FESTIVALS) {
  const t = festivalTheme(f.id);
  if (t.id !== f.id) { failures.push(`${f.name} 主题 id 应为 ${f.id}(实际 ${t.id})`); }
  if (t.name !== f.name) { failures.push(`${f.name} 主题名不匹配(实际 ${t.name})`); }

  const body = contrastRatio(t.fg, t.bg);
  const muted = contrastRatio(t.muted, t.chromeBg);
  const accentPage = contrastRatio(t.accent, t.pageBg);
  const accentChrome = contrastRatio(t.accent, t.chromeBg);
  const accentFg = contrastRatio(t.accentFg, t.accent);
  const borderStrong = contrastRatio(t.borderStrong, t.chromeBg);
  const danger = contrastRatio(t.danger, t.bg);
  const stepBgChrome = contrastRatio(t.bg, t.chromeBg);
  const stepChromePage = contrastRatio(t.chromeBg, t.pageBg);

  if (body < 7) { failures.push(`${f.name} 正文对比度 ${body.toFixed(2)} < 7`); }
  if (muted < 4.5) { failures.push(`${f.name} 次要文字对比度 ${muted.toFixed(2)} < 4.5`); }
  if (accentPage < 4.5) { failures.push(`${f.name} 强调色(作文字) ${accentPage.toFixed(2)} < 4.5`); }
  if (accentChrome < 4.5) { failures.push(`${f.name} 强调色(作图标) ${accentChrome.toFixed(2)} < 4.5`); }
  if (accentFg < 4.5) { failures.push(`${f.name} 强调色上的文字 ${accentFg.toFixed(2)} < 4.5`); }
  if (borderStrong < 3) { failures.push(`${f.name} 控件边框 ${borderStrong.toFixed(2)} < 3`); }
  if (danger < 4.5) { failures.push(`${f.name} 危险色 ${danger.toFixed(2)} < 4.5`); }
  if (contrastRatio(t.dangerFg, t.danger) < 4.5) {
    failures.push(`${f.name} 危险底色上的文字 ${contrastRatio(t.dangerFg, t.danger).toFixed(2)} < 4.5`);
  }
  if (contrastRatio(t.success, t.chromeBg) < 4.5) {
    failures.push(`${f.name} 成功状态文字 ${contrastRatio(t.success, t.chromeBg).toFixed(2)} < 4.5`);
  }
  if (stepBgChrome < 1.05) { failures.push(`${f.name} 纸面/面板台阶 ${stepBgChrome.toFixed(2)} < 1.05`); }
  if (stepChromePage < 1.08) { failures.push(`${f.name} 面板/留白台阶 ${stepChromePage.toFixed(2)} < 1.08`); }
  if (!!t.isDark !== !!f.night) { failures.push(`${f.name} isDark 标记错误(实际 ${t.isDark})`); }
  // 强调色不得等于正文色(旧版浅色主题的缺陷)
  if (t.accent === t.fg) { failures.push(`${f.name} 强调色与正文色相同`); }
}
assert.deepStrictEqual(failures, [], '存在不达标的节日主题:\n  ' + failures.join('\n  '));

// ---------------------------------------------------------------- §4.3 快照(浮点容差 0.01)
const snap = (id) => {
  const t = festivalTheme(id);
  return {
    body: +contrastRatio(t.fg, t.bg).toFixed(2),
    muted: +contrastRatio(t.muted, t.chromeBg).toFixed(2),
    accent: +contrastRatio(t.accent, t.pageBg).toFixed(2),
  };
};
assert.deepStrictEqual(snap('chunjie'), { body: 12.62, muted: 4.66, accent: 4.59 });
assert.deepStrictEqual(snap('zhongqiu-night'), { body: 11.37, muted: 4.56, accent: 10.88 });

// ---------------------------------------------------------------- 回退与分发
assert.strictEqual(festivalTheme('nope').id, 'chunjie', '未知 id 应回退春节');
assert.strictEqual(festivalTheme().id, 'chunjie', '缺省应回退春节');
assert.strictEqual(festivalTheme('nope').name, '春节', '未知 id 回退的主题名应为春节');
assert.strictEqual(festivalTheme('chuxi-night').isDark, true, '夜场应为深色主题');
assert.strictEqual(festivalTheme('chuxi').isDark, undefined, '日景不应标记深色');
assert.strictEqual(themeById('festival', undefined, undefined, 'duanwu').name, '端午', 'themeById 应支持第 4 参分发');
assert.strictEqual(themeById('festival').name, '春节', 'festival 缺省应回退春节');
// 旧的三参/单参调用必须继续可用
assert.strictEqual(themeById('sepia').name, '羊皮纸', '单参调用(预设)不受影响');
assert.strictEqual(themeById('term', undefined, 'daxue').name, '大雪', '三参调用(节气)不受影响');
assert.strictEqual(themeById('province', '440000').name, '广东', '两参调用(省份)不受影响');

// 23 套纸面色应有区分度(不至于一个样)
const bgs = new Set(FESTIVALS.map((f) => festivalTheme(f.id).bg));
assert(bgs.size >= 20, `节日纸面色应有明显差异(实际 ${bgs.size} 种)`);

// ---------------------------------------------------------------- 设置落盘(白名单回归)
(async function () {
  const mem = {};
  const store = new SettingsStore({
    get: (k, d) => (k in mem ? mem[k] : d),
    update: async (k, v) => { mem[k] = v; },
  });

  assert.strictEqual(DEFAULT_SETTINGS.festival, 'chunjie', '默认设置的节日应为春节');

  const next = await store.update({ theme: 'festival', festival: 'duanwu' });
  assert.strictEqual(next.theme, 'festival', 'festival 主题必须能保存(白名单放行)');
  assert.strictEqual(next.festival, 'duanwu', '节日 id 必须能保存');

  const night = await store.update({ theme: 'festival', festival: 'zhongqiu-night' });
  assert.strictEqual(night.festival, 'zhongqiu-night', '夜场 id 也应可保存(自动切换会写入)');

  const bad = await store.update({ festival: 'not-a-festival' });
  assert.strictEqual(bad.festival, 'zhongqiu-night', '非法节日应被忽略(保留原值)');

  const badTheme = await store.update({ theme: 'festival-nope' });
  assert.strictEqual(badTheme.theme, 'festival', '非法主题名应被忽略(保留原值)');

  // 最低值汇总(报告用)
  const low = (fn) => Math.min.apply(null, FESTIVALS.map((f) => fn(festivalTheme(f.id))));
  const lows = {
    body: low((t) => contrastRatio(t.fg, t.bg)),
    muted: low((t) => contrastRatio(t.muted, t.chromeBg)),
    accent: low((t) => contrastRatio(t.accent, t.pageBg)),
    accentFg: low((t) => contrastRatio(t.accentFg, t.accent)),
    border: low((t) => contrastRatio(t.borderStrong, t.chromeBg)),
    danger: low((t) => contrastRatio(t.danger, t.bg)),
  };
  console.log(
    `节日主题契约通过 ✔ (23 套 = 18 日景 + 5 夜场; 最低值 正文 ${lows.body.toFixed(2)} / 次要 ${lows.muted.toFixed(2)}` +
    ` / 强调 ${lows.accent.toFixed(2)} / 反白 ${lows.accentFg.toFixed(2)} / 边框 ${lows.border.toFixed(2)}` +
    ` / 危险 ${lows.danger.toFixed(2)})`
  );
})();
