/**
 * test-daily-color.js — 「每日一色」单测
 *
 * 覆盖: 官网 HTML 解析(含异常输入) + 本地按日轮换 + 色板对比度 + 设置落盘
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

const { parseDailyColor } = require('../dist/dailyColor');
const {
  localDailyColor, beijingDateKey, colorTheme, themeById, contrastRatio, SettingsStore,
} = require('../dist/settings');

// ---------- 1) 官网页面解析 ----------
// 结构与线上一致: 卡片 <a href="/color/名字" style="background-color:#hex;…"> 内嵌「今日之色」
const fixture = `<!DOCTYPE html><html><body>
<section><div style="background:var(--accent);"></div></section>
<a href="/color/法翠" class="relative rounded-3xl" style="background-color:#108B96;aspect-ratio:1 / 1;">
  <div class="absolute inset-0"><p class="text-sm">今日之色</p><p class="serif-cn">法翠</p><p>Fǎ Cuì</p></div>
</a></body></html>`;
const parsed = parseDailyColor(fixture);
assert(parsed, '应能解析出今日色');
assert.strictEqual(parsed.name, '法翠', '色名应为法翠');
assert.strictEqual(parsed.hex, '#108B96', '色值应为 #108B96');

// 异常输入不应抛错, 一律返回 null(调用方回退本地)
assert.strictEqual(parseDailyColor('<html>nothing</html>'), null, '无标记应返回 null');
assert.strictEqual(parseDailyColor('<div style="background-color:#123456"></div>今日之色'), null, '缺色名应返回 null');
assert.strictEqual(parseDailyColor(''), null, '空串应返回 null');

// ---------- 2) 本地按日轮换 ----------
const d1 = '2026-10-19';
const d2 = '2026-10-20';
const a1 = localDailyColor(d1);
const a1b = localDailyColor(d1);
const a2 = localDailyColor(d2);
assert.strictEqual(a1.hex, a1b.hex, '同一天的颜色必须恒定');
assert.notStrictEqual(a1.hex, a2.hex, '相邻两天应换色');
assert(/^#[0-9A-F]{6}$/.test(a1.hex), '本地色值格式应合法: ' + a1.hex);
assert(a1.name.length > 0, '本地色应有名称');

// 连续 10 天应出现多个不同颜色(轮换真的在动)
const week = new Set();
for (let i = 1; i <= 10; i += 1) {
  week.add(localDailyColor('2026-11-' + String(i).padStart(2, '0')).hex);
}
assert(week.size >= 8, `10 天应至少 8 种颜色(实际 ${week.size})`);

// 日期键按北京时间
assert(/^\d{4}-\d{2}-\d{2}$/.test(beijingDateKey()), '日期键格式应为 yyyy-mm-dd');

// ---------- 3) 由任意颜色推导的色板必须可读 ----------
const samples = [
  { name: '法翠', hex: '#108B96' },
  { name: '故宫红', hex: '#9D2933' },
  { name: '琉璃黄', hex: '#F3C13C' },
  { name: '极暗', hex: '#0A0A0A' },
  { name: '极亮', hex: '#FAFAF7' },
  { name: '中性灰', hex: '#808080' },
];
for (const s of samples) {
  const t = colorTheme(s.name, s.hex);
  assert.strictEqual(t.id, 'daily', '色板 id 应为 daily');
  assert.strictEqual(t.name, s.name, '色板名应等于传入名');
  const body = contrastRatio(t.fg, t.bg);
  const accent = contrastRatio(t.accent, t.bg);
  assert(body >= 7, `${s.name} 正文对比度 ${body.toFixed(2)} 应 >= 7`);
  assert(accent >= 4.5, `${s.name} 强调色对比度 ${accent.toFixed(2)} 应 >= 4.5`);
  assert(contrastRatio(t.accentFg, t.accent) >= 3, `${s.name} 主色上的字应可读`);
}
// 非法色值不应崩, 回退中性灰
assert.strictEqual(colorTheme('坏值', 'not-a-color').id, 'daily', '非法色值应安全回退');

// themeById 应使用传入的今日色
assert.strictEqual(themeById('daily', undefined, '法翠', '#108B96').name, '法翠', 'themeById(daily) 应用今日色');

// ---------- 4) 设置落盘(白名单回归) ----------
(async function () {
  const mem = {};
  const store = new SettingsStore({
    get: (k, d) => (k in mem ? mem[k] : d),
    update: async (k, v) => { mem[k] = v; },
  });
  const next = await store.update({
    theme: 'daily',
    dailyName: '法翠',
    dailyHex: '#108B96',
    dailyDate: '2026-10-19',
    dailySource: 'remote',
  });
  assert.strictEqual(next.theme, 'daily', 'daily 主题必须能保存(白名单)');
  assert.strictEqual(next.dailyName, '法翠', '色名应保存');
  assert.strictEqual(next.dailyHex, '#108B96', '色值应保存');
  assert.strictEqual(next.dailyDate, '2026-10-19', '日期应保存');
  assert.strictEqual(next.dailySource, 'remote', '来源应保存');

  // 非法来源/色值应被忽略
  const bad = await store.update({ dailySource: 'whatever', dailyHex: 'red' });
  assert.strictEqual(bad.dailySource, 'remote', '非法来源应被忽略');
  assert.strictEqual(bad.dailyHex, '#108B96', '非法色值应被忽略');

  console.log(`每日一色测试全部通过 ✔ (今日本地色 ${a1.name} ${a1.hex}, 10 天 ${week.size} 色)`);
})();
