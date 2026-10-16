/**
 * webview/dev/harness.ts — 浏览器调试环境(把 VS Code webview 平台能力桩掉)
 *
 * 仅 dev 入口引用(webview 下的 dev.ts), 生产构建走 lib 入口, 不会进产物。
 *
 * 桩掉的东西:
 *  1. acquireVsCodeApi   -> 内存实现, postMessage 打到控制台(可用 window.postedMessages 查看)
 *  2. ready 消息         -> 自动回推 bootMessages(mock 的 init/chapter/shelf 等)
 *  3. --vscode-* 变量    -> 提供一套兜底值(浏览器里没有 VS Code 注入)
 */

import { DEFAULT_SETTINGS } from 'virtual:novel-constants';

export interface DevHarnessOptions {
  /** webview 发出 ready 后按序回推的消息(模拟扩展的响应) */
  bootMessages: unknown[];
  /** 回推延迟(默认 30ms) */
  bootDelay?: number;
}

/** 控制台可访问: window.postedMessages 查看 webview 发出的消息; window.sendToWebview(msg) 手动推送 */
declare global {
  interface Window {
    postedMessages: unknown[];
    sendToWebview: (msg: unknown) => void;
  }
}

export function installDevHarness(opts: DevHarnessOptions): void {
  const posted: unknown[] = [];
  window.postedMessages = posted;

  const dispatch = (msg: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  };
  window.sendToWebview = dispatch;

  (window as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = function () {
    // 真实 webview: 全局只能调用一次, 调用后即被删除
    delete (window as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi;
    return {
      postMessage(m: unknown) {
        posted.push(m);
        console.log('[dev] webview → extension:', m);
        if (m && (m as { type?: string }).type === 'ready') {
          setTimeout(() => {
            for (const msg of opts.bootMessages) { dispatch(msg); }
          }, opts.bootDelay == null ? 30 : opts.bootDelay);
        }
      },
      getState: () => undefined,
      setState: () => {},
    };
  };

  applyVscodeFallbackVars();
}

/** 模拟 VS Code 浅色主题注入的 --vscode-* 变量(仅作样式兜底, 会被运行时的主题映射覆盖) */
function applyVscodeFallbackVars(): void {
  const vars: Record<string, string> = {
    '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    '--vscode-font-size': '13px',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-sideBar-background': '#f3f3f3',
    '--vscode-editor-background': '#ffffff',
    '--vscode-widget-border': 'rgba(128,128,128,.35)',
    '--vscode-input-background': '#ffffff',
    '--vscode-list-hoverBackground': 'rgba(0,0,0,.06)',
    '--vscode-list-inactiveSelectionBackground': 'rgba(0,0,0,.08)',
    '--vscode-button-background': '#0e639c',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb',
    '--vscode-button-secondaryBackground': 'rgba(127,127,127,.16)',
    '--vscode-button-secondaryForeground': '#3b3b3b',
    '--vscode-button-secondaryHoverBackground': 'rgba(127,127,127,.26)',
    '--vscode-toolbar-hoverBackground': 'rgba(127,127,127,.2)',
    '--vscode-charts-green': '#2ea043',
    '--vscode-focusBorder': '#0060c0',
    '--vscode-errorForeground': '#f14c4c',
    '--vscode-textLink-foreground': '#3794ff',
  };
  const root = document.documentElement;
  for (const k of Object.keys(vars)) {
    root.style.setProperty(k, vars[k]);
  }
}

// ---------------------------------------------------------------- mock 数据

export function mockChapters(count: number): { index: number; title: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    title: '第' + (i + 1) + '章 ' + (i % 3 === 0 ? '风云再起' : '示例章节标题' + (i + 1)),
  }));
}

export function mockParagraphs(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    '这是第 ' + (i + 1) + ' 段调试文本。样式调试时重点看：中文排版的行距、段距、首行缩进、' +
    '字体回退与换行断点是否符合预期。English words mixed 1234567890，以及标点符号「引号」、' +
    '（括号）、【特殊符号】的对齐表现。'
  );
}

/** 阅读面板 init 载荷 */
export function mockReaderInit(): { type: string; payload: Record<string, unknown> } {
  const chapters = mockChapters(30);
  return {
    type: 'init',
    payload: {
      filePath: 'D:/mock/debug.txt',
      bookTitle: '调试示例小说',
      author: '示例作者',
      chapters,
      chapterIndex: 2,
      chapterTitle: chapters[2].title,
      paragraphs: mockParagraphs(12),
      totalChapters: chapters.length,
      totalWords: 1500000,
      scrollRatio: 0,
      chapterWords: 3200,
      settings: DEFAULT_SETTINGS,
      shelf: [
        { filePath: 'D:/mock/debug.txt', title: '调试示例小说', author: '示例作者', chapterIndex: 2, totalChapters: 30, current: true },
        { filePath: 'D:/mock/other.txt', title: '另一本示例书', author: '', chapterIndex: -1, totalChapters: 12, current: false },
      ],
      libraryPath: 'D:/示例书库',
    },
  };
}

