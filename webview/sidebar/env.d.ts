/**
 * webview/sidebar/env.d.ts — webview 全局环境类型声明
 */

/** 构建期由 vite 虚拟模块注入(见 vite.config.mjs), 单一来源为 src/settings.ts */
declare module 'virtual:novel-constants' {
  export const THEMES: import('../../src/settings').ThemeDef[];
  export const FONT_STACKS: Record<string, string>;
  export const DEFAULT_SETTINGS: import('../../src/settings').ReadingSettings;
}

/** VS Code webview 注入的 API(全局只能调用一次) */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
