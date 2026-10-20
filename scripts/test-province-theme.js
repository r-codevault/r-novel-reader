/**
 * test-province-theme.js — 地域色彩主题单测
 *
 * 核心: 34 个省的推导色板必须全部满足 WCAG 对比度门槛, 否则会出现"字看不清"
 *  - 正文/纸面     >= 7:1   (AAA 正文)
 *  - 次要文字/纸面 >= 4.5:1 (AA)
 *  - 强调色/纸面   >= 4.5:1 (强调色常用于图标/当前章, 需正文级)
 *  - 主色上的字    >= 3:1   (大字号/图形级)
 */
'use strict';
const assert = require('assert');

// dist 里 settings 依赖 vscode
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { provinceTheme, contrastRatio, themeById, SettingsStore, DEFAULT_SETTINGS } = require('../dist/settings');
const { PROVINCES } = require('../dist/provinceColors');

assert.strictEqual(PROVINCES.length, 34, '应有 34 个省级区域');

const codes = new Set();
const failures = [];
for (const p of PROVINCES) {
  assert(!codes.has(p.code), '省份代码应唯一: ' + p.code);
  codes.add(p.code);
  assert(p.colors.length >= 4, `${p.name} 色卡应至少有 4 个颜色`);
  for (const c of p.colors) {
    assert(/^#[0-9A-F]{6}$/.test(c.hex), `${p.name}/${c.name} 色值格式应为 #RRGGBB: ${c.hex}`);
  }

  const t = provinceTheme(p.code);
  const bodyContrast = contrastRatio(t.fg, t.bg);
  // 次要文字与控件边框的最差底色都是更暗的面板底 chromeBg
  const mutedContrast = contrastRatio(t.muted, t.chromeBg);
  // 强调色要当"当前章文字"用, 压在更暗的留白区 pageBg 上
  const accentContrast = contrastRatio(t.accent, t.pageBg);
  const accentFgContrast = contrastRatio(t.accentFg, t.accent);
  const borderContrast = contrastRatio(t.borderStrong, t.chromeBg);
  const dangerContrast = contrastRatio(t.danger, t.bg);
  if (bodyContrast < 7) {
    failures.push(`${p.name} 正文对比度 ${bodyContrast.toFixed(2)} < 7`);
  }
  if (mutedContrast < 4.5) {
    failures.push(`${p.name} 次要文字对比度 ${mutedContrast.toFixed(2)} < 4.5`);
  }
  if (accentContrast < 4.5) {
    failures.push(`${p.name} 强调色作文字 ${accentContrast.toFixed(2)} < 4.5`);
  }
  if (accentFgContrast < 4.5) {
    failures.push(`${p.name} 强调色上的文字 ${accentFgContrast.toFixed(2)} < 4.5`);
  }
  if (borderContrast < 3) {
    failures.push(`${p.name} 控件边框 ${borderContrast.toFixed(2)} < 3`);
  }
  if (dangerContrast < 4.5) {
    failures.push(`${p.name} 危险色 ${dangerContrast.toFixed(2)} < 4.5`);
  }
  // 三级背景台阶: 纸面 → 面板 → 留白 必须逐级可辨
  const step1 = contrastRatio(t.bg, t.chromeBg);
  const step2 = contrastRatio(t.chromeBg, t.pageBg);
  if (step1 < 1.05 || step2 < 1.08) {
    failures.push(`${p.name} 背景台阶不足 (纸面/面板 ${step1.toFixed(2)}, 面板/留白 ${step2.toFixed(2)})`);
  }
  assert.strictEqual(t.id, 'province', '主题 id 应为 province');
  assert.strictEqual(t.name, p.name, '主题名应等于省份名');
}

assert.deepStrictEqual(failures, [], '存在对比度不达标的省份:\n  ' + failures.join('\n  '));

// 地域色相必须真的生效(不是全白): 8bit 量化下同色相省份会重合, 用经验阈值兜底
// 说明: 34 省里红/黄系占比高, 纸面色实际能区分出 ~17 种; 地域辨识度主要由留白区承担
const bgSet = new Set(PROVINCES.map((p) => provinceTheme(p.code).bg));
const pageSet = new Set(PROVINCES.map((p) => provinceTheme(p.code).pageBg));
assert(bgSet.size >= 15, `省份纸面色应有差异(实际 ${bgSet.size} 种)`);
const accentSet = new Set(PROVINCES.map((p) => provinceTheme(p.code).accent));
assert(accentSet.size >= 25, `省份强调色应有足够区分度(实际 ${accentSet.size} 种)`);
assert(pageSet.size >= 16, `省份留白区色应有差异(实际 ${pageSet.size} 种)`);

// themeById 支持 province; 未知省份回退北京
assert.strictEqual(themeById('province', '310000').name, '上海', 'themeById(province, 310000) 应为上海');
assert.strictEqual(themeById('province', 'nope').name, themeById('province', DEFAULT_SETTINGS.province).name,
  '未知省份应回退到默认省份');
assert.strictEqual(themeById('sepia').name, '羊皮纸', '预设主题不受影响');

// 回归: province 主题与省份必须能真正落盘(白名单曾漏放行 custom 导致静默丢弃)
(async function () {
  const mem = {};
  const store = new SettingsStore({
    get: (k, d) => (k in mem ? mem[k] : d),
    update: async (k, v) => { mem[k] = v; },
  });
  const next = await store.update({ theme: 'province', province: '440000' });
  assert.strictEqual(next.theme, 'province', 'province 主题必须能保存');
  assert.strictEqual(next.province, '440000', '省份代码必须能保存');

  // 非法省份不应写入, 但仍保留原值
  const bad = await store.update({ province: '999999' });
  assert.strictEqual(bad.province, '440000', '非法省份代码应被忽略(保留原值)');

  console.log(`地域色彩测试全部通过 ✔ (34 省, 最低正文对比度 ${Math.min.apply(null, PROVINCES.map((p) => contrastRatio(provinceTheme(p.code).fg, provinceTheme(p.code).bg))).toFixed(2)}:1)`);
})();
