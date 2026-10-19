/**
 * gen-province-colors.js — 从 media/地域色彩-cncolor.json 生成 src/provinceColors.ts
 *
 * 只保留主题推导需要的字段(code/name/slogan/colors[name,hex,categoryName]),
 * 去掉 rgb/description/source 等冗余字段, 把 72KB 压到 ~10KB。
 *
 * 用法: node scripts/gen-province-colors.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'media', '地域色彩-cncolor.json');
const OUT = path.join(__dirname, '..', 'src', 'provinceColors.ts');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (!raw || !Array.isArray(raw.regions) || raw.regions.length === 0) {
  throw new Error('数据格式不符: 缺少 regions');
}

const regions = raw.regions.map((r) => ({
  code: String(r.code),
  name: String(r.name),
  slogan: String(r.slogan || ''),
  colors: (r.colors || []).map((c) => ({
    name: String(c.name),
    hex: String(c.hex).toUpperCase(),
    category: String(c.categoryName || ''),
  })),
})).sort((a, b) => a.code.localeCompare(b.code));

const body = regions.map((r) => {
  const colors = r.colors
    .map((c) => `      { name: ${JSON.stringify(c.name)}, hex: "${c.hex}", category: ${JSON.stringify(c.category)} },`)
    .join('\n');
  return `  {
    code: "${r.code}",
    name: ${JSON.stringify(r.name)},
    slogan: ${JSON.stringify(r.slogan)},
    colors: [
${colors}
    ],
  },`;
}).join('\n');

const ts = `/**
 * provinceColors.ts — 地域色彩数据(自动生成, 请勿手改)
 *
 * 来源: media/地域色彩-cncolor.json(34 个省级区域, 190 个颜色)
 * 生成: node scripts/gen-province-colors.js
 *
 * 用途: 阅读主题「地域色彩」按省份取色推导色板(见 settings.ts provinceTheme)
 */
export interface ProvinceColor {
  name: string;
  hex: string;
  category: string;
}

export interface ProvinceDef {
  code: string;
  name: string;
  slogan: string;
  colors: ProvinceColor[];
}

export const PROVINCES: ProvinceDef[] = [
${body}
];

/** 默认地域(北京): 未选择时的兜底 */
export const DEFAULT_PROVINCE_CODE = "110000";
`;

fs.writeFileSync(OUT, ts, 'utf8');
const total = regions.reduce((n, r) => n + r.colors.length, 0);
console.log(`已生成 ${path.relative(path.join(__dirname, '..'), OUT)}`);
console.log(`区域 ${regions.length} 个, 颜色 ${total} 个, 文件 ${(ts.length / 1024).toFixed(1)} KB`);
