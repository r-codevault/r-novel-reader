/**
 * uiFont.ts — 界面(功能面板)字号: 主值 + 派生量(纯函数, 扩展与 webview 共用)
 *
 * 为什么不放进 settings.ts: 那里顶层 `import * as vscode`, webview 只能 `import type`
 * 引它; 而 webview 运行时需要拿到范围(设置面板文案)与派生(applyThemeVars 写变量)。
 * 与 noteAnchor.ts 同一套解法 —— 纯逻辑落在 vscode-free 模块, 两端直接 import。
 *
 * 与正文字号(settings.fontSize / --font-size) **完全独立**: 两套变量互不推导,
 * 这是 R4-01 的边界 —— 改正文不会撑破面板, 改面板不会带动正文。
 */

/** 界面字号: 主值范围 + 派生规则(与正文 fontSize 的 12–32 无关) */
export const UI_FONT = {
  min: 12,
  max: 20,
  /** 步进(px): 设置面板点一次 ±1 */
  step: 1,
  default: 14,
  /** 派生: 副字号 = max(subFloor, 主值 - subDelta) */
  subDelta: 2,
  subFloor: 11,
  /** 派生: 标题级 = 主值 + titleDelta */
  titleDelta: 1,
} as const;

export interface UiFontVars {
  /** 夹取取整后的主值(px 数值) */
  size: number;
  main: string;
  sub: string;
  title: string;
}

/**
 * 夹取到 [min, max] 并取整。
 * 非数字 / NaN / Infinity 一律回落默认值(14) —— 调用方可能是老数据或脏数据。
 */
export function clampUiFont(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : UI_FONT.default;
  return Math.min(UI_FONT.max, Math.max(UI_FONT.min, n));
}

/**
 * 写入 CSS 的三个变量值(单位已带)。
 * 派生量在 JS 里算而不是 CSS `max()/calc()`: 一处逻辑两端共用, 且可直接单测;
 * 若写成 CSS 表达式, happy-dom 不解析变量算式, 等于放弃可测性。
 */
export function uiFontVars(v: unknown): UiFontVars {
  const size = clampUiFont(v);
  return {
    size,
    main: size + "px",
    // 下限兜底: 12 档时 12-2=10 太小, 卡在 11px
    sub: Math.max(UI_FONT.subFloor, size - UI_FONT.subDelta) + "px",
    title: size + UI_FONT.titleDelta + "px",
  };
}
