/**
 * smoke-webview.js — 两个界面视图的冒烟测试
 *  1. 阅读面板(readerPanel): 用桩模拟 vscode API, 校验生成的 HTML 与内嵌脚本
 *  2. 侧边栏视图(chapterViewProvider): 校验 书架 / 目录 两种模式、当前阅读条、消息协议
 *
 * 用法: node scripts/smoke-webview.js
 */

'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

// ---------------------------------------------------------------- vscode 桩
let capturedHtml = '';
const executed = [];
let panelTitle = '';
let panelMsgHandler = null;
let panelMessages = [];

const vscodeStub = {
  ViewColumn: { One: 1 },
  window: {
    ViewColumn: { One: 1 },
    createWebviewPanel: (viewType, title) => {
      panelTitle = title;
      return {
        get title() {
          return panelTitle;
        },
        set title(v) {
          panelTitle = v;
        },
        webview: {
          options: {},
          onDidReceiveMessage: (h) => {
            panelMsgHandler = h;
          },
          postMessage: (m) => {
            panelMessages.push(m);
            return Promise.resolve(true);
          },
          set html(v) {
            capturedHtml = v;
          },
        },
        onDidDispose: () => {},
        reveal: () => {},
        dispose: () => {},
      };
    },
    showOpenDialog: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: () => {},
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => {},
    createTreeView: () => ({ reveal: () => {} }),
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      executed.push({ cmd, args });
    },
    registerCommand: () => ({ dispose() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  TreeItem: class {
    constructor(l) {
      this.label = l;
    }
  },
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class {},
  MarkdownString: class {},
  EventEmitter: class {
    constructor() {
      this.event = () => {};
    }
    fire() {}
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return origLoad.apply(this, arguments);
};

/** 提取并校验内嵌脚本语法 */
function checkInlineScript(html, label) {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error(`${label}: 未找到内嵌脚本`);
  }
  const tmp = path.join(__dirname, `.check-${Date.now()}.js`);
  fs.writeFileSync(tmp, m[1]);
  try {
    execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ================================================================ 1. 阅读面板
const { ReaderPanel } = require('../dist/readerPanel');

const defaults = {
  fontSize: 16,
  fontFamily: 'system',
  lineHeight: 1.8,
  paragraphSpacing: 0.8,
  theme: 'sepia',
  contentWidth: 720,
};
const store = {
  get: () => ({ ...defaults }),
  update: async (p) => ({ ...defaults, ...p }),
  reset: async () => ({ ...defaults }),
};
const novel = {
  filePath: 'D:/a.txt',
  bookTitle: '测试之书',
  author: '测试作者',
  totalWords: 123456,
  chapters: Array.from({ length: 5 }, (_, i) => ({
    index: i,
    title: `第${i + 1}章 标题${i + 1}`,
    content: '第一段。\n第二段。',
    wordCount: 6,
  })),
};

ReaderPanel.createOrShow(novel, 2, 0.5, store);

console.log('[阅读面板]');
console.log('HTML 长度:', capturedHtml.length);
assert(capturedHtml.includes('Content-Security-Policy'), '应包含 CSP');
assert(!capturedHtml.includes('undefined') && !capturedHtml.includes('NaN'), '模板中不应有 undefined/NaN');
checkInlineScript(capturedHtml, '阅读面板');
console.log('内嵌脚本语法: 通过');

const panelIds = [
  'chapterSelect', 'settingsPanel', 'themeSwatches', 'fontSize', 'fontFamily',
  'lineHeight', 'paraSpacing', 'contentWidth', 'progressFill', 'prevBtn',
  'nextBtn', 'settingsBtn', 'resetSettings', 'bookInfo', 'content',
];
for (const id of panelIds) {
  assert(capturedHtml.includes(`id="${id}"`), `阅读面板缺少元素 #${id}`);
}
console.log('关键 UI 元素: 通过 (' + panelIds.length + ' 个)');

// --- 就绪后下发 init(含章内滚动位置) ---
panelMessages = [];
panelMsgHandler({ type: 'ready' });
const init1 = panelMessages.find((m) => m.type === 'init');
assert(init1, 'webview 就绪后应下发 init');
assert(init1.payload.bookTitle === '测试之书', 'init 应带上书名');
assert(Math.abs(init1.payload.scrollRatio - 0.5) < 1e-6, 'init 应带上章内滚动位置(延续阅读状态)');
console.log('就绪后 init(含滚动位置): 通过');

// --- 回归: 换书后阅读面板必须重建, 不能继续显示旧书 ---
const bookB = {
  filePath: 'D:/b.txt',
  bookTitle: '第二本书',
  author: '作者B',
  totalWords: 2000,
  chapters: [
    { index: 0, title: '第1章 开端', content: '内容一', wordCount: 3 },
    { index: 1, title: '第2章 发展', content: '内容二', wordCount: 3 },
    { index: 2, title: '第3章 结局', content: '内容三', wordCount: 3 },
  ],
};
panelMessages = [];
ReaderPanel.createOrShow(bookB, 1, 0.2, store);
const init2 = panelMessages.find((m) => m.type === 'init');
assert(init2, '换书后应重新下发 init');
assert(init2.payload.bookTitle === '第二本书', '换书后 init 应是新书');
assert(init2.payload.chapters.length === 3, '换书后应带新书章节列表');
assert(init2.payload.chapterIndex === 1, '换书后应定位到该书进度章节');
assert(panelTitle === '第二本书 - 小说阅读', '编辑器标签标题应更新为新书');
console.log('换书重建阅读面板(回归): 通过');

// ================================================================ 2. 侧边栏视图
const { ChapterViewProvider } = require('../dist/chapterViewProvider');

let chapterHtml = '';
let msgHandler = null;
const received = [];
const viewStub = {
  visible: true,
  webview: {
    options: {},
    set html(v) {
      chapterHtml = v;
    },
    postMessage: (m) => {
      received.push(m);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (h) => {
      msgHandler = h;
    },
  },
  onDidChangeVisibility: () => {},
};

const provider = new ChapterViewProvider();
provider.resolveWebviewView(viewStub);
assert(typeof msgHandler === 'function', '视图应注册消息处理函数');

console.log('\n[侧边栏视图]');
console.log('HTML 长度:', chapterHtml.length);
checkInlineScript(chapterHtml, '侧边栏视图');
console.log('内嵌脚本语法: 通过');

// --- 目录模式: 当前阅读条(悬浮 + 分割线 + 居中定位) ---
assert(chapterHtml.includes('position: sticky'), '「当前阅读」条必须 sticky 悬浮');
assert(chapterHtml.includes('border-bottom: 1px solid'), '悬浮条下方必须有分割线');
assert(chapterHtml.includes("scrollIntoView({ block: 'center'"), '回到当前章节需把章节滚动到列表中间');
assert(chapterHtml.includes('当前阅读'), '应显示「当前阅读」');
assert(!chapterHtml.includes('继续阅读'), '不应再出现「继续阅读」文案');
assert(chapterHtml.includes('--vscode-charts-green'), '在读图标需使用 accent 色');
assert(chapterHtml.includes('<circle cx="8" cy="8" r="6.1"/>'), '缺少在读播放圆标');
assert(chapterHtml.includes('M7.45 3.35C6.35'), '缺少普通章节书本图标');
console.log('当前阅读条 / 图标: 通过');

// --- 书架模式 ---
const sideIds = [
  'paneShelf', 'shelfList', 'shelfEmpty', 'shelfFoot',
  'paneChapters', 'chapterList', 'currentCard', 'currentTitle',
];
for (const id of sideIds) {
  assert(chapterHtml.includes(`id="${id}"`), `侧边栏缺少元素 #${id}`);
}
assert(chapterHtml.includes('bk-del'), '书架条目应有移除按钮');
assert(chapterHtml.includes('书架空空如也'), '书架应有空状态');
console.log('书架 UI 元素: 通过');

// --- 消息协议 ---
received.length = 0;
provider.setMode('shelf');
assert(received.some((m) => m.type === 'mode' && m.mode === 'shelf'), 'setMode 应推送 mode 消息');

received.length = 0;
provider.setShelf([
  { filePath: 'D:/a.txt', title: '测试之书', author: '测试作者', chapterIndex: 275, totalChapters: 454, current: true },
  { filePath: 'D:/b.txt', title: '另一本', author: '', chapterIndex: -1, totalChapters: 100, current: false },
]);
const shelfMsg = received.find((m) => m.type === 'shelf');
assert(shelfMsg && shelfMsg.items.length === 2, 'setShelf 应推送书架列表');
assert(shelfMsg.items[0].chapterIndex === 275 && shelfMsg.items[0].current === true, '书架条目进度/当前标记不正确');

received.length = 0;
provider.setNovel(novel);
const novelMsg = received.find((m) => m.type === 'novel');
assert(novelMsg && novelMsg.payload.chapters.length === 5 && novelMsg.payload.hasNovel, 'setNovel 应推送书目信息');

received.length = 0;
provider.setCurrent(3, false);
provider.setCurrent(3, true);
const lastMsg = received[received.length - 1];
assert(lastMsg.type === 'current' && lastMsg.index === 3 && lastMsg.center === true, '居中请求消息不正确');
console.log('消息协议(模式/书架/书目/当前章节): 通过');

// --- 视图 -> 扩展 的消息分发 ---
executed.length = 0;
msgHandler({ type: 'openBook', filePath: 'D:/b.txt' });
msgHandler({ type: 'removeBook', filePath: 'D:/b.txt' });
msgHandler({ type: 'resumeCurrent' });
msgHandler({ type: 'openFile' });
msgHandler({ type: 'openChapter', index: 12 });
msgHandler({ type: 'showShelf' });
msgHandler({ type: 'showChapters' });
const expected = [
  'novelReader.openBook',
  'novelReader.removeFromShelf',
  'novelReader.resumeCurrent',
  'novelReader.openFile',
  'novelReader.openChapter',
  'novelReader.showBookshelf',
  'novelReader.showChapters',
];
for (const cmd of expected) {
  assert(executed.some((e) => e.cmd === cmd), `消息未分发到命令 ${cmd}`);
}
const openBookCall = executed.find((e) => e.cmd === 'novelReader.openBook');
assert(openBookCall.args[0] === 'D:/b.txt', 'openBook 应带上文件路径');
console.log('视图 -> 扩展消息分发: 通过 (' + expected.length + ' 条命令)');

// --- 空状态 ---
received.length = 0;
provider.setNovel(null);
provider.setShelf([]);
assert(received.some((m) => m.type === 'novel' && m.payload.hasNovel === false), '空书状态 hasNovel 应为 false');
assert(received.some((m) => m.type === 'shelf' && m.items.length === 0), '空书架应推送空列表');
console.log('空状态: 通过');

console.log('\n冒烟测试全部通过 ✔');
