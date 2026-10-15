/**
 * webview/reader/composables/vscode.js — VS Code webview 消息桥
 * 扩展 <-> webview 的 postMessage 协议封装(与旧内嵌脚本保持同一协议)
 */
import { reactive } from 'vue';

export const vscode = acquireVsCodeApi();

/** 全局共享状态(与扩展侧消息协议字段一一对应) */
export const state = reactive({
  novel: null,
  settings: null,
  chapterIndex: 0,
  chapterWords: 0,
  chapters: [],
  catReverse: false,
  catCollapsed: [],
  prevCombo: null,
  nextCombo: null,
});

/** 发消息给扩展 */
export function post(type, payload) {
  vscode.postMessage(Object.assign({ type }, payload || {}));
}
