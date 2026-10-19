/**
 * test-custom-theme.js — 自定义图片主题单测
 *
 * 覆盖: 主题色板选择(深图用黑夜色板/浅图用羊皮纸) + 默认参数 + 参数边界
 */
'use strict';
const assert = require('assert');

// dist/settings.js 顶部 import 了 vscode(读配置), 纯 Node 环境需打桩
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: (_key, dflt) => dflt }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { themeById, DEFAULT_SETTINGS } = require('../dist/settings');

// 1) 自定义主题: 浅色图 -> 羊皮纸色板(深字), 深色图 -> 黑夜色板(浅字)
const light = themeById('custom', false);
const dark = themeById('custom', true);
const sepia = themeById('sepia');
const darkTheme = themeById('dark');

assert.strictEqual(light.id, 'custom', '主题 id 应为 custom');
assert.strictEqual(light.bg, sepia.bg, '浅色图应复用羊皮纸纸色');
assert.strictEqual(light.fg, sepia.fg, '浅色图应复用羊皮纸字色(深字)');
assert.strictEqual(dark.bg, darkTheme.bg, '深色图应复用黑夜纸色');
assert.strictEqual(dark.fg, darkTheme.fg, '深色图应复用黑夜字色(浅字)');
assert.notStrictEqual(light.fg, dark.fg, '深浅两种情况的字色必须不同(这是可读性的关键)');
assert.strictEqual(light.name, '自定义', '自定义主题应显示为「自定义」');

// 2) 默认参数: 遮罩 70% / 模糊 4px(保守值, 优先可读性)
assert.strictEqual(DEFAULT_SETTINGS.customBgMask, 70, '默认遮罩浓度应为 70');
assert.strictEqual(DEFAULT_SETTINGS.customBgBlur, 4, '默认模糊应为 4px');

// 3) 未知主题仍回退到预设(不影响老数据)
assert.strictEqual(themeById('nope').id, 'white', '未知主题应回退到第一个预设');

console.log('自定义主题测试全部通过 ✔');
