/**
 * webview/sidebar/env.d.ts — webview 全局环境类型声明
 */

/** VS Code webview 注入的 API(全局只能调用一次) */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
