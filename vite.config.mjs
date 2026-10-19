/**
 * vite.config.mjs — 打包 webview (Vue 3 -> IIFE 单文件)
 *  - 默认构建阅读面板: dist-webview/reader.js + reader.css
 *  - `--mode sidebar` 构建侧边栏: dist-webview/sidebar.js + sidebar.css
 *  产物由 readerPanel.ts / chapterViewProvider.ts 内联进 webview HTML
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/settings.js 顶层 require('vscode'), 构建时给个空桩
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: () => undefined, has: () => false }) } };
  }
  return origLoad.call(this, request, parent, isMain);
};
const require2 = createRequire(import.meta.url);
const settings = require2(path.join(__dirname, 'dist', 'settings.js'));
const fontStacks = Object.fromEntries(settings.FONTS.map((f) => [f.id, f.stack]));

// 地域色彩: 34 个省份的完整色板在构建期算好(webview 端零计算), 只传 code/name/slogan/色卡
const provinceColors = require2(path.join(__dirname, 'dist', 'provinceColors.js'));
const PROVINCES = provinceColors.PROVINCES.map((p) => ({
  code: p.code,
  name: p.name,
  slogan: p.slogan,
  colors: p.colors.map((c) => ({ name: c.name, hex: c.hex })),
}));
const PROVINCE_THEMES = Object.fromEntries(
  provinceColors.PROVINCES.map((p) => [p.code, settings.provinceTheme(p.code)])
);

/**
 * 虚拟模块 'virtual:novel-constants' — 把 settings.ts 的常量注入 webview。
 * 用虚拟模块而非 vite define: define 在 dev(esbuild 路径) 下不可靠, 虚拟模块 dev/build 行为一致。
 */
const virtualConstants = {
  name: 'novel-constants',
  resolveId(id) {
    if (id === 'virtual:novel-constants') { return '\0virtual:novel-constants'; }
    return null;
  },
  load(id) {
    if (id !== '\0virtual:novel-constants') { return null; }
    return [
      'export const THEMES = ' + JSON.stringify(settings.THEMES) + ';',
      'export const FONT_STACKS = ' + JSON.stringify(fontStacks) + ';',
      'export const DEFAULT_SETTINGS = ' + JSON.stringify(settings.DEFAULT_SETTINGS) + ';',
      'export const PROVINCES = ' + JSON.stringify(PROVINCES) + ';',
      'export const PROVINCE_THEMES = ' + JSON.stringify(PROVINCE_THEMES) + ';',
    ].join('\n');
  },
};

export default defineConfig(function ({ command }) {
  const isServe = command === 'serve';
  const name = 'reader';
  return {
    plugins: [vue(), virtualConstants],
    server: {
      port: 5199,
      strictPort: false,
    },
    define: {
      // 构建产物在 webview(无 Node 环境)里运行, 固定 production;
      // dev server 下保留 development(否则 Vue 会以生产模式运行, 无 HMR 友好提示)
      ...(isServe ? {} : { 'process.env.NODE_ENV': JSON.stringify('production') }),
    },
    build: {
      outDir: 'dist-webview',
      emptyOutDir: true,
      target: 'es2020',
      lib: {
        entry: path.join(__dirname, 'webview', 'reader', 'main.ts'),
        name: 'NovelReaderPanel',
        formats: ['iife'],
        fileName: () => name + '.js',
      },
      rollupOptions: {
        output: {
          assetFileNames: function (info) {
            return info.names && info.names[0] && info.names[0].endsWith('.css')
              ? name + '.css'
              : '[name][extname]';
          },
        },
      },
    },
  };
});
