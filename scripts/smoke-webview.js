/* 冒烟测试: 用桩模拟 vscode API, 验证 ReaderPanel 生成的 Webview HTML 与内嵌脚本 */
'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

let capturedHtml = '';
const vscodeStub = {
  ViewColumn: { One: 1 },
  window: {
    ViewColumn: { One: 1 },
    createWebviewPanel: () => ({
      webview: {
        onDidReceiveMessage: () => {},
        set html(v) {
          capturedHtml = v;
        },
      },
      onDidDispose: () => {},
      reveal: () => {},
      dispose: () => {},
    }),
    showOpenDialog: async () => undefined,
    showWarningMessage: () => {},
    showErrorMessage: () => {},
    showInformationMessage: () => {},
    setStatusBarMessage: () => {},
    createTreeView: () => ({ reveal: () => {} }),
  },
  commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose() {} }) },
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
const state = { get: () => undefined, update: async () => {} };
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

ReaderPanel.createOrShow(novel, 2, 0.5, store, state);

console.log('HTML 长度:', capturedHtml.length);
console.log('包含 CSP:', capturedHtml.includes('Content-Security-Policy'));
console.log('无 undefined/NaN 泄漏:', !capturedHtml.includes('undefined') && !capturedHtml.includes('NaN'));

const m = capturedHtml.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
if (!m) {
  throw new Error('未找到内嵌脚本');
}
const tmp = path.join(__dirname, '.webview-check.js');
fs.writeFileSync(tmp, m[1]);
try {
  execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
  console.log('内嵌脚本语法检查: 通过');
} finally {
  fs.unlinkSync(tmp);
}

const ids = [
  'chapterSelect', 'settingsPanel', 'themeSwatches', 'fontSize', 'fontFamily',
  'lineHeight', 'paraSpacing', 'contentWidth', 'progressFill', 'prevBtn',
  'nextBtn', 'settingsBtn', 'resetSettings', 'bookInfo', 'content',
];
for (const id of ids) {
  if (!capturedHtml.includes(`id="${id}"`)) {
    throw new Error(`缺少元素 #${id}`);
  }
}
console.log('关键 UI 元素检查: 通过 (' + ids.length + ' 个)');

// ---------------------------------------------------------------- 侧边栏目录视图(WebviewView)
const { ChapterViewProvider } = require('../dist/chapterViewProvider');

let chapterHtml = '';
let received = [];
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
    onDidReceiveMessage: () => {},
  },
  onDidChangeVisibility: () => {},
};

const provider = new ChapterViewProvider();
provider.resolveWebviewView(viewStub);

console.log('\n[侧边栏目录视图]');
console.log('HTML 长度:', chapterHtml.length);

// 内嵌脚本语法
const cm = chapterHtml.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
if (!cm) {
  throw new Error('侧边栏视图未找到内嵌脚本');
}
const tmp2 = path.join(__dirname, '.chapter-check.js');
fs.writeFileSync(tmp2, cm[1]);
try {
  execSync(`node --check "${tmp2}"`, { stdio: 'pipe' });
  console.log('内嵌脚本语法: 通过');
} finally {
  fs.unlinkSync(tmp2);
}

// 悬浮 + 分割线
assert(chapterHtml.includes('position: sticky'), '继续阅读条必须 sticky 悬浮');
assert(chapterHtml.includes('border-bottom: 1px solid'), '悬浮条下方必须有分割线');
assert(chapterHtml.includes('scrollIntoView({ block: \'center\'') || chapterHtml.includes("scrollIntoView({ block: 'center'"), '点击继续阅读需居中定位');

// 两种图标: 书本 + 在读播放标
assert(chapterHtml.includes('<circle cx="8" cy="8" r="6.1"/>'), '缺少"在读"播放圆标');
assert(chapterHtml.includes('M7.45 3.35C6.35'), '缺少普通章节书本图标');
assert(chapterHtml.includes('--vscode-charts-green'), '在读图标需使用 accent 色');

// 状态推送 -> 居中请求
const chapterNovel = {
  filePath: 'D:/a.txt',
  bookTitle: '测试之书',
  author: '测试作者',
  totalWords: 1000,
  chapters: Array.from({ length: 300 }, (_, i) => ({ index: i, title: `第${i + 1}章 标题`, content: 'x', wordCount: 1 })),
};
provider.setNovel(chapterNovel, { index: 275, title: '第276章 测试' });
provider.setCurrent(276, false);
provider.setCurrent(276, true);
const last = received[received.length - 1];
assert(last.type === 'current' && last.index === 276 && last.center === true, '居中请求消息不正确');
const stateMsg = received.find((m) => m.type === 'state');
assert(stateMsg && stateMsg.payload.chapters.length === 300, '状态消息章节数不正确');
assert(stateMsg.payload.continueTarget.index === 275, '继续阅读目标不正确');
console.log('状态/居中消息: 通过 (共 ' + received.length + ' 条)');

// 空状态
provider.setNovel(null, null);
const emptyState = received[received.length - 1];
assert(emptyState.payload.hasNovel === false, '空状态 hasNovel 应为 false');
console.log('空状态: 通过');

console.log('\n冒烟测试全部通过 ✔');
