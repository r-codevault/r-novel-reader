/**
 * test-theme-presets.js — 7 套预设主题的配色契约
 *
 * 这些断言就是 docs/color-audit.html 里那张"缺陷清单"的回归线：
 *   1. 强调色作文字压在留白区(pageBg)、作图标压在面板底(chromeBg)，都要 ≥4.5:1
 *   2. 强调色上的文字 ≥4.5:1（原先是 3:1，导致红底白字只有 2.9:1）
 *   3. 次要文字对更暗的面板底 ≥4.5:1（原先 #RRGGBBAA 叠色只有 3.07~4.12:1）
 *   4. 控件边框 ≥3:1（WCAG 1.4.11），装饰线只需可辨(≥1.3:1)
 *   5. 危险色 ≥4.5:1
 *   6. 三级背景台阶：纸面 → 面板 → 留白，逐级 ≥1.05 / ≥1.08
 *   7. contrastRatio 支持 8 位 hex 与 alpha 合成（否则 muted 会被当成黑色假通过）
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

const { THEMES, contrastRatio, themeById } = require('../dist/settings');

const REQUIRED = ['bg', 'fg', 'pageBg', 'chromeBg', 'chromeBorder', 'borderStrong',
  'accent', 'accentFg', 'muted', 'panelHover', 'danger', 'shadow'];
const failures = [];

assert.strictEqual(THEMES.length, 7, '应有 7 套预设主题');

for (const t of THEMES) {
  for (const key of REQUIRED) {
    assert(t[key], `${t.name} 缺少令牌 ${key}`);
  }
  // 不再存在第二枚强调色：panelAccent 已删除，强调语义只有 accent 一支
  assert.strictEqual(t.panelAccent, undefined, `${t.name} 不应再有 panelAccent（强调色统一为 accent）`);

  const body = contrastRatio(t.fg, t.bg);
  const muted = contrastRatio(t.muted, t.chromeBg);
  const accentText = contrastRatio(t.accent, t.pageBg);
  const accentIcon = contrastRatio(t.accent, t.chromeBg);
  const accentFg = contrastRatio(t.accentFg, t.accent);
  const border = contrastRatio(t.borderStrong, t.chromeBg);
  const soft = contrastRatio(t.chromeBorder, t.chromeBg);
  const danger = contrastRatio(t.danger, t.bg);
  const step1 = contrastRatio(t.bg, t.chromeBg);
  const step2 = contrastRatio(t.chromeBg, t.pageBg);

  if (body < 7) { failures.push(`${t.name} 正文 ${body.toFixed(2)} < 7`); }
  if (muted < 4.5) { failures.push(`${t.name} 次要文字 ${muted.toFixed(2)} < 4.5`); }
  if (accentText < 4.5) { failures.push(`${t.name} 强调色作文字 ${accentText.toFixed(2)} < 4.5`); }
  if (accentIcon < 4.5) { failures.push(`${t.name} 强调色作图标 ${accentIcon.toFixed(2)} < 4.5`); }
  if (accentFg < 4.5) { failures.push(`${t.name} 强调色上的文字 ${accentFg.toFixed(2)} < 4.5`); }
  if (border < 3) { failures.push(`${t.name} 控件边框 ${border.toFixed(2)} < 3`); }
  if (soft < 1.3) { failures.push(`${t.name} 装饰线 ${soft.toFixed(2)} < 1.3`); }
  if (danger < 4.5) { failures.push(`${t.name} 危险色 ${danger.toFixed(2)} < 4.5`); }
  if (step1 < 1.05) { failures.push(`${t.name} 纸面/面板台阶 ${step1.toFixed(2)} < 1.05`); }
  if (step2 < 1.08) { failures.push(`${t.name} 面板/留白台阶 ${step2.toFixed(2)} < 1.08`); }
}

assert.deepStrictEqual(failures, [], '预设主题存在不达标项:\n  ' + failures.join('\n  '));

// contrastRatio 的 alpha 支持：8 位 hex 必须按"合成到背景"计算，不能退化成黑色
assert.ok(Math.abs(contrastRatio('#00000080', '#ffffff') - contrastRatio('#808080', '#ffffff')) < 0.15,
  '8 位 hex 应按 alpha 合成计算（#00000080 于白底 ≈ #808080）');
assert.ok(Math.abs(contrastRatio('rgba(0,0,0,.5)', '#ffffff') - contrastRatio('#808080', '#ffffff')) < 0.15,
  'rgba() 应按 alpha 合成计算');
assert.ok(contrastRatio('#26262699', '#ffffff') < 5, '旧的 muted 写法应被算成半透明灰（修复前会被当成黑色算出 21:1）');

// 强调色不能再是正文色（旧版浅色主题 accent === fg，导致"高亮"与"正文"同色）
for (const t of THEMES) {
  if (t.id === 'dark') { continue; }
  assert.notStrictEqual(t.accent.toLowerCase(), t.fg.toLowerCase(),
    `${t.name} 的强调色不应等于正文色`);
}

// 取色黄金值(v1.36.1): 强调色是各主题的"本相"色, danger 必须与强调色拉开区分度。
// 上面只锁门槛, 不锁具体色值 —— 有人把朱红换成别的红, 门槛依然能过, 但设计意图已经变了。
const GOLDEN = {
  white: { accent: '#b83729', danger: '#8f1d16' },
  beige: { accent: '#8c4423', danger: '#8f1d16' },
  xuan: { accent: '#835529', danger: '#8c1d18' },
  sepia: { accent: '#8d3f22', danger: '#8c1d18' },
  green: { accent: '#2b6135', danger: '#8c1d18' },
  blue: { accent: '#2c5a8a', danger: '#8c1d18' },
  dark: { accent: '#d8a84e', danger: '#ff9d93' },
};
for (const t of THEMES) {
  const g = GOLDEN[t.id];
  assert(g, `未登记主题 ${t.id} 的黄金值`);
  assert.strictEqual(t.accent.toLowerCase(), g.accent, `${t.name} accent 取色偏离设计值(期望 ${g.accent})`);
  assert.strictEqual(t.danger.toLowerCase(), g.danger, `${t.name} danger 取色偏离设计值(期望 ${g.danger})`);
}
// 危险色与强调色的"身份"必须能分开, 否则用户会把删除按钮当成高亮
for (const t of THEMES) {
  assert.notStrictEqual(t.accent.toLowerCase(), t.danger.toLowerCase(), `${t.name} danger 不应等于 accent`);
}

// 宣纸主题的纸纹层: CSS 必须存在该主题专属纹理规则(否则"宣纸"退化成普通米色)
const fsx = require('fs');
const pathx = require('path');
const cssText = fsx.readFileSync(pathx.join(__dirname, '..', 'webview', 'reader', 'reader.css'), 'utf8');
assert(cssText.indexOf('html[data-theme="xuan"]') >= 0, '宣纸主题应带纸纹层规则');
assert(cssText.indexOf('assets/paper-xuan.png') >= 0, '宣纸纸纹应引用 assets/paper-xuan.png 贴图');
// 贴图必须被构建期内联(webview 无 localResourceRoots, 外链图片会 404)
const builtCssPath = pathx.join(__dirname, '..', 'dist-webview', 'reader.css');
if (fsx.existsSync(builtCssPath)) {
  const builtCss = fsx.readFileSync(builtCssPath, 'utf8');
  assert(builtCss.indexOf('data:image/png;base64') >= 0, '构建产物应把纸纹贴图内联成 data URI');
  assert(builtCss.indexOf('url(./assets/paper-xuan.png)') < 0, '构建产物不应残留贴图外链');
}
// webview CSP 必须放行 data: 图片, 否则背景图被 default-src none 直接拦截
const panelTs = fsx.readFileSync(pathx.join(__dirname, '..', 'src', 'readerPanel.ts'), 'utf8');
assert(panelTs.indexOf('img-src data:') >= 0, 'readerPanel 的 CSP 应包含 img-src data: (否则纸纹不显示)');
const xuanTheme = THEMES.find((t) => t.id === 'xuan');
assert(xuanTheme, '应存在 id=xuan 的宣纸主题');
assert.strictEqual(THEMES[THEMES.findIndex((t) => t.id === 'xuan') - 1].id, 'beige', '宣纸应紧挨在米白右侧');

// 主题分发不受影响
assert.strictEqual(themeById('sepia').name, '羊皮纸');
assert.strictEqual(themeById('nope').name, THEMES[0].name, '未知主题应回退第一套');

console.log(`预设主题契约通过 ✔ (7 套, 最低: 正文 ${Math.min.apply(null, THEMES.map((t) => contrastRatio(t.fg, t.bg))).toFixed(2)}:1, ` +
  `次要文字 ${Math.min.apply(null, THEMES.map((t) => contrastRatio(t.muted, t.chromeBg))).toFixed(2)}:1, ` +
  `强调 ${Math.min.apply(null, THEMES.map((t) => contrastRatio(t.accent, t.pageBg))).toFixed(2)}:1, ` +
  `控件边框 ${Math.min.apply(null, THEMES.map((t) => contrastRatio(t.borderStrong, t.chromeBg))).toFixed(2)}:1)`);
