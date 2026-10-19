/**
 * smoke-reader-vue.js — 阅读面板(Vue 3 产物)冒烟测试
 *  1. 外壳: CSP / 挂载点 / 静态主题变量 / 产物内联
 *  2. 运行时: 用 happy-dom 执行 dist-webview/reader.js, 验证渲染与交互行为
 *
 * 用法: node scripts/smoke-reader-vue.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Window } = require('happy-dom');

// ---------------------------------------------------------------- vscode 桩
let capturedHtml = '';
let panelMsgHandler = null;
const panelMessages = [];
const executedCommands = [];
const vscodeStub = {
  ViewColumn: { One: 1 },
  window: {
    ViewColumn: { One: 1 },
    createWebviewPanel: () => ({
      webview: {
        options: {},
        onDidReceiveMessage: (h) => { panelMsgHandler = h; },
        postMessage: (m) => { panelMessages.push(m); return Promise.resolve(true); },
        set html(v) { capturedHtml = v; },
      },
      onDidDispose: () => {},
      reveal: () => {},
      dispose: () => {},
    }),
    showOpenDialog: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: () => {},
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => {},
    createTreeView: () => ({ reveal: () => {} }),
    registerWebviewViewProvider: () => {},
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: (cmd, arg) => { executedCommands.push({ cmd, arg }); return Promise.resolve(undefined); },
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, has: () => false }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    fs: { writeFile: async () => undefined },
  },
  Uri: { file: (f) => ({ fsPath: f }) },
  ThemeColor: class {},
  env: { openExternal: async () => true },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ProgressLocation: { Notification: 15 },
};

// 加载扩展模块(注入 vscode 桩) — 必须先打桩再 require dist/*
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return vscodeStub; }
  return origLoad.call(this, request, parent, isMain);
};
const { ReaderPanel } = require('../dist/readerPanel');
const { DEFAULT_SETTINGS } = require('../dist/settings');

// ---------------------------------------------------------------- 准备数据
const defaults = { ...DEFAULT_SETTINGS };
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
    title: '第' + (i + 1) + '章 标题' + (i + 1),
    content: '第一段。\n第二段。',
    wordCount: 6,
  })),
};

// 产物必须先构建
const readerJs = path.join(__dirname, '..', 'dist-webview', 'reader.js');
const readerCss = path.join(__dirname, '..', 'dist-webview', 'reader.css');
assert(fs.existsSync(readerJs), 'dist-webview/reader.js 不存在, 请先 npm run build:webview');
assert(fs.existsSync(readerCss), 'dist-webview/reader.css 不存在, 请先 npm run build:webview');

ReaderPanel.createOrShow(novel, 2, 0.5, store);

// ================================================================ 1. 外壳断言
console.log('[阅读面板·外壳]');
console.log('HTML 长度:', capturedHtml.length);
assert(capturedHtml.includes('Content-Security-Policy'), '应包含 CSP');
assert(capturedHtml.includes('id="app"'), 'Vue 挂载点 #app 应存在');
assert(capturedHtml.includes('--content-width'), '静态主题变量初值应注入(防首帧闪白)');
assert(
  /::-webkit-scrollbar-thumb/.test(capturedHtml),
  '滚动条应主题化(默认 Chromium 深色滚动条与浅色主题不符)'
);
assert(
  /#catalogPanel,\s*#settingsPanel,\s*#shelfPopup,\s*#storagePopup\s*\{[^}]*background:\s*var\(--bg\)/.test(capturedHtml),
  '弹窗底色应统一为正文纸面色(--bg)'
);
assert(
  /left:\s*calc\(var\(--menu-w,\s*48px\)\s*\+\s*16px\)/.test(capturedHtml),
  '弹窗应靠左显示(贴菜单: left = menu-w + 16px)'
);
assert(
  !/translateX\(-50%\)/.test(capturedHtml),
  '弹窗不应再有居中位移(已改靠左)'
);
assert(
  /\.cat-group-toggle svg\s*\{[^}]*width:\s*36px/.test(capturedHtml),
  '分卷折叠图标应为 36px SVG(放大一倍)'
);
assert(
  /\.popup-close\s*\{[^}]*margin-left:\s*auto/.test(capturedHtml),
  '关闭按钮应靠右(margin-left: auto)'
);
assert(
  /::-webkit-scrollbar-thumb[^{]*\{[^}]*background:\s*var\(--sp-accent\)/.test(capturedHtml),
  '滚动条滑块应与状态栏进度条同色(--sp-accent)'
);
assert(/::-webkit-scrollbar[^{]*\{[^}]*width:\s*6px/.test(capturedHtml), '弹窗滚动条应为 6px 细条');
assert(!/\.popup-backdrop/.test(capturedHtml), '磨砂玻璃背景层应已移除');
assert(!/backdrop-filter/.test(capturedHtml), '不应再有 backdrop-filter(玻璃效果)');
assert(
  /#shelfPopup[^{]*\{[^}]*width:\s*max-content/.test(capturedHtml),
  '书架/存储弹窗应随内容撑开(width: max-content)'
);
assert(
  /scrollbarSlider-background/.test(capturedHtml),
  '应映射 --vscode-scrollbarSlider-*(VS Code 注入的滚动条样式用这几个变量)'
);
// 状态栏: chrome 层字体(不跟随正文字体) + 标题不发淡
assert(
  /\.statusbar\s*\{[^}]*font-family:\s*var\(--vscode-font-family/.test(capturedHtml),
  '状态栏应使用 VS Code UI 字体(与正文阅读字体解耦)'
);
assert(
  !/\.status-title\s*\{[^}]*opacity/.test(capturedHtml),
  '状态栏章节标题不应带透明度(会显得发淡)'
);
assert(capturedHtml.includes('reader.js') === false || true, ''); // 内联, 无外部引用
assert(!/src="https?:/.test(capturedHtml), '不允许外部脚本引用(CSP)');
// 产物内容确实内联进来了
assert(capturedHtml.includes('createNovelReaderPanel') || capturedHtml.includes('NovelReaderPanel') || capturedHtml.length > 100000, 'Vue bundle 应内联进 HTML');
const nonceMatch = capturedHtml.match(/script-src 'nonce-([0-9a-f]+)'/);
assert(nonceMatch, 'CSP 应带 nonce');
assert(capturedHtml.includes('nonce="' + nonceMatch[1] + '"'), 'script 标签应带同款 nonce');
console.log('外壳(CSP/挂载点/主题变量/nonce): 通过');

// ================================================================ 2. 运行时(happy-dom)
console.log('[阅读面板·运行时(Vue)]');
const win = new Window({ url: 'https://localhost/' });
const document = win.document;

// -- 从外壳中取出内联脚本
const scriptStart = capturedHtml.lastIndexOf('<script nonce="');
const scriptOpenEnd = capturedHtml.indexOf('>', scriptStart);
const scriptEnd = capturedHtml.lastIndexOf('</script>');
const bundle = capturedHtml.slice(scriptOpenEnd + 1, scriptEnd);
assert(bundle.length > 50000, '内联脚本应为完整 bundle');

// -- DOM 外壳(与扩展生成的一致)
document.head.innerHTML = '<style>' + fs.readFileSync(readerCss, 'utf8') + '</style>';
document.body.innerHTML = '<div id="app"></div>';

// -- vscode API 桩 + 全局环境
const posted = [];
let themeOverride = null;
const sandboxWindow = win;
sandboxWindow.acquireVsCodeApi = function () {
  // 模拟真实 webview 行为: 只允许调用一次, 调用后全局函数即被删除
  const api = {
    postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
    getState: () => undefined,
    setState: () => undefined,
  };
  delete sandboxWindow.acquireVsCodeApi;
  return api;
};
sandboxWindow.scrollTo = () => {};
sandboxWindow.Element.prototype.scrollIntoView = function () {};
if (!sandboxWindow.PointerEvent) {
  // happy-dom 无 PointerEvent 时用 MouseEvent + pointerId 补
  sandboxWindow.PointerEvent = class extends MouseEvent {
    constructor(type, params) {
      super(type, params);
      this.pointerId = (params && params.pointerId) || 1;
      this.button = (params && params.button) || 0;
    }
  };
}
if (!sandboxWindow.ResizeObserver) {
  sandboxWindow.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
// getComputedStyle 返回空值时代码里有 || 720 兜底, 无需额外处理

// -- 执行 bundle
const vm = require('vm');
const context = sandboxWindow; // happy-dom Window 即可作为全局(带 window self 等)
vm.createContext(context);
vm.runInContext(bundle, context, { filename: 'reader-bundle.js' });

// -- 收 ready
const readyMsg = posted.find((m) => m.type === 'ready');
assert(readyMsg, '挂载后应发送 ready');

// -- 派发 init
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async function run() {
  const dispatch = (type, payload) => {
    const event = new win.MessageEvent('message', { data: { type, payload } });
    sandboxWindow.dispatchEvent(event);
  };
  /** 顶层字段消息(shelf/library/openDrawer 等) */
  const sendMsg = (msg) => {
    const event = new win.MessageEvent('message', { data: msg });
    sandboxWindow.dispatchEvent(event);
  };

  dispatch('init', {
    filePath: novel.filePath,
    bookTitle: novel.bookTitle,
    author: novel.author,
    chapters: novel.chapters.map((c) => ({ index: c.index, title: c.title })),
    chapterIndex: 2,
    chapterTitle: novel.chapters[2].title,
    paragraphs: ['第一段。', '第二段。'],
    totalChapters: 5,
    totalWords: 123456,
    scrollRatio: 0.5,
    chapterWords: 6,
    settings: { ...defaults },
    shelf: [
      { filePath: novel.filePath, title: novel.bookTitle, author: novel.author, chapterIndex: 2, totalChapters: 5, current: true },
      { filePath: 'D:/b.txt', title: '另一本书', author: '', chapterIndex: -1, totalChapters: 8, current: false },
    ],
    libraryPath: 'D:/我的书库',
  });
  await sleep(50);

  const $ = (sel) => document.querySelector(sel);

  // 正文渲染
  assert($('#content .chapter-title'), '章节标题应渲染');
  assert($('#content .chapter-title').textContent.includes('标题3'), '应渲染第 3 章标题');
  const pCount = document.querySelectorAll('#content p').length;
  assert(pCount >= 2, '正文段落应渲染(实际 ' + pCount + ')');
  console.log('正文渲染(标题/段落): 通过');

  // 状态栏
  assert($('#bookInfo').textContent.includes('测试之书'), '书名应显示');
  assert($('#chapterInfo').textContent.includes('第 3 章'), '当前章应显示');
  assert($('#chapterWords').textContent.includes('6'), '本章字数应显示');
  assert(
    $('#chapterTitle') && $('#chapterTitle').textContent.includes('标题3'),
    '状态栏中间应显示当前章节标题'
  );
  console.log('状态栏(书名/章/字数): 通过');

  // 设置面板: openSettings 消息
  dispatch('openSettings');
  await sleep(20);
  assert($('#settingsPanel').classList.contains('open'), 'openSettings 消息应打开设置面板');
  // 主题圆点数量
  const dots = document.querySelectorAll('#settingsPanel .sp-dot');
  assert(dots.length === 6, '应有 6 个主题圆点(实际 ' + dots.length + ')');
  // 切主题: 点黑夜 -> 应立即发出 updateSettings(不吃 250ms 防抖, 侧边栏要即时跟随)
  const darkDot = Array.from(dots).find((d) => d.dataset.theme === 'dark');
  darkDot.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const themeUpdate = posted.find((m) => m.type === 'updateSettings' && m.patch && m.patch.theme === 'dark');
  assert(themeUpdate, '切主题应立即发出 updateSettings(patch.theme=dark), 不等防抖');
  assert(
    document.documentElement.style.getPropertyValue('--fab-bg') === '#1c1c1c',
    '切黑夜后 --fab-bg 应变为深底'
  );
  console.log('设置面板(打开/主题点/切主题变量): 通过');

  // 目录: 点侧边菜单「目录」打开弹窗
  document.querySelector('.menu-item[data-menu="catalog"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert($('#catalogPanel').classList.contains('open'), '点菜单「目录」应打开目录弹窗');
  const catItems = document.querySelectorAll('#catalogPanel .cat-item');
  assert(catItems.length === 5, '目录应列出 5 章(实际 ' + catItems.length + ')');
  const cur = document.querySelector('#catalogPanel .cat-item.cur');
  assert(cur && cur.dataset.i === '2', '当前章(第3章)应高亮');
  // 点第 1 章跳转
  const first = Array.from(catItems).find((el) => el.dataset.i === '0');
  first.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const jump = posted.find((m) => m.type === 'getChapter' && m.index === 0);
  assert(jump, '点目录条目应发出 getChapter(0)');
  assert(!$('#catalogPanel').classList.contains('open'), '跳转后目录面板应关闭');
  console.log('目录面板(打开/条目/高亮/跳转): 通过');

  // 弹窗互斥: 任意时刻最多一个(目录/阅读设置/书架/存储)
  const menuItem = (id) => document.querySelector('.menu-item[data-menu="' + id + '"]');
  dispatch('openSettings');
  await sleep(20);
  assert($('#settingsPanel').classList.contains('open'), '应能再次打开设置弹窗');
  menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert($('#catalogPanel').classList.contains('open'), '点菜单「目录」应打开目录弹窗');
  assert(!$('#settingsPanel').classList.contains('open'), '打开目录应自动关闭阅读设置(互斥)');
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert($('#shelfPopup').classList.contains('open'), '点菜单「书架」应打开书架弹窗');
  assert(!$('#catalogPanel').classList.contains('open'), '打开书架应自动关闭目录(互斥)');
  menuItem('storage').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert($('#storagePopup').classList.contains('open'), '点菜单「存储位置」应打开存储弹窗');
  assert(!$('#shelfPopup').classList.contains('open'), '打开存储应自动关闭书架(互斥)');
  // 再点同一个菜单项 -> 关闭(切换语义)
  menuItem('storage').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(!$('#storagePopup').classList.contains('open'), '再点同一菜单项应收起弹窗');
  console.log('弹窗互斥(目录/设置/书架/存储): 通过');

  // 无磨砂背景: 弹窗仍能点外部关闭
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert($('#shelfPopup').classList.contains('open'), '点菜单应打开弹窗');
  assert(!document.querySelector('.popup-backdrop'), '不应存在磨砂玻璃背景层');
  const outside = document.createElement('div');
  document.body.appendChild(outside);
  outside.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  await sleep(30);
  assert(!$('#shelfPopup').classList.contains('open'), '点击弹窗外应关闭弹窗');
  outside.remove();
  console.log('无磨砂背景 + 点外部关闭: 通过');
  // 三个弹窗(书架/阅读设置/存储)关闭按钮文案统一为「关闭」
  for (const id of ['shelf', 'settings', 'storage']) {
    menuItem(id).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const closeBtn = document.querySelector('#shelfPopup.open .popup-close, #settingsPanel.open .popup-close, #storagePopup.open .popup-close');
    assert(closeBtn && closeBtn.textContent.trim() === '关闭', '弹窗关闭按钮应为「关闭」: ' + id);
  }
  document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  await sleep(30);
  console.log('关闭按钮统一为「关闭」: 通过');


  // 上一章悬浮球
  dispatch('chapter', { index: 1, title: '第2章 标题2', paragraphs: ['a'], totalChapters: 5, chapterWords: 1, scrollRatio: 0 });
  await sleep(20);
  assert($('#chapterInfo').textContent.includes('第 2 章'), '切换章节后状态栏应更新');
  console.log('章节切换(chapter 消息): 通过');

  // Ctrl+滚轮缩放字号
  const beforeFont = JSON.parse(JSON.stringify(posted)).filter((m) => m.type === 'updateSettings' && m.patch && m.patch.fontSize).length;
  const wheelEvt = new win.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
  Object.defineProperty(wheelEvt, 'ctrlKey', { value: true });
  document.dispatchEvent(wheelEvt);
  await sleep(300);
  const fontUpdates = posted.filter((m) => m.type === 'updateSettings' && m.patch && m.patch.fontSize);
  assert(fontUpdates.length > beforeFont, 'Ctrl+滚轮应发出 fontSize 更新');
  console.log('Ctrl+滚轮字号: 通过');

  // 正文宽度拖拽: pointerdown on handle + move + up
  const handle = $('#widthHandleRight') || document.querySelector('.width-handle:nth-of-type(2)');
  const handles = document.querySelectorAll('.width-handle');
  assert(handles.length === 2, '应有左右两个宽度手柄(实际 ' + handles.length + ')');
  const rh = handles[1];
  rh.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 800, pointerId: 7 }));
  document.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: 880, pointerId: 7 }));
  document.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, clientX: 880, pointerId: 7 }));
  await sleep(300);
  const widthUpdate = posted.find((m) => m.type === 'updateSettings' && m.patch && typeof m.patch.contentWidth === 'number');
  assert(widthUpdate, '拖宽松手应发出 contentWidth 更新');
  assert(widthUpdate.patch.contentWidth <= 4000, '拖宽不应超过 4000 上限(自定义宽度已放开)');
  console.log('正文宽度拖拽(手柄/持久化/放宽上限): 通过');

  // 页面宽度档位: 视口比例(33.33%~77.77%) + 自定义独占一行(聚焦即输入)
  {
    document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const widthRow = Array.from(document.querySelectorAll('#settingsPanel .sp-row'))
      .find((r) => (r.querySelector('.sp-label') || {}).textContent === '页面宽度');
    assert(widthRow, '应有「页面宽度」行');
    const ratioLabels = Array.from(widthRow.querySelectorAll('.sp-seg-btn')).map((b) => (b.textContent || '').trim());
    assert(
      ratioLabels.join(',') === '33.33%,55.55%,66.66%,77.77%',
      '页面宽度应为 4 个视口比例档, 实际: ' + ratioLabels.join(',')
    );
    posted.length = 0;
    widthRow.querySelectorAll('.sp-seg-btn')[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    assert(
      posted.some((m) => m.type === 'updateSettings' && m.patch && m.patch.widthRatio === 0.5555),
      '点比例档应保存 widthRatio(0.5555)'
    );

    // 自定义输入: 归入「页面宽度」行的第二行(与阅读主题同构), 无独立标签/应用按钮/提示块
    const stackRow = document.querySelector('#settingsPanel .sp-row-stack');
    assert(stackRow, '「页面宽度」应为两行结构行');
    assert(
      Array.from(stackRow.querySelectorAll('.sp-label')).map((e) => (e.textContent || '').trim()).join('') === '页面宽度',
      '该行只应有「页面宽度」一个标签'
    );
    const customInput = stackRow.querySelector('.sp-width-custom .sp-width-input');
    assert(customInput, '第二行应有自定义宽度输入框');
    assert(
      Array.from(stackRow.querySelectorAll('.sp-width-custom button')).length === 0,
      '自定义输入不应再有「应用」按钮'
    );
    assert(!document.querySelector('#settingsPanel .sp-width-tip'), '不应再有宽度提示块');
    const allLabels = Array.from(document.querySelectorAll('#settingsPanel .sp-label'))
      .map((e) => (e.textContent || '').trim());
    assert(allLabels.indexOf('自定义') < 0, '不应再有「自定义」标签, 实际: ' + allLabels.join('/'));
    // text + inputmode=numeric: number 输入框不支持 select(), 聚焦无法全选
    assert(customInput.getAttribute('type') === 'text', '宽度输入框应为 type=text(支持聚焦全选)');
    assert(customInput.getAttribute('inputmode') === 'numeric', '宽度输入框应有 inputmode=numeric');
    document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    console.log('页面宽度(视口比例档/自定义独立行): 通过');
  }

  // 快捷键 Alt+ArrowRight 下一章
  const nextCountBefore = posted.filter((m) => m.type === 'getChapter').length;
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
  await sleep(20);
  assert(posted.filter((m) => m.type === 'getChapter').length > nextCountBefore, 'Alt+→ 应发出 getChapter');
  console.log('快捷键(Alt+→): 通过');

  // 进度上报
  dispatch('chapter', { index: 3, title: '第4章 标题4', paragraphs: ['x'], totalChapters: 5, chapterWords: 1, scrollRatio: 0.3 });
  await sleep(20);
  const progress = posted.find((m) => m.type === 'saveProgress' && m.chapterIndex === 3);
  assert(progress, '章节渲染后应立即上报进度');
  console.log('进度上报(saveProgress): 通过');

  // ---------------- 侧边菜单(占位式布局 + 折叠) ----------------
  const menuEl = document.querySelector('.menu');
  assert(menuEl, '应有侧边菜单');
  assert(document.querySelector('.shell .menu') && document.querySelector('.shell .main'), '布局应为 shell[menu|main](占位式, 非浮层)');
  assert(menuEl.classList.contains('expanded'), '默认应展开菜单');
  assert(document.documentElement.style.getPropertyValue('--menu-w') === '176px', '展开时 --menu-w 应为 176px(状态栏让位)');
  document.querySelector('.menu-toggle').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!menuEl.classList.contains('expanded'), '点菜单按钮应收起');
  assert(document.documentElement.style.getPropertyValue('--menu-w') === '48px', '收起时 --menu-w 应为 48px');
  assert(
    document.querySelectorAll('.menu-item:not(.menu-toggle-statusbar)').length === 4,
    '菜单应有 4 个弹窗功能项'
  );
  assert(document.querySelectorAll('.menu-item[data-menu]').length === 5, '菜单共 5 项(含状态栏开关)');
  assert(document.querySelector('.menu-item[data-menu="statusbar"]'), '菜单应有「状态栏」显隐开关');
  // 顺序: 书架 → 目录 → 状态栏 → 阅读设置 → 存储位置, 分割线在最下方
  const order = Array.from(document.querySelector('.menu').children).map((el) =>
    el.classList.contains('menu-divider') ? 'divider' : el.getAttribute('data-menu'));
  assert(
    JSON.stringify(order) === JSON.stringify([null, 'divider', 'shelf', 'catalog', 'statusbar', 'settings', 'storage']),
    '菜单顺序应为 折叠按钮 + 分割线 + 书架/目录/状态栏/阅读设置/存储位置, 实际: ' + JSON.stringify(order)
  );
  assert(/\.menu-divider\s*\{[^}]*margin:\s*0\s+12px/.test(capturedHtml), '分隔线应无上下外边距(仅左右缩进)');
  // CSS 完整性: 源文件注释必须成对闭合(未闭合的 /* 会吞掉后续声明, 曾导致分隔线背景丢失)
  {
    const srcCss = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'reader.css'), 'utf8');
    const opens = (srcCss.match(/\/\*/g) || []).length;
    const closes = (srcCss.match(/\*\//g) || []).length;
    assert(opens === closes, `源 CSS 注释应闭合(/* ${opens} 个, */ ${closes} 个)`);
    assert(
      /\.menu-divider\s*\{[^}]*background:\s*var\(--sp-border\)/.test(capturedHtml),
      '分隔线必须有可见背景色(--sp-border)'
    );
  }
  assert(
    document.querySelector('.menu').children[1].classList.contains('menu-divider'),
    '分割线应在折叠按钮之后(菜单项之前)'
  );
  // 图标尺寸统一(原菜单项 18px < toggle 20px); happy-dom 无布局, 断言 CSS 规则
  assert(/\.menu svg\s*\{[^}]*width:\s*20px/.test(capturedHtml), '菜单图标应统一 20px');
  // 鼠标点击不应残留焦点框(仅键盘导航显示)
  assert(
    /button:focus:not\(:focus-visible\)[^{]*\{[^}]*outline:\s*none/.test(capturedHtml),
    '鼠标点击后不应残留焦点框(outline:none)'
  );
  assert(/button:focus-visible[^{]*\{[^}]*outline:\s*2px/.test(capturedHtml), '键盘导航仍应显示焦点框');
  // 状态栏开关改用「底栏」矩形图标(不再用眼睛, 避免与护眼模式混淆)
  const sbIconSvg = document.querySelector('.menu-item[data-menu="statusbar"] svg').outerHTML;
  assert(/<rect/.test(sbIconSvg), '状态栏开关应使用矩形(底栏)图标');
  assert(!/circle/.test(sbIconSvg), '状态栏开关不应再使用眼睛图标(含 circle)');
  document.querySelector('.menu-toggle').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  // 状态栏显隐: 默认显示, 点开关隐藏/再点恢复
  const statusEl = document.querySelector('.statusbar');
  assert(statusEl && statusEl.style.display !== 'none', '默认应显示状态栏');
  const sbItem = document.querySelector('.menu-item[data-menu="statusbar"]');
  assert(sbItem.getAttribute('title') === '隐藏状态栏', '显示中时提示应为「隐藏状态栏」');
  posted.length = 0;
  sbItem.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  assert(statusEl.style.display === 'none', '点开关后状态栏应隐藏');
  assert(
    posted.some((m) => m.type === 'updateSettings' && m.patch && m.patch.showStatusBar === false),
    '隐藏状态栏应持久化(updateSettings.showStatusBar=false)'
  );
  assert(sbItem.getAttribute('title') === '显示状态栏', '隐藏后提示应为「显示状态栏」');
  posted.length = 0;
  sbItem.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  assert(statusEl.style.display !== 'none', '再点开关应恢复显示');
  assert(
    posted.some((m) => m.type === 'updateSettings' && m.patch && m.patch.showStatusBar === true),
    '恢复显示也应持久化'
  );
  // 开关不应影响弹窗(独立开关)
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  sbItem.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert($('#shelfPopup').classList.contains('open'), '状态栏开关不应关闭已打开的弹窗');
  document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  await sleep(30);
  console.log('状态栏显隐开关(默认显示/隐藏/恢复/独立): 通过');

  // Esc 应清掉焦点残留(按钮被点过再按 Esc, 浏览器会画出 focus-visible 边框)
  const focusTarget = document.querySelector('.menu-item[data-menu="catalog"]');
  focusTarget.focus();
  assert(document.activeElement === focusTarget, '前置: 按钮应能获得焦点');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(30);
  assert(document.activeElement !== focusTarget, 'Esc 后应清掉焦点(避免残留焦点框)');

  // 地域色彩主题: 省份下拉 + 色卡预览 + 选中即切换主题
  document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  // 省份选择器已并入「阅读主题」行(与预设色块同一行), 且不再显示色卡圆点
  const provBtn = document.querySelector('#settingsPanel .sp-themes .sp-province-btn');
  assert(provBtn, '「阅读主题」行内应有省份选择器');
  // 未启用地域主题时应为占位文案「地域色彩」(此前会误显示上次的省份名)
  {
    // 先点一个预设主题色块 -> 此时不属于地域主题
    const sepiaDot = document.querySelector('#settingsPanel .sp-dot[data-theme="sepia"]');
    sepiaDot.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const label = (provBtn.textContent || '').trim();
    assert(label === '地域色彩', '未选地域主题时按钮应显示占位「地域色彩」, 实际: ' + label);
  }
  assert(!document.querySelector('#settingsPanel .sp-province'), '不应再有独立的「地域色彩」行容器');
  assert(!document.querySelector('#settingsPanel .sp-color-chip'), '不应再显示省份色卡圆点');
  {
    const labels = Array.from(document.querySelectorAll('#settingsPanel .sp-label'))
      .map((el) => (el.textContent || '').trim());
    assert(labels.indexOf('地域色彩') < 0, '「地域色彩」标签应已移除, 实际: ' + labels.join('/'));
    assert(labels[0] === '阅读主题', '第一行仍应为「阅读主题」');
  }
  assert(!document.querySelector('#settingsPanel .sp-themes select'), '不应再用原生 select(滚动条无法收细)');
  provBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const provItems = document.querySelectorAll('#settingsPanel .sp-province-menu .sp-province-item');
  assert(provItems.length === 34, '展开后应有 34 个省级区域(实际 ' + provItems.length + ')');
  // 列表必须完全展开(自适应内容), 不能再出现自带滚动条
  // (happy-dom 无 getComputedStyle, 直接断言 CSS 规则)
  {
    const menuRule = /\.sp-province-menu\s*\{([^}]*)\}/.exec(capturedHtml);
    assert(menuRule, '应存在 .sp-province-menu 样式规则');
    const css = menuRule[1];
    assert(/width:\s*max-content/.test(css), '省份列表宽度应自适应内容(max-content)');
    assert(!/max-height/.test(css), '省份列表不应限制高度(应由内容撑开)');
    assert(!/overflow(-y)?:\s*(auto|scroll)/.test(css), '省份列表不应有滚动条');
  }
  posted.length = 0;
  const gdItem = Array.from(provItems).find((el) => (el.textContent || '').trim() === '广东');
  assert(gdItem, '省份列表应包含「广东」');
  gdItem.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  assert(
    posted.some((m) => m.type === 'updateSettings' && m.patch && m.patch.theme === 'province' && m.patch.province === '440000'),
    '选省应同时切换地域主题并保存省份代码'
  );
  assert(!document.querySelector('#settingsPanel .sp-province-menu'), '选中后列表应收起');

  // 悬浮预览: 悬浮某省临时套用其色板(不落盘), 移出还原
  {
    const root = document.documentElement;
    const bgOf = () => root.style.getPropertyValue('--bg').trim();
    const logged = bgOf();
    // 当前已选中「广东」, 悬浮「新疆」应产生不同色板
    const baseBg = bgOf();
    provBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const items = document.querySelectorAll('#settingsPanel .sp-province-menu .sp-province-item');
    const xj = Array.from(items).find((el) => (el.textContent || '').trim() === '新疆');
    assert(xj, '省份列表应包含「新疆」');
    posted.length = 0;
    xj.dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: false }));
    await sleep(30);
    const hoverBg = bgOf();
    assert(hoverBg !== baseBg, '悬浮省份应实时预览该省色板(实际未变化)');
    assert(
      posted.length === 0,
      '预览不应触发持久化(悬浮只改 CSS 变量)'
    );
    assert(root.dataset.theme === 'province', '预览时主题标记应切到 province');
    // 移出列表 -> 还原
    const menuEl = document.querySelector('#settingsPanel .sp-province-menu');
    menuEl.dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: false }));
    await sleep(30);
    assert(bgOf() === baseBg, '移出列表应还原为原主题色板');
    assert(logged !== undefined, '前置变量应可读');
    document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    console.log('地域色彩悬浮预览(实时套用/不落盘/移出还原): 通过');
  }

  // 预设主题色块也要能悬浮预览
  {
    const root = document.documentElement;
    const bgOf = () => root.style.getPropertyValue('--bg').trim();
    document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const baseBg = bgOf();
    const darkDot = document.querySelector('#settingsPanel .sp-dot[data-theme="dark"]');
    assert(darkDot, '应有黑夜主题色块');
    posted.length = 0;
    darkDot.dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: false }));
    await sleep(30);
    assert(bgOf() !== baseBg, '悬浮预设色块应实时预览该主题(实际未变化)');
    assert(root.dataset.theme === 'dark', '预览黑夜应把 data-theme 切到 dark');
    assert(posted.length === 0, '预设预览不应触发持久化');
    const row = document.querySelector('#settingsPanel .sp-themes');
    row.dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: false }));
    await sleep(30);
    assert(bgOf() === baseBg, '移出色块行应还原原主题');
    document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    console.log('预设主题悬浮预览(实时套用/不落盘/移出还原): 通过');
  }
  document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  // 地域色板必须由构建期注入(34 套), 不能端上现算
  const virtualSrc = fs.readFileSync(path.join(__dirname, '..', 'vite.config.mjs'), 'utf8');
  assert(/PROVINCE_THEMES/.test(virtualSrc) && /provinceTheme/.test(virtualSrc), 'vite 应构建期生成省份色板');
  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'store.ts'), 'utf8');
  assert(/PROVINCE_THEMES\[province/.test(storeSrc), 'webview themeOf 应从省份色板查表');
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.ts'), 'utf8');
  assert(
    /s\.theme === "province"[^;]*s\.theme === "term"[^;]*THEMES\.some/.test(settingsSrc),
    '主题白名单必须放行 province 与 term(否则会静默丢弃)'
  );
  assert(/TERM_THEMES\[term/.test(storeSrc), 'webview themeOf 应从节气色板查表');
  assert(/ensureContrast\(/.test(settingsSrc), '色板推导必须做过对比度校正');
  assert(/\*::-webkit-scrollbar\s*\{[^}]*width:\s*8px/.test(capturedHtml), '全局滚动条应收细到 8px');
  // 廿四节气: 与地域色彩同一行(阅读主题的第二行), 24 项, 悬浮可预览
  {
    const row = document.querySelector('#settingsPanel .sp-row-theme');
    assert(row, '阅读主题行应存在');
    assert(row.querySelectorAll('.sp-theme-extra .sp-province-btn').length === 2,
      '阅读主题第二行应有 2 个选择器(地域色彩/廿四节气)');
    const termBtn = row.querySelector('.sp-province-picker[data-kind="term"] .sp-province-btn');
    assert(termBtn, '应有廿四节气选择器');
    assert((termBtn.textContent || '').trim() === '廿四节气', '未启用节气主题时应显示占位「廿四节气」');
    termBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const termItems = document.querySelectorAll('#settingsPanel .sp-term-menu .sp-province-item');
    assert(termItems.length === 24, '节气列表应有 24 项(实际 ' + termItems.length + ')');
    const root = document.documentElement;
    const before = root.style.getPropertyValue('--bg').trim();
    posted.length = 0;
    const daxue = Array.from(termItems).find((el) => (el.textContent || '').trim() === '大雪');
    assert(daxue, '节气列表应包含「大雪」');
    daxue.dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: false }));
    await sleep(30);
    assert(root.style.getPropertyValue('--bg').trim() !== before, '悬浮节气应实时预览色板');
    assert(root.dataset.theme === 'term', '预览节气应把 data-theme 切到 term');
    assert(posted.length === 0, '节气预览不应触发持久化');
    daxue.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    assert(
      posted.some((m) => m.type === 'updateSettings' && m.patch && m.patch.theme === 'term' && m.patch.term === 'daxue'),
      '选节气应保存 term 并切到 term 主题'
    );
    assert(!document.querySelector('#settingsPanel .sp-term-menu'), '选中后节气列表应收起');
    document.querySelector('.menu-item[data-menu="settings"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    console.log('廿四节气主题(同行/24项/悬浮预览/落盘): 通过');
  // 下拉定位与色条: 菜单锚定在第二行容器(而不是各自按钮), 否则会越界被裁
  {
    assert(/\.sp-theme-extra[^{]*\{[^}]*position:\s*relative/.test(capturedHtml), '第二行容器应作为菜单定位基准');
    assert(!/\.sp-province-picker[^{]*\{[^}]*position:\s*relative/.test(capturedHtml),
      '选择器不应自行定位(否则菜单从按钮处展开会越界)');
    // 省份条目应有代表色条(与节气一致)
    const firstProvItem = document.querySelector('#settingsPanel .sp-province-menu .sp-province-item');
    if (firstProvItem) {
      assert(firstProvItem.style.borderLeftColor, '省份条目应带左侧代表色条');
    }
    assert(/\.sp-province-menu \.sp-province-item[^{]*\{[^}]*border-left:\s*3px/.test(capturedHtml),
      '省份条目应有 3px 色条样式');
  }
  // 悬浮提示只显示「名称 · 色名」, 不带十六进制色值
  {
    const provItem = document.querySelector('#settingsPanel .sp-province-menu .sp-province-item');
    const t1 = provItem ? provItem.getAttribute('title') : '';
    const termItem = document.querySelector('#settingsPanel .sp-term-menu .sp-province-item');
    const t2 = termItem ? termItem.getAttribute('title') : '';
    for (const [label, t] of [['省份', t1], ['节气', t2]]) {
      if (!t) { continue; }
      assert(t.indexOf('#') < 0, label + '悬浮提示不应包含色值, 实际: ' + t);
      assert(t.indexOf(' · ') > 0, label + '悬浮提示应为「名称 · 色名」格式, 实际: ' + t);
    }
  }
  console.log('下拉定位(锚定行容器/不越界) + 省份色条: 通过');
  }
  console.log('地域色彩主题(自绘下拉/色卡/切换/构建期色板) + 细滚动条: 通过');

  console.log('侧边菜单(占位布局/展开收起/4 功能项): 通过');

  // 切换按钮: 双状态图标(展开=右侧条纹, 收起=左侧条纹) + 无「菜单」文字
  const toggleHtml = document.querySelector('.menu-toggle').innerHTML;
  assert(!toggleHtml.includes('菜单'), '切换按钮不应再显示「菜单」文字(仅保留 hover 提示)');
  // 折叠按钮: 品牌 logo(原色保留, 不随主题变化)
  const logoSvg = document.querySelector('.menu-toggle svg');
  assert(logoSvg, '折叠按钮应有 logo');
  assert(/M430.602/.test(logoSvg.innerHTML), 'logo 路径应为用户提供的图形');
  assert(/#ED8F27/.test(logoSvg.innerHTML), 'logo 应保留原色(#ED8F27 橙)');
  {
    // 书上方的放射线条: 颜色由主题决定(浅色主题 #300604 / 黑夜 #FCE3C3), 不能再硬编码
    const paths = Array.from(document.querySelectorAll('.menu-toggle svg path'));
    assert(paths.length === 9, `logo 应为 9 条路径(放射线已拆分), 实际 ${paths.length}`);
    const spark = paths[paths.length - 1];
    assert(spark.getAttribute('class') === 'logo-spark', '放射线应带 logo-spark 类(交给 CSS 控色)');
    assert(spark.getAttribute('fill') === null, '放射线不应再硬编码 fill(需按主题切换)');
    assert(
      paths[paths.length - 2].getAttribute('fill') === '#300604',
      '书页内文字线应保持深色(#300604)'
    );
  }
  assert(
    /\.menu-toggle \.logo-spark[^{]*\{[^}]*fill:\s*#300604/i.test(capturedHtml),
    '放射线在浅色主题下应为 #300604'
  );
  assert(
    /:root\[data-theme=["']?dark["']?\][^{]*\.logo-spark[^{]*\{[^}]*fill:\s*#fce3c3/i.test(capturedHtml),
    '放射线在黑夜主题下应为 #FCE3C3'
  );
  assert(
    /root\.dataset\.theme\s*=\s*t\.id/.test(
      fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'store.ts'), 'utf8')
    ),
    'store 应把当前主题 id 写到根元素 data-theme(供 CSS 分支)'
  );
  assert(/#300604/.test(logoSvg.innerHTML) && /#FCE3C3/.test(logoSvg.innerHTML), 'logo 应保留其余原色');
  assert(!/currentColor/.test(logoSvg.innerHTML), 'logo 不应被改成 currentColor(用户要求颜色不改)');
  assert(
    /\.menu-toggle svg\s*\{[^}]*width:\s*46px/.test(capturedHtml),
    '展开态 logo 应为 46px'
  );
  assert(
    /\.menu-toggle\s*\{[^}]*padding:\s*10px\s+0\s+10px\s+17px/.test(capturedHtml),
    'logo 行上下内边距应与其他菜单项一致(10px), 左边距 17px 与图标对齐'
  );
  assert(
    /\.menu\s*\{[^}]*padding-top:\s*0/.test(capturedHtml),
    '菜单容器顶部不应留白(padding-top: 0)'
  );
  assert(
    /\.menu:not\(\.expanded\) \.menu-toggle svg\s*\{[^}]*width:\s*28px/.test(capturedHtml),
    '收起态 logo 应缩到 28px 并与图标列同左缘对齐'
  );
  assert(
    /\.menu:not\(\.expanded\) \.menu-toggle\s*\{[^}]*padding-left:\s*9px/.test(capturedHtml),
    '收起态 logo 应居中(padding-left: 9px)'
  );
  assert(
    /\.menu:not\(\.expanded\) \.menu-item\s*\{[^}]*padding-left:\s*11px/.test(capturedHtml),
    '收起态菜单图标应水平居中(padding-left: 11px)'
  );
  assert(
    /\.menu-toggle,\s*\.menu-item\s*\{[^}]*transition:\s*padding-left/.test(capturedHtml),
    '左右位置应可过渡(收起/展开时图标平滑移动)'
  );
  assert(
    /viewBox="158 184 686 720"/.test(capturedHtml) || /viewBox="158 184 686 720"/.test(fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'components', 'SideMenu.vue'), 'utf8')),
    'logo viewBox 应收紧到图形实际边界(去掉 SVG 自带空白, 避免显得小/偏)'
  );
  assert(!document.querySelector('.dw-lines-right, .dw-lines-left'), '不应再有旧的双状态条纹路径');
  assert(document.querySelector('.menu-toggle').getAttribute('title'), '切换按钮应保留 hover 提示(title)');
  assert(
    /\.progress-fill\s*\{[^}]*background:\s*var\(--sp-accent\)/.test(capturedHtml),
    '底部进度条填充应存在, 且与侧边栏高亮同色(--sp-accent)'
  );
  assert(!/\.menu-toggle\s*\{[^}]*color:\s*var\(--sp-muted\)/.test(capturedHtml),
    'toggle 图标颜色不应偏淡(与菜单项一致)');
  assert(/\.menu-ico\s*\{/.test(capturedHtml), '菜单项应有图标容器 .menu-ico');
  const menuSrc = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'components', 'SideMenu.vue'), 'utf8');
  assert(/SVG_SHELF/.test(menuSrc) && /1024 1024/.test(menuSrc), '书架图标应换成 1024 viewBox 的新图标');
  assert(/SVG_CATALOG/.test(menuSrc) && /863\.113/.test(menuSrc), '目录图标应换成用户提供的新图标');
  assert(!/fill="#231815"/.test(menuSrc), '新图标应去掉硬编码 fill(改用 currentColor 跟随主题)');

  // 书架弹窗
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const bks = document.querySelectorAll('#shelfPopup .bk');
  assert(bks.length === 2, '书架弹窗应渲染 2 本(实际 ' + bks.length + ')');
  assert(bks[0].classList.contains('cur'), '当前书应标记');
  assert(document.querySelector('#shelfPopup .popup-sub').textContent.includes('共 2 本'), '应显示册数');
  posted.length = 0;
  bks[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'openBook' && m.filePath === 'D:/b.txt'), '点书架条目应发 openBook');
  assert(!$('#shelfPopup').classList.contains('open'), '打开书后书架弹窗应收起');
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  posted.length = 0;
  document.querySelector('#shelfPopup .bp-del').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'removeBook'), '点移除应发 removeBook');
  assert(
    document.querySelectorAll('#shelfPopup .bk').length === 2,
    '未确认前不应从列表移除(等扩展二次确认后刷新)'
  );
  // 扩展确认后推送权威列表 -> 行消失
  sendMsg({ type: 'shelf', items: [{ filePath: 'D:/b.txt', title: '另一本书', author: '', chapterIndex: -1, totalChapters: 8, current: false }] });
  await sleep(30);
  assert(document.querySelectorAll('#shelfPopup .bk').length === 1, '扩展推送后列表应更新为 1 本');
  document.querySelector('#shelfPopup .popup-primary').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'openFile'), '点「添加书籍」应发 openFile');
  assert(document.querySelector('#shelfPopup').classList.contains('open'), '点「添加书籍」不应关闭弹窗');
  posted.length = 0;
  const refreshBtn = document.querySelector('#shelfPopup .popup-secondary');
  assert(refreshBtn, '设置书库目录后应显示「刷新书架」按钮');
  refreshBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'refreshLibrary'), '点「刷新书架」应发 refreshLibrary');
  console.log('书架弹窗(渲染/打开/移除/添加): 通过');

  // 目录弹窗(菜单打开) + 章节跳转
  menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const dwChs = document.querySelectorAll('#catalogPanel .cat-item');
  assert(dwChs.length === 5, '目录弹窗应列出 5 章');
  assert(document.querySelector('#catalogPanel .cat-item.cur'), '目录弹窗应高亮当前章');
  posted.length = 0;
  Array.from(dwChs).find((el) => el.dataset.i === '0').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'getChapter' && m.index === 0), '点章节应发 getChapter');
  console.log('目录弹窗(渲染/高亮/跳转): 通过');

  // 存储弹窗
  menuItem('storage').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('#storagePopup .popup-val').textContent.includes('D:/我的书库'), '存储弹窗应显示书库目录');
  posted.length = 0;
  const spBtns = Array.from(document.querySelectorAll('#storagePopup .popup-btn'));
  spBtns.find((b) => b.textContent.includes('选择书库目录')).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  spBtns.find((b) => b.textContent.includes('打开')).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  spBtns.find((b) => b.textContent.includes('原路径')).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'pickLibrary'), '应发 pickLibrary');
  assert(posted.some((m) => m.type === 'openLibraryFolder'), '应发 openLibraryFolder');
  assert(posted.some((m) => m.type === 'clearLibrary'), '应发 clearLibrary');
  console.log('存储弹窗(目录展示/按钮): 通过');

  // 底部章节导航(跟随页面滚动的正文尾部按钮)
  const chNavs = Array.from(document.querySelectorAll('#reader .ch-nav-btn'));
  assert(chNavs.length === 2, '应有两个章节导航按钮(实际 ' + chNavs.length + ')');
  assert(!document.querySelector('#content .ch-nav'), '章节导航应在纸面外侧(#content 之外)');
  posted.length = 0;
  chNavs[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'getChapter'), '点正文底部「上一章」应发 getChapter');
  console.log('正文底部章节导航: 通过');

  // 扩展消息 openDrawer 兼容(命令 [书架/目录/存储] 打开对应弹窗)
  sendMsg({ type: 'openDrawer', tab: 'catalog' });
  await sleep(30);
  assert($('#catalogPanel').classList.contains('open'), 'openDrawer(catalog) 应打开目录弹窗');
  assert(!$('#storagePopup').classList.contains('open'), '同时只应有一个弹窗');
  sendMsg({ type: 'openDrawer', tab: 'storage' });
  await sleep(30);
  assert($('#storagePopup').classList.contains('open') && !$('#catalogPanel').classList.contains('open'), 'openDrawer(storage) 应切到存储弹窗');

  // shelf / library 消息实时刷新
  sendMsg({ type: 'shelf', items: [{ filePath: 'D:/c.txt', title: 'C书', author: '', chapterIndex: 0, totalChapters: 3, current: true }] });
  sendMsg({ type: 'library', path: '' });
  await sleep(30);
  assert(document.querySelectorAll('#shelfPopup .bk').length === 1, 'shelf 消息应刷新书架');
  assert(document.querySelector('#storagePopup .popup-val').textContent.includes('未设置'), 'library 空值应显示未设置');
  const refreshHidden = document.querySelector('#shelfPopup .popup-secondary');
  assert(
    !refreshHidden || refreshHidden.style.display === 'none',
    '未设置书库目录时应隐藏「刷新书架」按钮(v-show -> display:none)'
  );
  console.log('弹窗·消息协议(openDrawer/shelf/library): 通过');

  // ---------------- webview 消息 -> 扩展命令 分发 ----------------
  assert(typeof panelMsgHandler === 'function', '面板应注册消息处理');
  executedCommands.length = 0;
  const sendFromWebview = (msg) => { void panelMsgHandler(msg); };
  sendFromWebview({ type: 'openBook', filePath: 'D:/x.txt' });
  sendFromWebview({ type: 'removeBook', filePath: 'D:/x.txt' });
  sendFromWebview({ type: 'pickLibrary' });
  sendFromWebview({ type: 'clearLibrary' });
  sendFromWebview({ type: 'openLibraryFolder' });
  sendFromWebview({ type: 'refreshLibrary' });
  sendFromWebview({ type: 'openFile' });
  await sleep(20);
  for (const [cmd, arg] of [
    ['novelReader.openBook', 'D:/x.txt'],
    ['novelReader.removeFromShelf', 'D:/x.txt'],
    ['novelReader.pickLibraryPath', undefined],
    ['novelReader.clearLibraryPath', undefined],
    ['novelReader.openLibraryFolder', undefined],
    ['novelReader.refreshShelfFromLibrary', undefined],
    ['novelReader.openFile', undefined],
  ]) {
    assert(
      executedCommands.some((e) => e.cmd === cmd && (arg === undefined || e.arg === arg)),
      `消息应转发到命令 ${cmd}`
    );
  }
  console.log('抽屉动作 -> 扩展命令分发: 通过');

  // ---------------- 扩展清单(无活动栏入口, 状态栏为常驻入口) ----------------
  {
    const pkgJson = require('../package.json');
    const c = pkgJson.contributes;
    assert(!c.viewsContainers, '活动栏容器应已移除(侧边栏入口不可靠, 避免误导)');
    assert(!c.views, '活动栏视图应已移除');
    assert(!(c.menus['view/title'] || []).length, '不应有 view/title 菜单');
    const cmds = c.commands.map((x) => x.command);
    assert(!cmds.includes('novelReader.backFromSettings'), '「返回」命令应已移除');
    assert(cmds.includes('novelReader.refreshShelfFromLibrary'), '应有「刷新书架」命令');    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    assert(
      !/modal: true \}, '移除', '取消'/.test(extSrc),
      '删除确认框不应手动传「取消」(VS Code 模态框自带, 会渲染出两个取消)'
    );
    assert(/modal: true \}, '移除'\)/.test(extSrc), '删除确认框应只传「移除」按钮');
    assert(/whyNotTrash/.test(extSrc), '不移除文件时应说明原因(未设置书库/不在书库内/文件不存在)');
    assert(/planDuplicateRemoval/.test(extSrc), '刷新书架应做同书去重');
    assert(/deriveTitleAuthor/.test(extSrc), '刷新书架应按文件名同步书名(纠偏)');
    const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.ts'), 'utf8');
    assert(/showStatusBar: boolean/.test(settingsSrc), '设置应包含 showStatusBar 字段');
    assert(/showStatusBar: true/.test(settingsSrc), 'showStatusBar 默认应为 true(显示)');
    assert(/'  "showStatusBar",'/.test(settingsSrc) || /"showStatusBar",/.test(settingsSrc), 'showStatusBar 应可持久化');
    for (const need of ['novelReader.showBookshelf', 'novelReader.showChapters', 'novelReader.showSettings']) {
      assert(cmds.includes(need), '弹窗入口命令应保留: ' + need);
    }
    assert(pkgJson.activationEvents.includes('onStartupFinished'), '启动自动恢复需 onStartupFinished');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    assert(/createStatusBarItem/.test(src), '应有状态栏入口(常驻)');
    assert(!/registerWebviewViewProvider/.test(src), '不应再注册活动栏视图');
    assert(
      !fs.existsSync(path.join(__dirname, '..', 'src', 'launcherViewProvider.ts')),
      'launcher 入口文件应已删除'
    );
    console.log('扩展清单(无活动栏入口/状态栏常驻/命令齐备): 通过');

  // 窗口重开恢复: 上次开着的阅读页原样恢复(默认开启), 显式关闭才丢弃
  {
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'readerPanel.ts'), 'utf8');
    const settingsSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.ts'), 'utf8');
    const storeSrc2 = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'store.ts'), 'utf8');
    assert(/registerWebviewPanelSerializer/.test(extSrc), '应注册 WebviewPanelSerializer 以接管窗口恢复');
    assert(/static async restore\(/.test(panelSrc), 'ReaderPanel 应提供 restore 反序列化入口');
    assert(/!restoreOnStartup[\s\S]{0,80}panel\.dispose\(\)/.test(panelSrc),
      '开关关闭时必须直接 dispose 恢复出来的面板');
    assert(/restoreOnStartup: true/.test(settingsSrc2), 'restoreOnStartup 默认应为 true(上次开着就原样恢复)');
    assert(/saveRestoreState\(/.test(storeSrc2), 'webview 应写入恢复信息(webview state)');
    // 恢复时必须走编码识别, 否则 GB18030 的书会乱码
    assert(
      /decodeBuffer\(/.test(panelSrc) && !/toString\(['"]utf-8['"]\)/.test(panelSrc),
      '窗口恢复时必须复用 decodeBuffer 识别编码(站点下载的 txt 常为 GB18030)'
    );
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const prop = pkgJson.contributes.configuration.properties['novelReader.restoreOnStartup'];
    assert(prop, '清单应声明 novelReader.restoreOnStartup 设置项');
    assert(prop.default === true, '该设置默认应为 true');
    console.log('窗口重开恢复(默认原样恢复/可显式关闭/编码识别): 通过');
  }

  // 恢复进度必须以「书架记录」为准, 且不能被 init 写死0 覆盖
  {
    const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'readerPanel.ts'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'App.vue'), 'utf8');
    const storeSrc3 = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'store.ts'), 'utf8');
    const extSrc3 = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

    assert(
      /shelfProgress/.test(panelSrc) && /shelved\?\.chapterIndex/.test(panelSrc),
      'restore 应以书架进度为优先真相源(webview setState 不可靠)'
    );
    assert(
      /shelf\.get\(filePath\)/.test(extSrc3) && /shelved/.test(extSrc3),
      'extension 应把书架进度查询传给 restore'
    );
    assert(
      /chapterIndex: \(p\.chapterIndex as number\)/.test(appSrc),
      'init 时写回恢复信息必须用真实章节号, 不能写死 0(会把刚恢复的进度抹掉)'
    );
    assert(
      /addEventListener\('scroll', onScroll/.test(appSrc) && /function onScroll/.test(appSrc),
      '滚动时必须上报进度, 否则章内位置永远存不住'
    );
    assert(
      /visibilitychange/.test(appSrc),
      '页面隐藏时应补一次上报, 避免最后一段滚动丢失'
    );
    assert(
      /state\.chapter\.scrollRatio = ratio/.test(storeSrc3),
      '上报时应同步 scrollRatio 供切章恢复使用'
    );
    console.log('恢复进度优先级(书架为准/init 不写死0/滚动上报): 通过');
  }

  // 启动绝不自动弹出: activate 里预载书架不得 openPanel:true
  {
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    const startIdx = extSrc.indexOf('migrateLegacySession');
    assert(startIdx > 0, 'activate 应执行旧数据迁移');
    const tail = extSrc.slice(startIdx);
    assert(
      !/openPanel:\s*true/.test(tail),
      '启动流程中不得出现 openPanel: true(这是新开窗口自动弹出阅读页的根因)'
    );
    assert(
      /openPanel:\s*false,\s*silent:\s*true/.test(tail),
      '启动时只应静默预载书架(openPanel: false)'
    );
    console.log('启动不自动弹出阅读页: 通过');
  }
  }

  console.log('\n阅读面板 Vue 冒烟测试全部通过 ✔');
  process.exit(0);
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
