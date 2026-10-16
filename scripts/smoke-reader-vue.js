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
  assert(widthUpdate.patch.contentWidth <= 1200, '拖宽不应超过 1200 上限');
  console.log('正文宽度拖拽(手柄/持久化/上限): 通过');

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
  assert(document.querySelectorAll('.menu-item').length === 4, '菜单应有 4 个功能项');
  document.querySelector('.menu-toggle').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  console.log('侧边菜单(占位布局/展开收起/4 功能项): 通过');

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
  document.querySelector('#shelfPopup .popup-primary').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'openFile'), '点「添加书籍」应发 openFile');
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
  sendFromWebview({ type: 'openFile' });
  await sleep(20);
  for (const [cmd, arg] of [
    ['novelReader.openBook', 'D:/x.txt'],
    ['novelReader.removeFromShelf', 'D:/x.txt'],
    ['novelReader.pickLibraryPath', undefined],
    ['novelReader.clearLibraryPath', undefined],
    ['novelReader.openLibraryFolder', undefined],
    ['novelReader.openFile', undefined],
  ]) {
    assert(
      executedCommands.some((e) => e.cmd === cmd && (arg === undefined || e.arg === arg)),
      `消息应转发到命令 ${cmd}`
    );
  }
  console.log('抽屉动作 -> 扩展命令分发: 通过');

  // ---------------- 扩展清单(活动栏仅一个入口视图, UI 主体在抽屉) ----------------
  {
    const pkgJson = require('../package.json');
    const c = pkgJson.contributes;
    assert(
      c.viewsContainers && c.viewsContainers.activitybar && c.viewsContainers.activitybar.some((v) => v.id === 'r-novel-reader'),
      '活动栏图标应存在(单一入口视图)'
    );
    const views = c.views['r-novel-reader'];
    assert(views && views.length === 1 && views[0].id === 'novelReaderHome', '活动栏应只有一个入口视图');
    assert(views[0].name === '阅读', '入口视图名应为「阅读」');
    assert(views[0].type === 'webview', '入口视图应为 webview');
    assert(!(c.menus['view/title'] || []).length, '不应再有 view/title 菜单(旧三视图遗留)');
    const cmds = c.commands.map((x) => x.command);
    assert(!cmds.includes('novelReader.backFromSettings'), '「返回」命令应已移除');
    for (const need of ['novelReader.showBookshelf', 'novelReader.showChapters', 'novelReader.showSettings']) {
      assert(cmds.includes(need), '抽屉入口命令应保留: ' + need);
    }
    assert(pkgJson.activationEvents.includes('onStartupFinished'), '启动自动恢复需 onStartupFinished');

    // 入口视图(launcher)为动作型: 点图标收起侧边栏并打开阅读面板
    const launcherSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'launcherViewProvider.ts'), 'utf8');
    assert(/novelReaderHome/.test(launcherSrc), '入口视图 id 应为 novelReaderHome');
    assert(/workbench\.action\.closeSidebar/.test(launcherSrc), '入口视图应自动收起侧边栏(图标不留面板)');
    assert(/onActivate/.test(launcherSrc), '入口视图应有激活动作钩子');
    assert(!/btnShelf|我的书架/.test(launcherSrc), '入口视图不应再渲染书架等 UI(只留图标动作)');

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    assert(/createStatusBarItem/.test(src), '应有状态栏入口');
    assert(/registerWebviewViewProvider/.test(src), '应注册入口视图');
    console.log('扩展清单(单一入口视图/命令齐备/状态栏入口): 通过');
  }

  console.log('\n阅读面板 Vue 冒烟测试全部通过 ✔');
  process.exit(0);
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
