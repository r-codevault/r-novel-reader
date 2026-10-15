/**
 * webview/reader/env.d.ts — webview 全局环境类型声明
 */

/** 构建期由 vite define 注入(见 vite.config.mjs), 单一来源为 src/settings.ts */
declare const __THEMES__: import('../../src/settings').ThemeDef[];
declare const __FONT_STACKS__: Record<string, string>;
declare const __DEFAULT_SETTINGS__: import('../../src/settings').ReadingSettings;

/** VS Code webview 注入的 API */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
