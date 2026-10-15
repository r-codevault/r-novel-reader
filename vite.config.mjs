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

export default defineConfig(function ({ mode }) {
  const isSidebar = mode === 'sidebar';
  const name = isSidebar ? 'sidebar' : 'reader';
  return {
    plugins: [vue()],
    define: {
      __THEMES__: JSON.stringify(settings.THEMES),
      __FONT_STACKS__: JSON.stringify(fontStacks),
      __DEFAULT_SETTINGS__: JSON.stringify(settings.DEFAULT_SETTINGS),
      // webview 无 Node 环境, 固定 production(Vue 生产构建, 无 process 依赖)
      'process.env.NODE_ENV': JSON.stringify('production'),
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
