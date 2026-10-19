/**
 * webview/reader/env.d.ts — webview 全局环境类型声明
 */

/** 构建期由 vite 虚拟模块注入(见 vite.config.mjs), 单一来源为 src/settings.ts */
declare module 'virtual:novel-constants' {
  export const THEMES: import('../../src/settings').ThemeDef[];
  export const FONT_STACKS: Record<string, string>;
  export const DEFAULT_SETTINGS: import('../../src/settings').ReadingSettings;
  /** 34 个省级区域(下拉选项 + 色卡预览) */
  export const PROVINCES: { code: string; name: string; slogan: string; colors: { name: string; hex: string }[] }[];
  /** 省份代码 -> 已推导好的阅读色板(构建期算好, 端上零计算) */
  export const PROVINCE_THEMES: Record<string, import('../../src/settings').ThemeDef>;
}

/** VS Code webview 注入的 API */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
