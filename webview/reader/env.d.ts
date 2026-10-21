/**
 * webview/reader/env.d.ts — webview 全局环境类型声明
 */

/** 构建期由 vite 虚拟模块注入(见 vite.config.mjs), 单一来源为 src/settings.ts */
declare module 'virtual:novel-constants' {
  export const THEMES: import('../../src/settings').ThemeDef[];
  export const FONT_STACKS: Record<string, string>;
  export const DEFAULT_SETTINGS: import('../../src/settings').ReadingSettings;
  /** 正文栏宽: 合法区间 + 预设档位(px) */
  export const CONTENT_WIDTH: typeof import('../../src/settings').CONTENT_WIDTH;
  /** 34 个省级区域(下拉选项 + 色卡预览) */
  export const PROVINCES: { code: string; name: string; slogan: string; colors: { name: string; hex: string }[] }[];
  /** 省份代码 -> 已推导好的阅读色板(构建期算好, 端上零计算) */
  export const PROVINCE_THEMES: Record<string, import('../../src/settings').ThemeDef>;
  /** 廿四节气列表(下拉选项) */
  export const SOLAR_TERMS: { id: string; name: string; color: string; hex: string; season: string }[];
  /** 节气 id -> 已推导好的阅读色板 */
  export const TERM_THEMES: Record<string, import('../../src/settings').ThemeDef>;
}

/** vite ?raw 引入的资源原文(如摸鱼猫图标 svg) */
declare module '*.svg?raw' {
  const content: string;
  export default content;
}

/** VS Code webview 注入的 API */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
