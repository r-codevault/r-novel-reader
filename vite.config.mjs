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
    ].join('\n');
  },
};

export default defineConfig(function ({ mode, command }) {
  const isSidebar = mode === 'sidebar';
  const isServe = command === 'serve';
  const name = isSidebar ? 'sidebar' : 'reader';
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
      emptyOutDir: !isSidebar, // 第二次构建保留 reader 产物
      target: 'es2020',
      lib: {
        entry: path.join(__dirname, 'webview', name, 'main.ts'),
        name: 'NovelReader' + (isSidebar ? 'Sidebar' : 'Panel'),
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
