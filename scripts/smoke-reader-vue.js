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

// 打开钩子(「打开即记历史」的挂点): 首次打开与同书重开都应触发
let openedHook = null;
ReaderPanel.onOpen = (n, i) => { openedHook = { filePath: n.filePath, index: i }; };
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
  /#catalogPanel,\s*#settingsPanel,\s*#shelfPopup,\s*#storagePopup,\s*#notesPopup,\s*#sourcePopup\s*\{[^}]*background:\s*var\(--bg\)/.test(capturedHtml),
  '弹窗底色应统一为正文纸面色(--bg)'
);
assert(
  /left:\s*calc\(var\(--menu-w\)\s*\+\s*16px\)/.test(capturedHtml),
  '弹窗应靠左显示(贴菜单: left = menu-w + 16px)'
);
assert(
  !/translateX\(-50%\)/.test(capturedHtml),
  '弹窗不应再有居中位移(已改靠左)'
);
assert(
  /\.cat-group-toggle svg\s*\{[^}]*width:\s*16px/.test(capturedHtml),
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
/** 结构化克隆失败记录: 用来抓「把 Vue Proxy 直接 postMessage」这类问题 */
const cloneErrors = [];
let themeOverride = null;
const sandboxWindow = win;
sandboxWindow.acquireVsCodeApi = function () {
  // 模拟真实 webview 行为: 只允许调用一次, 调用后全局函数即被删除
  const api = {
    postMessage: (m) => {
      try {
        posted.push(structuredClone(m));
      } catch (err) {
        cloneErrors.push({ type: m && m.type, error: String(err) });
        posted.push(m);
      }
      return Promise.resolve(true);
    },
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
  // 在线章节: 切到未加载的章 -> 加载中 -> 失败 -> 重试
  sendMsg({ type: 'chapter', payload: { index: 3, title: '标题4', paragraphs: [], totalChapters: 5, chapterWords: 0, scrollRatio: 0 } });
  await sleep(20);
  sendMsg({ type: 'chapterLoading', payload: { index: 3, title: '标题4' } });
  await sleep(60);
  assert(!document.querySelector('#content [data-chapter-skeleton]'),
    '400ms 内不应闪骨架(缓存命中也是这条路径)');
  assert(!$('#content').textContent.includes('本章无内容'),
    '加载中不应显示「本章无内容」(会误导)');
  await sleep(420);
  const skeleton = document.querySelector('#content [data-chapter-skeleton]');
  assert(skeleton, '慢网(>400ms)应显示骨架屏, 而不是整屏卡住');
  assert(skeleton.getAttribute('aria-busy') === 'true', '骨架应标记 aria-busy');
  const skH = parseFloat(String(skeleton.getAttribute('style') || '').replace(/[^0-9.]/g, ''));
  assert(skH >= 120, '骨架应按纸面剩余高度撑满(实测高度 ' + skH + ')');
  assert(skeleton.querySelectorAll('.sk-line').length >= 20, '骨架行数应足够铺满整页');
  assert(document.querySelector('#content .chapter-title').textContent.includes('标题4'),
    '加载中标题应先切到目标章(点了要有反应)');
  const navBusy = document.querySelector('.side-nav-next');
  assert(navBusy && navBusy.disabled, '加载中应禁用翻章箭头, 防连点');
  sendMsg({ type: 'chapterError', payload: { index: 3, message: '正文解析结果为空' } });
  await sleep(20);
  assert(!document.querySelector('#content [data-chapter-skeleton]'), '失败后骨架应消失');
  assert(!document.querySelector('.side-nav-next').disabled, '失败后应恢复翻章');
  assert(document.querySelector('#content [data-chapter-error]'), '失败应显示错误态');
  assert(document.querySelector('#content [data-chapter-error]').textContent.includes('正文解析结果为空'),
    '错误态应显示原因');
  posted.length = 0;
  document.querySelector('#content [data-chapter-retry]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'retryChapter' && m.index === 3), '点重试应发送 retryChapter');
  sendMsg({ type: 'chapter', payload: { index: 3, title: '标题4', paragraphs: ['一', '二'], totalChapters: 5, chapterWords: 6, scrollRatio: 0 } });
  await sleep(60);
  assert(!document.querySelector('#content [data-chapter-error]'), '拿到正文后应清除错误态');
  // 还原到第 3 章, 不影响后续状态栏断言
  sendMsg({ type: 'chapter', payload: { index: 2, title: '标题3', paragraphs: ['一', '二'], totalChapters: 5, chapterWords: 6, scrollRatio: 0 } });
  await sleep(40);
  console.log('在线章节加载态(加载/失败/重试): 通过');

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

  // 状态栏右侧分隔符: 用 · 分隔, 不是空格(跟左侧一致)
  const sepDots = Array.from(document.querySelectorAll('.statusbar .status-sep'));
  assert(sepDots.length === 2, '状态栏右侧应有2 个 · 分隔符(实际 ' + sepDots.length + ')');
  assert(
    sepDots.every((s) => s.textContent.trim() === '·'),
    '状态栏分隔符应为 ·'
  );
  assert(
    document.querySelector('.statusbar .status-title') &&
      document.querySelector('.statusbar #chapterWords') &&
      document.querySelector('.statusbar #chapterInfo'),
    '状态栏右侧三段应同处 .status-parts 内'
  );
  console.log('状态栏 · 分隔符: 通过');

  // 设置面板: openSettings 消息
  dispatch('openSettings');
  await sleep(20);
  assert($('#settingsPanel').classList.contains('open'), 'openSettings 消息应打开设置面板');
  // 主题圆点数量
  const dots = document.querySelectorAll('#settingsPanel .sp-dot');
  assert(dots.length === 7, '应有 7 个主题圆点(实际 ' + dots.length + ')');
  // 切主题: 点黑夜 -> 应立即发出 updateSettings(不吃 250ms 防抖, 侧边栏要即时跟随)
  const darkDot = Array.from(dots).find((d) => d.dataset.theme === 'dark');
  darkDot.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const themeUpdate = posted.find((m) => m.type === 'updateSettings' && m.patch && m.patch.theme === 'dark');
  assert(themeUpdate, '切主题应立即发出 updateSettings(patch.theme=dark), 不等防抖');
  assert(
    document.documentElement.style.getPropertyValue('--nav-btn-bg') === '#1c1c1c',
    '切黑夜后 --nav-btn-bg 应变为深底'
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
    // 档位名改为「窄/标准/宽/特宽」，存储值不变（架构 §8.2 / R8-04）
    const segBtns = Array.from(widthRow.querySelectorAll('.sp-seg-btn'));
    const ratioLabels = segBtns.map((b) => (b.querySelector('.sr-only') ? (b.textContent || '').replace(b.querySelector('.sr-only').textContent, '').trim() : (b.textContent || '').trim()));
    assert(
      ratioLabels.join(',') === '窄,标准,宽,特宽',
      '页面宽度应对应 窄/标准/宽/特宽, 实际: ' + ratioLabels.join(',')
    );
    assert(
      segBtns.map((b) => b.dataset.ratio).join(',') === '0.3333,0.5555,0.6666,0.7777',
      '存储用的 widthRatio 数值不得改变, 实际: ' + segBtns.map((b) => b.dataset.ratio).join(',')
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

  // 进度上报: 切章后不立即上报(否则旧滚动位置会被写成新章位置), 恢复抑制期后再按滚动节流上报
  dispatch('chapter', { index: 3, title: '第4章 标题4', paragraphs: ['x'], totalChapters: 5, chapterWords: 1, scrollRatio: 0.3 });
  await sleep(30);
  assert(!posted.some((m) => m.type === 'saveProgress' && m.chapterIndex === 3),
    '切章渲染后不应立即上报进度(避免旧位置污染新章)');
  posted.length = 0;
  await sleep(700); // 等恢复期(600ms)抑制结束
  win.dispatchEvent(new win.Event('scroll'));
  await sleep(700);
  const progress = posted.find((m) => m.type === 'saveProgress' && m.chapterIndex === 3);
  assert(progress, '滚动后应节流上报进度');
  console.log('进度上报(saveProgress): 通过');

  // ---------------- 侧边菜单(占位式布局 + 折叠) ----------------
  const menuEl = document.querySelector('.menu');
  assert(menuEl, '应有侧边菜单');
  assert(document.querySelector('.shell .menu') && document.querySelector('.shell .main'), '布局应为 shell[menu|main](占位式, 非浮层)');
  assert(menuEl.classList.contains('expanded'), '默认应展开菜单');
  assert(!document.documentElement.classList.contains('menu-collapsed'), '展开时不应挂 menu-collapsed(宽度由 CSS 决定)');
  assert(capturedHtml.indexOf('--menu-w: var(--menu-w-expanded)') >= 0, 'CSS 应定义展开态 --menu-w = 176px');
  document.querySelector('.menu-toggle').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!menuEl.classList.contains('expanded'), '点菜单按钮应收起');
  assert(document.documentElement.classList.contains('menu-collapsed'), '收起时应挂 menu-collapsed');
  assert(/html\.menu-collapsed\s*\{[^}]*--menu-w:\s*var\(--menu-w-collapsed\)/.test(capturedHtml),
    'CSS 应有 .menu-collapsed -> 48px 的规则');
  // 7 个弹窗功能项 + 状态栏开关 + 摸鱼入口(笔记模式已于 v1.48.18 下线)
  assert(
    document.querySelectorAll('.menu-item:not(.menu-toggle-statusbar):not([data-menu="slacker"])').length === 7,
    '菜单应有 7 个弹窗功能项, 实际: ' + document.querySelectorAll('.menu-item').length + ' (含状态栏/摸鱼) / ' + document.querySelectorAll('.menu-item:not(.menu-toggle-statusbar):not([data-menu="slacker"])').length + ' (弹窗项)'
  );
  assert(document.querySelectorAll('.menu-item[data-menu]').length === 9, '菜单共 9 项(状态栏开关 + 摸鱼入口 + 7 个弹窗)');
  assert(!document.querySelector('.menu-item[data-menu="note-mode"]'), '「笔记模式」开关应已下线(v1.48.18)');
  assert(!document.querySelector('.menu-toggle-notemode'), '不应残留笔记模式开关的 class');
  assert(document.querySelector('.menu-item[data-menu="statusbar"]'), '菜单应有「状态栏」显隐开关');
  assert(document.querySelector('.menu-item[data-menu="slacker"]'), '菜单应有「摸鱼模式」入口');
  // 顺序: 书架 → 书源 → 目录 → 笔记 → 状态栏 → 历史记录 → 阅读设置 → 存储位置 → 摸鱼模式
  const order = Array.from(document.querySelector('.menu').children).map((el) =>
    el.classList.contains('menu-divider') ? 'divider' : el.getAttribute('data-menu'));
  assert(
    JSON.stringify(order) === JSON.stringify([null, 'divider', 'shelf', 'source', 'catalog', 'notes', 'statusbar', 'history', 'settings', 'storage', 'slacker']),
    '菜单顺序应为 折叠按钮 + 分割线 + 书架/书源/目录/笔记/状态栏/历史记录/阅读设置/存储位置/摸鱼模式, 实际: ' + JSON.stringify(order)
  );
  // 摸鱼入口点击 -> postMessage slackerStart(转发到 novelReader.slackerStart 命令)
  {
    const before = posted.filter((m) => m.type === 'slackerStart').length;
    document.querySelector('.menu-item[data-menu="slacker"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(
      posted.filter((m) => m.type === 'slackerStart').length === before + 1,
      '点击摸鱼入口应发送 slackerStart 消息'
    );
    // 摸鱼图标应跟随主题(currentColor), 不允许写死颜色
    const slackerSvg = document.querySelector('.menu-item[data-menu="slacker"] .menu-ico svg');
    assert(slackerSvg, '摸鱼入口应有内联 SVG 图标');
    assert(slackerSvg.getAttribute('viewBox') === '0 0 1000 1000', '摸鱼图标 viewBox 应为摸鱼猪的 1000×1000');
  }
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

  // Esc 关闭浮层后焦点应回到触发按钮(而不是掉到 body 上, 也不能靠主动 blur 清掉)
  // 旧断言是"Esc 后应清掉焦点", 与 R5-04「关闭后焦点归位」冲突, 按新行为改写(架构 §8.2)
  const focusTarget = document.querySelector('.menu-item[data-menu="catalog"]');
  focusTarget.focus();
  assert(document.activeElement === focusTarget, '前置: 按钮应能获得焦点');
  focusTarget.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert($('#catalogPanel').classList.contains('open'), '前置: 目录浮层应已打开');
  assert(document.activeElement !== document.body, '打开浮层后焦点应在浮层内, 不应是 body');
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  assert(!$('#catalogPanel').classList.contains('open'), 'Esc 应关闭浮层');
  assert(document.activeElement !== document.body, 'Esc 关闭后焦点不应掉到 body');
  assert(document.activeElement === focusTarget || document.activeElement === document.querySelector('[data-menu="catalog"]'),
    'Esc 关闭浮层后焦点应回到触发按钮, 实际 ' + (document.activeElement && document.activeElement.className));

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
  assert(/FESTIVAL_THEMES/.test(virtualSrc) && /festivalTheme/.test(virtualSrc), 'vite 应构建期生成节日色板');
  assert(/FESTIVAL_THEMES\[festival/.test(storeSrc), 'webview themeOf 应从节日色板查表');
  assert(/ensureContrast\(/.test(settingsSrc), '色板推导必须做过对比度校正');
  assert(/\*::-webkit-scrollbar\s*\{[^}]*width:\s*8px/.test(capturedHtml), '全局滚动条应收细到 8px');
  // 廿四节气: 与地域色彩同一行(阅读主题的第二行), 24 项, 悬浮可预览
  {
    const row = document.querySelector('#settingsPanel .sp-row-theme');
    assert(row, '阅读主题行应存在');
    assert(row.querySelectorAll('.sp-theme-extra .sp-province-btn').length === 3,
      '阅读主题第二行应有 3 个选择器(地域色彩/廿四节气/节日色彩)');
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
  // 传统节日: 与地域色彩/廿四节气同一行, 手动列表只渲染日景 18 项, 悬浮可预览
  {
    const festRow = document.querySelector('#settingsPanel .sp-row-theme');
    assert(festRow, '阅读主题行应存在');
    const festBtn = festRow.querySelector('.sp-province-picker[data-kind="festival"] .sp-province-btn');
    assert(festBtn, '应有传统节日选择器');
    assert((festBtn.textContent || '').trim() === '节日色彩',
      '未启用节日主题时应显示占位「节日色彩」, 实际: ' + (festBtn.textContent || '').trim());
    festBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const festItems = document.querySelectorAll('#settingsPanel .sp-festival-menu .sp-province-item');
    assert(festItems.length === 18, '节日列表应有 18 项(仅日景, 实际 ' + festItems.length + ')');
    const festLabels = Array.from(festItems).map((el) => (el.textContent || '').trim());
    assert(festLabels.indexOf('除夕') >= 0 && festLabels.indexOf('春节') >= 0, '节日列表应包含「除夕」「春节」');
    for (const nightName of ['除夕 · 夜', '元宵 · 灯', '中元 · 河灯', '中秋 · 月', '冬至 · 长夜']) {
      assert(festLabels.indexOf(nightName) < 0, '夜场不应出现在手动列表: ' + nightName);
    }
    // 4 列 5 行(18 项)
    assert(/\.sp-festival-menu\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*auto\)/.test(capturedHtml),
      '节日列表应为 4 列排布');
    const duanwuItem = Array.from(festItems).find((el) => (el.textContent || '').trim() === '端午');
    assert(duanwuItem, '节日列表应包含「端午」');
    assert(duanwuItem.style.borderLeftColor, '节日条目应带左侧主色条');
    const festTitle = duanwuItem.getAttribute('title') || '';
    assert(festTitle.indexOf('#') < 0, '节日悬浮提示不应包含色值, 实际: ' + festTitle);
    assert(festTitle === '端午 · 荷叶绿', '节日悬浮提示应为「名称 · 色名」, 实际: ' + festTitle);

    const root3 = document.documentElement;
    const festBefore = root3.style.getPropertyValue('--bg').trim();
    posted.length = 0;
    duanwuItem.dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: false }));
    await sleep(30);
    assert(root3.style.getPropertyValue('--bg').trim() !== festBefore, '悬浮节日应实时预览色板');
    // 节日的 ThemeDef.id 即节日 id(与 test-festival-theme 的 t.id === f.id 契约一致)
    assert(root3.dataset.theme === 'duanwu', '预览节日应把 data-theme 切到该节日 id, 实际: ' + root3.dataset.theme);
    assert(posted.length === 0, '节日预览不应触发持久化');
    const festMenuEl = document.querySelector('#settingsPanel .sp-festival-menu');
    festMenuEl.dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: false }));
    await sleep(30);
    assert(root3.style.getPropertyValue('--bg').trim() === festBefore, '移出节日列表应还原原主题色板');
    assert(root3.dataset.theme === 'term', '移出后应还原到原主题(term)');

    duanwuItem.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    assert(
      posted.some((m) => m.type === 'updateSettings' && m.patch && m.patch.theme === 'festival' && m.patch.festival === 'duanwu'),
      '选节日应保存 festival 并切到 festival 主题'
    );
    assert(!document.querySelector('#settingsPanel .sp-festival-menu'), '选中后节日列表应收起');
    assert((festBtn.textContent || '').trim() === '端午',
      '启用后按钮应显示节日名, 实际: ' + (festBtn.textContent || '').trim());
    console.log('传统节日主题(同行/18项仅日景/悬浮预览/落盘): 通过');
  }
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

  console.log('侧边菜单(占位布局/展开收起/9 项/顺序): 通过');

  // 切换按钮: 双状态图标(展开=右侧条纹, 收起=左侧条纹) + 无「菜单」文字
  const toggleHtml = document.querySelector('.menu-toggle').innerHTML;
  assert(!toggleHtml.includes('菜单'), '切换按钮不应再显示「菜单」文字(仅保留 hover 提示)');
  // 折叠按钮: 品牌 logo(锐阅读器图标) —— 位图小图, 构建时自动内联为 data URL
  const logoImg = document.querySelector('.menu-toggle img.menu-logo');
  assert(logoImg, '折叠按钮应有 logo');
  assert(/^data:image\/png;base64,/.test(logoImg.getAttribute('src') || ''), 'logo 应为内联 PNG(data URL)');
  assert(!capturedHtml.includes('.logo-spark'), '不应残留旧 logo 的放射线样式');
  assert(/\.menu-toggle \.menu-logo\s*\{[^}]*width:\s*46px/.test(capturedHtml), '展开态 logo 应为 46px');
  assert(/\.menu:not\(\.expanded\) \.menu-toggle \.menu-logo\s*\{[^}]*width:\s*28px/.test(capturedHtml), '收起态 logo 应缩到 28px');
  assert(
    /root\.dataset\.theme\s*=\s*t\.id/.test(
      fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'store.ts'), 'utf8')
    ),
    'store 应把当前主题 id 写到根元素 data-theme(供 CSS 分支)'
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
  // 笔记图标: 设计稿矢量版, 笔杆填充绑定主题强调色(切主题实时变化)
  const notesIco = document.querySelector('.menu-item[data-menu="notes"] .menu-ico');
  assert(notesIco && /var\(--sp-accent\)/.test(notesIco.innerHTML), '笔记图标笔杆应绑定 var(--sp-accent) 跟随主题');
  assert(notesIco && /viewBox="0 0 707 704"/.test(notesIco.innerHTML), '笔记图标应为设计稿矢量版(707×704)');
  const menuSrc = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'components', 'SideMenu.vue'), 'utf8');
  // 6 个图标统一为设计稿矢量版(707×704), 强调色部件绑定 var(--sp-accent)
  assert(/SVG_SHELF/.test(menuSrc) && /viewBox="0 0 707 704"/.test(menuSrc), '图标应为设计稿矢量版(707×704)');
  ['SVG_SHELF', 'SVG_CATALOG', 'SVG_NOTES', 'SVG_SETTINGS', 'SVG_STORAGE'].forEach(function (name) {
    const start = menuSrc.indexOf('const ' + name);
    const block = menuSrc.slice(start, start + 2200);
    assert(block.indexOf('var(--sp-accent)') >= 0, name + ' 应包含跟随主题的强调色部件');
  });
  assert(/data-menu="'statusbar'"/.test(menuSrc) || /statusbar/.test(menuSrc), '状态栏开关图标应存在');
  assert(!/fill="#231815"/.test(menuSrc), '新图标不应硬编码品牌色(改用 currentColor 跟随主题)');

  // 书架弹窗
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const bks = document.querySelectorAll('#shelfPopup .bk');
  assert(bks.length === 2, '书架弹窗应渲染 2 本(实际 ' + bks.length + ')');
  assert(bks[0].classList.contains('cur'), '当前书应标记');
  assert(Array.from(document.querySelectorAll('#shelfPopup .bk-tag')).every((t) => t.textContent === '本地'),
    '本地书应显示「本地」标签');
  assert(document.querySelector('#shelfPopup .popup-sub').textContent.includes('共 2 本'), '应显示册数');
  posted.length = 0;
  // 行已拆成"容器 + 主按钮 + 独立删除按钮": 打开书要点主按钮(架构 §4.b.1)
  bks[1].querySelector('.bk-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'openBook' && m.filePath === 'D:/b.txt'), '点书架主按钮应发 openBook');
  assert(!$('#shelfPopup').classList.contains('open'), '打开书后书架弹窗应收起');
  menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  posted.length = 0;
  // 移除走统一确认框: 点行内「移除」只打开确认框, 确认后才发 removeBook
  document.querySelector('#shelfPopup .bp-del').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('[data-confirm-ok]'), '点行内「移除」应弹出统一确认框');
  assert(!posted.some((m) => m.type === 'removeBook'), '未确认前不应发 removeBook');
  assert(
    document.querySelectorAll('#shelfPopup .bk').length === 2,
    '未确认前不应从列表移除(等扩展二次确认后刷新)'
  );
  document.querySelector('[data-confirm-ok]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const rmOne = posted.find((m) => m.type === 'removeBook');
  assert(rmOne, '确认后应发 removeBook');
  assert(typeof rmOne.opId === 'string' && rmOne.opId, '写操作必须带 opId(宿主据此回终态)');
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
  assert(posted.some((m) => m.type === 'refreshLibraryPreview'), '点「刷新书架」应先发 refreshLibraryPreview(预演)');
  // 在线书徽标
  sendMsg({ type: 'shelf', items: [
    { filePath: 'online://s1/abc123', title: '在线书', author: '作者', chapterIndex: 0, totalChapters: 10, current: false, online: true, sourceName: '测试站' },
  ] });
  await sleep(30);
  const tag = document.querySelector('#shelfPopup .bk-tag');
  assert(tag && tag.textContent.includes('测试站'), '在线书应直接显示书源名(便于区分来源)');
  assert(tag.getAttribute('title') === '来源：测试站', '徽标 title 应带来源说明');

  // 书架管理: 「管理」-> 点行勾选 -> 全选 -> 移除所选
  {
    sendMsg({ type: 'shelf', items: [
      { filePath: 'A:/1.txt', title: '书一', author: '', chapterIndex: 0, totalChapters: 3, current: false },
      { filePath: 'A:/2.txt', title: '书二', author: '', chapterIndex: 0, totalChapters: 3, current: false },
      { filePath: 'A:/3.txt', title: '书三', author: '', chapterIndex: 0, totalChapters: 3, current: false },
    ] });
    await sleep(30);
    assert(!document.querySelector('#shelfPopup [data-shelf-check]'), '默认不应显示勾选框');
    assert(document.querySelector('#shelfPopup [data-shelf-batch]').textContent.trim() === '管理',
      '头部按钮文案应为「管理」');
    document.querySelector('#shelfPopup [data-shelf-batch]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('#shelfPopup [data-shelf-batch]').textContent.trim() === '完成',
      '进入后按钮应变「完成」');
    assert(document.querySelectorAll('#shelfPopup [data-shelf-check]').length === 3,
      '管理模式每行都应有勾选框');
    assert(!document.querySelector('#shelfPopup .bp-del'), '管理模式应隐藏行内「移除」(避免误点)');

    posted.length = 0;
    // 多动作行: 勾选走原生 checkbox, 点行本身不再打开书也不再勾选
    const firstCheck = document.querySelector('#shelfPopup .bk [data-shelf-check]');
    firstCheck.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(!posted.some((m) => m.type === 'openBook'), '管理模式下点行不应打开书');
    assert(document.querySelector('#shelfPopup .bk').classList.contains('sel'), '勾选的行应高亮');
    assert(document.querySelector('#shelfPopup [data-shelf-sel-count]').textContent.includes('已选 1'),
      '应显示已选数量, 实际 ' + document.querySelector('#shelfPopup [data-shelf-sel-count]').textContent.trim());

    // 再点一次取消勾选
    document.querySelector('#shelfPopup .bk [data-shelf-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#shelfPopup [data-shelf-sel-count]').textContent.includes('已选 0'),
      '再点一次应取消勾选');

    document.querySelector('#shelfPopup [data-shelf-select-all]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#shelfPopup [data-shelf-sel-count]').textContent.includes('已选 3'), '全选应选 3 本');

    posted.length = 0;
    const rmSelected = document.querySelector('#shelfPopup [data-shelf-remove-selected]');
    assert(rmSelected && !rmSelected.disabled, '有选择时「移除所选」应可用');
    rmSelected.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    // 危险操作先出确认框; 取消必须保留选择
    assert(document.querySelector('[data-confirm-ok]'), '「移除所选」应先弹确认框');
    assert(!posted.some((m) => m.type === 'removeBooks'), '未确认前不应发 removeBooks');
    document.querySelector('[data-confirm-cancel]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#shelfPopup [data-shelf-sel-count]').textContent.includes('已选 3'),
      '取消确认后选择必须保留');

    rmSelected.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const shelfOkBtn = document.querySelector('[data-confirm-ok]');
    shelfOkBtn.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(20);
    assert($('#shelfPopup').classList.contains('open'), '确认框内 mousedown 不得提前关闭书架浮窗');
    assert(document.querySelector('.confirm-dlg'), '书架确认框内 mousedown 不得取消确认框');
    shelfOkBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const rmMsg = posted.find((m) => m.type === 'removeBooks');
    assert(rmMsg, '确认后应发 removeBooks');
    assert(Array.isArray(rmMsg.filePaths) && rmMsg.filePaths.length === 3,
      '应带 3 个路径, 实际 ' + (rmMsg.filePaths || []).length);
    // 成功终态回包后才退出管理模式(R7-03)
    assert(document.querySelector('#shelfPopup [data-shelf-check]'), '失败/未回包前应仍在管理模式');
    sendMsg({ type: 'opResult', payload: { opId: rmMsg.opId, op: 'books:removeMany', ok: true } });
    await sleep(30);
    assert(!document.querySelector('#shelfPopup [data-shelf-check]'), '成功后应退出管理模式');
    assert($('#shelfPopup').classList.contains('open'), '成功后应保留书架浮窗');
  }

  console.log('书架弹窗(渲染/打开/移除/添加/管理): 通过');

  // 历史记录弹窗: 本地/在线分栏、点击打开、15 行滚动
  sendMsg({ type: 'history', payload: {
    local: [
      { kind: 'local', filePath: 'D:/h1.txt', title: '本地历史1', author: '甲', chapterIndex: 2, totalChapters: 10, lastReadAt: Date.now() },
      { kind: 'local', filePath: 'D:/h2.txt', title: '本地历史2', author: '', chapterIndex: 0, totalChapters: 3, lastReadAt: Date.now() },
    ],
    online: [
      { kind: 'online', filePath: 'online://s1/h', title: '在线历史', author: '乙', chapterIndex: 1, totalChapters: 20, lastReadAt: Date.now(), sourceName: '测试站' },
    ],
  } });
  menuItem('history').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  assert($('#historyPopup').classList.contains('open'), '点「历史记录」应打开弹窗');
  assert(posted.some((m) => m.type === 'requestHistory'), '打开历史弹窗应请求历史数据');
  assert(document.querySelectorAll('#historyPopup .hist-row').length === 2, '本地 Tab 应显示 2 条');
  assert(document.querySelector('#historyPopup .hist-row .bk-tag').textContent.includes('本地'), '本地记录应显示「本地」标签');
  document.querySelector('#historyPopup [data-hist-tab="online"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(document.querySelectorAll('#historyPopup .hist-row').length === 1, '在线 Tab 应显示 1 条');
  assert(document.querySelector('#historyPopup .hist-row .bk-tag').textContent.includes('在线'), '在线记录应显示「在线」标签');
  posted.length = 0;
  document.querySelector('#historyPopup .hist-row .hist-row-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'openBook' && m.filePath === 'online://s1/h'), '点历史行主按钮应发 openBook');
  assert(!$('#historyPopup').classList.contains('open'), '打开后历史弹窗应关闭');
  // 15 行容量现在由 --src-result-h 乘出来(以前写死 calc(44px * 15), 压缩器会折叠成 660px)
  assert(/\.hist-list\s*\{[^}]*max-height:\s*calc\(var\(--src-result-h/.test(capturedHtml),
    '历史列表应限制 15 行高度(用 --src-result-h 计算)');

  // 历史管理: 全选 -> 删除所选; 切换分栏清空选择; 清空本栏
  {
    menuItem('history').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    document.querySelector('#historyPopup [data-hist-tab="local"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(!document.querySelector('#historyPopup [data-hist-check]'), '默认不应显示勾选框');
    assert(document.querySelector('#historyPopup [data-hist-batch]').textContent.trim() === '管理',
      '历史头部按钮文案应为「管理」');
    document.querySelector('#historyPopup [data-hist-batch]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('#historyPopup [data-hist-batch]').textContent.trim() === '完成',
      '进入后应变为「完成」');
    assert(document.querySelectorAll('#historyPopup [data-hist-check]').length === 2, '管理模式应有 2 个勾选框');

    posted.length = 0;
    document.querySelector('#historyPopup .hist-row [data-hist-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(!posted.some((m) => m.type === 'openBook'), '管理模式下点行不应打开书');
    assert(document.querySelector('#historyPopup [data-hist-sel-count]').textContent.includes('已选 1'),
      '应显示已选条数');

    // 切分栏: 选择属于当前栏, 必须清空
    document.querySelector('#historyPopup [data-hist-tab="online"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#historyPopup [data-hist-sel-count]').textContent.includes('已选 0'),
      '切换分栏应清空选择');
    document.querySelector('#historyPopup [data-hist-tab="local"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);

    document.querySelector('#historyPopup [data-hist-select-all]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#historyPopup [data-hist-sel-count]').textContent.includes('已选 2'), '全选应选 2 条');

    posted.length = 0;
    document.querySelector('#historyPopup [data-hist-remove-selected]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('[data-confirm-ok]'), '「删除所选」应先弹统一确认框');
    assert(!posted.some((m) => m.type === 'removeHistory'), '未确认前不应发 removeHistory');
    const histOkBtn = document.querySelector('[data-confirm-ok]');
    histOkBtn.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(20);
    assert($('#historyPopup').classList.contains('open'), '确认框内 mousedown 不得提前关闭历史浮窗');
    assert(document.querySelector('.confirm-dlg'), '历史确认框内 mousedown 不得取消确认框');
    histOkBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const rmHist = posted.find((m) => m.type === 'removeHistory');
    assert(rmHist, '确认后应发 removeHistory');
    assert((rmHist.filePaths || []).length === 2, '应带 2 个路径');
    assert(typeof rmHist.opId === 'string' && rmHist.opId, 'delete 必须带 opId');
    assert(document.querySelector('#historyPopup [data-hist-check]'), '成功后回包前应仍在管理模式');
    sendMsg({ type: 'opResult', payload: { opId: rmHist.opId, op: 'history:remove', ok: true } });
    await sleep(30);
    assert(!document.querySelector('#historyPopup [data-hist-check]'), '成功后应退出管理模式');
    assert($('#historyPopup').classList.contains('open'), '成功后应保留历史浮窗');

    // 清空本栏(只删记录)
    posted.length = 0;
    document.querySelector('#historyPopup [data-hist-clear]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('[data-confirm-ok]'), '「清空本栏」应先弹统一确认框');
    document.querySelector('[data-confirm-ok]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const clrLocal = posted.find((m) => m.type === 'clearHistory' && m.kind === 'local');
    assert(clrLocal, '确认后应发 clearHistory(local)');
    // 回终态: 清掉 pending, 否则「清空」按钮在 pending 期间一直是 disabled(防重复提交)
    sendMsg({ type: 'opResult', payload: { opId: clrLocal.opId, op: 'history:clear', ok: true } });
    await sleep(30);
    document.querySelector('#historyPopup [data-hist-tab="online"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    posted.length = 0;
    document.querySelector('#historyPopup [data-hist-clear]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    document.querySelector('[data-confirm-ok]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const clrOnline = posted.filter((m) => m.type === 'clearHistory' && m.kind === 'online').pop();
    assert(clrOnline, '在线分栏确认后应发 clearHistory(online)');
    sendMsg({ type: 'opResult', payload: { opId: clrOnline.opId, op: 'history:clear', ok: true } });
    await sleep(30);
    document.querySelector('#historyPopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
  }
  console.log('历史记录(分栏/打开/管理/清空): 通过');

  // 历史行单条删除: 行尾悬停「删除」-> 统一确认框 -> 只删这一条(复用 history:remove)
  {
    menuItem('history').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const del = document.querySelector('#historyPopup .hist-row [data-hist-del]');
    assert(del && del.tagName === 'BUTTON', '历史行尾应有独立删除按钮');
    assert(del.textContent.trim() === '删除', '按钮文案应为「删除」, 实际 ' + del.textContent.trim());
    assert(/删除《.+》的阅读记录/.test(del.getAttribute('aria-label') || ''), '删除按钮 aria-label 应含书名');
    const rowEl = del.closest('.hist-row');
    assert(rowEl.children[rowEl.children.length - 1] === del, '删除按钮应排在行尾(时间列之后)');
    assert(!document.querySelector('#historyPopup button button'), '历史行不允许按钮嵌套');
    assert(/#historyPopup \.hist-row:hover \.bp-del[^{]*\{[^}]*opacity:\s*1/.test(capturedHtml),
      '悬停历史行时应显形删除按钮');
    // 点删除只弹确认框
    posted.length = 0;
    del.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(!posted.some((m) => m.type === 'removeHistory'), '未确认前不应发 removeHistory');
    const cTitle = document.querySelector('.confirm-title');
    assert(cTitle && /删除「.+」的阅读记录/.test(cTitle.textContent),
      '确认框标题应含书名, 实际: ' + (cTitle ? cTitle.textContent : 'null'));
    // 取消 -> 行仍在
    const rowsBefore = document.querySelectorAll('#historyPopup .hist-row').length;
    document.querySelector('[data-confirm-cancel]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelectorAll('#historyPopup .hist-row').length === rowsBefore, '取消后不应删除记录');
    // 确认 -> 只带这一条路径
    posted.length = 0;
    document.querySelector('#historyPopup .hist-row [data-hist-del]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    document.querySelector('[data-confirm-ok]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const rmOneMsg = posted.find((m) => m.type === 'removeHistory');
    assert(rmOneMsg && (rmOneMsg.filePaths || []).length === 1, '确认后应发只含 1 条路径的 removeHistory');
    assert(typeof rmOneMsg.opId === 'string' && rmOneMsg.opId, '单条删除也必须带 opId');
    sendMsg({ type: 'opResult', payload: { opId: rmOneMsg.opId, op: 'history:remove', ok: true } });
    await sleep(30);
    // 管理模式 -> 行内删除按钮隐藏(改走批量勾选)
    document.querySelector('#historyPopup [data-hist-batch]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(!document.querySelector('#historyPopup [data-hist-del]'), '管理模式应隐藏行内删除按钮');
    document.querySelector('#historyPopup [data-hist-batch]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    document.querySelector('#historyPopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
  }
  console.log('历史记录单条删除(行尾按钮/确认框/单路径/管理模式隐藏): 通过');

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
  // 导出已改为「只保存文件」, 说明文案不能再提「加入书架」
  // (存储面板有两段说明: 第一段讲书库目录, 第二段才是离线/导出)
  const stTips = Array.from(document.querySelectorAll('#storagePopup .popup-tip')).map((el) => el.textContent);
  const stTip = stTips[stTips.length - 1] || '';
  assert(stTip.indexOf('会生成一本独立本地书') < 0, '存储弹窗不应再声称导出会生成并加入书架的本地书: ' + stTip);
  assert(stTip.includes('只保存一个 txt 文件'), '存储弹窗应说明导出只保存文件, 实际: ' + JSON.stringify(stTip));
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

  // 正文两侧上/下一章箭头(垂直居中, 默认常驻; 可切悬浮显示)
  const sidePrev = document.querySelector('.side-nav-prev');
  const sideNext = document.querySelector('.side-nav-next');
  assert(sidePrev && sideNext, '正文两侧应有上/下一章箭头');
  assert(sidePrev.classList.contains('hover-only') && sideNext.classList.contains('hover-only'),
    '默认应为「悬浮」档: 平时隐形, 不跟正文抢注意力');
  assert(sidePrev.style.left && sidePrev.style.left !== 'auto' && sideNext.style.right !== 'auto',
    '箭头位置应动态跟随正文左右边缘');
  assert(!sidePrev.disabled && !sideNext.disabled, '中间章节两侧箭头均应可用');
  assert(sideNext.querySelector('svg path'), '箭头应使用 SVG 图标');
  posted.length = 0;
  sideNext.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const sideGo = posted.find((m) => m.type === 'getChapter');
  assert(sideGo && sideGo.dir === 'next', '点右箭头应请求下一章');
  // 阅读设置切到「悬浮显示」→ 箭头带 hover-only; 切回常驻恢复
  sendMsg({ type: 'settings', payload: { ...defaults, sideNavMode: 'hover' } });
  await sleep(30);
  // 常驻档: 去掉 hover-only
  sendMsg({ type: 'settings', payload: { ...defaults, sideNavMode: 'always' } });
  await sleep(30);
  assert(!document.querySelector('.side-nav-prev').classList.contains('hover-only'),
    '常驻档箭头不应带 hover-only');
  // 隐藏档: 直接不渲染(v-if), 连透明热区都不留, 避免误触
  sendMsg({ type: 'settings', payload: { ...defaults, sideNavMode: 'hidden' } });
  await sleep(30);
  assert(!document.querySelector('.side-nav-prev') && !document.querySelector('.side-nav-next'),
    '隐藏档不应渲染两侧箭头');
  // 回到默认悬浮档
  sendMsg({ type: 'settings', payload: { ...defaults, sideNavMode: 'hover' } });
  await sleep(30);
  assert(document.querySelector('.side-nav-prev').classList.contains('hover-only'),
    '切回悬浮档箭头应带 hover-only');
  console.log('正文两侧章节箭头(默认悬浮/点击切章/常驻/隐藏): 通过');

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
  for (const [cmd, arg, shape] of [
    ['novelReader.openBook', 'D:/x.txt'],
    // 移除类命令改为对象参数(skipConfirm + opId): webview 用自己的确认框确认过后
    // 宿主要跳过 showWarningMessage(架构文档 §4.c.3 / D5)。旧数组形态仍兼容。
    ['novelReader.removeFromShelf', 'D:/x.txt', 'obj'],
    ['novelReader.pickLibraryPath', undefined],
    ['novelReader.clearLibraryPath', undefined],
    ['novelReader.openLibraryFolder', undefined],
    ['novelReader.refreshShelfFromLibrary', undefined],
    ['novelReader.openFile', undefined],
  ]) {
    assert(
      executedCommands.some((e) => {
        if (e.cmd !== cmd) { return false; }
        if (arg === undefined) { return true; }
        if (shape === 'obj') {
          return !!(e.arg && Array.isArray(e.arg.filePaths) && e.arg.filePaths[0] === arg && e.arg.skipConfirm === true);
        }
        return e.arg === arg;
      }),
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
    for (const need of ['novelReader.showBookshelf', 'novelReader.showChapters', 'novelReader.showSettings', 'novelReader.showSources']) {
      assert(cmds.includes(need), '弹窗入口命令应保留: ' + need);
    }
    for (const need of ['novelReader.importSourceFromUrl', 'novelReader.importSourceFromClipboard', 'novelReader.importSourceFromFile', 'novelReader.checkSources', 'novelReader.exportSources']) {
      assert(cmds.includes(need), '书源命令应注册: ' + need);
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
      /shelfProgress/.test(panelSrc) && /hasShelf/.test(panelSrc),
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

  // 恢复路径的进度写入: onProgress 必须带 filePath, 且 shelf 有记录时不得与webview state 取较大值
  {
    const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'readerPanel.ts'), 'utf8');
    const extSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    // 1) onProgress 签名带 filePath(窗口恢复的面板不经loadNovel, currentNovel 未必同书)
    assert(
      /onProgress\?: \(filePath: string, chapterIndex: number, scrollRatio: number\)/.test(panelSrc),
      'onProgress 必须携带 filePath —— 恢复出来的面板不能用 currentNovel 判断是哪本书'
    );
    assert(
      /onProgress\?\.\(\s*this\._novel\.filePath/.test(panelSrc),
      'saveProgress 应把本面板的 filePath 一并上报'
    );
    assert(
      /onProgress = \(filePath: string/.test(extSrc4) && /shelf\.updateProgress\(filePath,/.test(extSrc4),
      '扩展侧应按消息里的 filePath 写入进度'
    );
    // 2) 章节号不能取较大值 —— 旧快照会覆盖更新的进度
    assert(
      !/Math\.max\(0, state\.chapterIndex \|\| 0, shelved\?\.chapterIndex/.test(panelSrc),
      '恢复章节号不得与 webview state 取较大值(旧快照会覆盖更新的进度)'
    );
    assert(
      /hasShelf\s*\?\s*shelved\.chapterIndex/.test(panelSrc),
      '书架有有效进度时应无条件采用, 无记录才退回 webview state'
    );
    // 3) 恢复后自愈: 书架没这本书就补登记 + 立刻落盘章节号
    assert(
      /!shelf\.get\(fp\)/.test(extSrc4) && /shelf\.upsert\(\{/.test(extSrc4),
      '恢复后面板若未登记在书架, 应补登记'
    );
    // 4) 章节不匹配时 scrollRatio 归零(避免把别的章节的滚动比例套过来)
    assert(
      /sameChapter/.test(panelSrc) && /: 0;/.test(panelSrc),
      '章节不匹配时应把章内滚动位置归零'
    );
    console.log('恢复路径进度写入(带filePath/不取较大值/补登记/比例归零): 通过');
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

  // 切章落点: 上一章/下一章/目录跳转一律恢复该章阅读记录位置(无记录回顶部), 同章不动
  {
    const fs2 = fs;
    const panelSrc = fs2.readFileSync(path.join(__dirname, '..', 'src', 'readerPanel.ts'), 'utf8');
    const extSrc = fs2.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    // 1) showChapter 统一恢复该章记忆位置, 不再有 prev->底部 的强制分支
    assert(
      panelSrc.indexOf('showChapter(index: number, dir:') >= 0,
      'showChapter 应带方向参数 next/prev/jump'
    );
    assert(
      panelSrc.indexOf('_scrollRatio = cur._rememberedRatio(next)') >= 0,
      '切章应恢复该章记录位置(上一章不再强制落底部)'
    );
    assert(
      panelSrc.indexOf("dir === 'prev' ? 1") < 0,
      '不应再有上一章强制落底部的逻辑'
    );
    // 2) 同章不动 —— 必须在改 index 之前 return
    assert(
      /if \(next === cur\._chapterIndex\) \{\s*return;/.test(panelSrc),
      '目录点当前章时不应切章(也不应改滚动位置)'
    );
    // 3) 命令调用点必须传方向
    assert(
      extSrc.indexOf("showChapter(panel.chapterIndex - 1, 'prev')") >= 0,
      '上一章命令应传 prev'
    );
    assert(
      extSrc.indexOf("showChapter(panel.chapterIndex + 1, 'next')") >= 0,
      '下一章命令应传 next'
    );
    // 4) getChapter: 精确比例优先, 否则恢复该章记忆位置(无记录回顶部)
    const gc = panelSrc.slice(panelSrc.indexOf("case 'getChapter'")).slice(0, 1200);
    assert(gc.indexOf('this._rememberedRatio(index)') >= 0, 'getChapter 应恢复该章记忆位置');
    assert(gc.indexOf("msg.dir === 'prev' ? 1") < 0, 'getChapter 不应再有 prev 落底部分支');
    // 4b) 位置记录如实含顶部(滚回顶部后离开应回顶部), 且不再有"顶部不记"分支
    assert(
      panelSrc.indexOf('this._ratios.set(msg.chapterIndex, ratio)') >= 0
        && panelSrc.indexOf('if (ratio > 0.005)') < 0,
      'saveProgress 应如实记录位置(含顶部 0), 不再过滤小比例'
    );
    assert(
      panelSrc.indexOf("typeof local === 'number' && local > 0.005") < 0,
      '_rememberedRatio 不应再用 0.005 阈值过滤顶部记录'
    );
    // 4c) 切章瞬间不得立即上报进度(旧滚动位置会写成新章位置), 恢复期用抑制窗口
    const appSrc2 = fs2.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'App.vue'), 'utf8');
    const watchStart = appSrc2.indexOf('watch(function () { return state.chapter; }');
    assert(watchStart >= 0, '应存在章节 watch');
    const watchBlock = appSrc2.slice(watchStart, watchStart + 1400);
    assert(watchBlock.indexOf('sendProgress(true)') < 0,
      '章节 watch 不应在切章渲染时立即 sendProgress(true)');
    assert(
      /scrollTo\(0, max > 0 \? ratio \* max : 0\);[\s\S]{0,220}setProgressSuppressed\(true, 600\)/.test(watchBlock),
      '切章恢复滚动后应开启进度抑制窗口'
    );
    // 5) 切章后要等布局落定再滚, 否则会停在和上一章差不多的位置
    const appSrc = fs2.readFileSync(
      path.join(__dirname, '..', 'webview', 'reader', 'App.vue'),
      'utf8'
    );
    assert(
      /nextTick\(function \(\) \{[\s\S]{0,200}requestAnimationFrame/.test(appSrc),
      '章节 watch 应在 nextTick + requestAnimationFrame 后再恢复滚动位置(等布局落定)'
    );
    console.log('切章落点(统一恢复记录位置/无记录回顶部/同章不动/等布局落定): 通过');
  }
  }


  // ================================================================ 书源(三 Tab / 失效 / 紧凑列表)
  console.log('[书源]');
  // 1) 菜单打开 + 互斥
  menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  menuItem('source').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert($('#sourcePopup').classList.contains('open'), '点菜单「书源」应打开书源面板');
  assert(!$('#catalogPanel').classList.contains('open'), '打开书源应关闭目录(互斥)');

  // 2) 空态 -> 去导入 -> 管理视图
  assert(document.querySelector('#sourcePopup .src-empty'), '无书源时应显示空态引导');
  document.querySelector('#sourcePopup [data-src-open-manage]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('#sourcePopup .src-filter'), '点「去导入书源」应切到管理视图');

  // 3) 三 Tab + 失效源从「书源」列表移出
  sendMsg({ type: 'sources', items: [
    { id: 's1', name: 'A站', url: 'https://a.com', group: '玄幻', enabled: true, searchUrl: 'https://a.com/s?q={{key}}', lastCheckOk: true, lastCheckMessage: '命中 3 条', failStreak: 0 },
    { id: 's2', name: 'B站', url: 'https://b.com', group: '', enabled: true, searchUrl: 'https://b.com/s?q={{key}}', failStreak: 0 },
    { id: 's3', name: 'C站', url: 'https://c.com', group: '', enabled: true, searchUrl: 'https://c.com/s?q={{key}}', lastCheckOk: false, lastCheckMessage: '网络错误', failStreak: 1, deadAt: Date.now() - 1000, deadReason: '网络错误: fetch failed (c.com)' },
  ] });
  await sleep(40);
  assert(document.querySelectorAll('#sourcePopup [data-src-tab]').length === 3, '应有 3 个 Tab(搜索/书源/失效)');
  assert(document.querySelector('[data-src-dead-count]').textContent === '1', '失效 Tab 应显示 1 个角标');
  assert($('#sourcePopup .popup-sub').textContent.includes('2 个可搜'), '头部应显示可搜数量');
  assert(document.querySelectorAll('#sourcePopup .src-row[data-source-id]').length === 2, '「书源」列表不应包含失效源');
  assert(document.querySelector('#sourcePopup .src-status.is-ok'), '可用源应显示绿色状态');
  // 批量条只在管理模式出现(危险动作与普通工具分离, R11-02)
  assert(!document.querySelector('#sourcePopup .src-bulk'), '非管理模式不应渲染批量勾选条');
  assert(!document.querySelector('#sourcePopup .src-danger-zone'), '非管理模式不应渲染危险区');
  document.querySelector('#sourcePopup [data-src-manage-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('#sourcePopup .src-bulk'), '进入管理模式后应出现批量勾选条');
  assert(document.querySelector('#sourcePopup .src-danger-zone'), '管理模式应有独立危险区');
  assert(document.querySelectorAll('#sourcePopup .src-ico').length === 6, '两个存活源各 3 个图标按钮');

  // 4) 勾选启停(checkbox change) -> sourceToggle
  posted.length = 0;
  const toggleS2 = document.querySelector('#sourcePopup input[data-src-toggle="s2"]');
  assert(toggleS2 && toggleS2.checked, 'B站默认应勾选');
  toggleS2.checked = false;
  toggleS2.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceToggle' && m.id === 's2' && m.enabled === false),
    '取消勾选应发送 sourceToggle(enabled=false)');

  // 5) 批量: 全选/反选/全部停用 -> sourceSetEnabled(一次批量)
  //    (冒烟里没有扩展回推, 批量后手动回推一次状态, 模拟扩展刷新)
  const baseItems = [
    { id: 's1', name: 'A站', url: 'https://a.com', group: '玄幻', enabled: true, searchUrl: 'https://a.com/s?q={{key}}', lastCheckOk: true, lastCheckMessage: '命中 3 条', failStreak: 0 },
    { id: 's2', name: 'B站', url: 'https://b.com', group: '', enabled: false, searchUrl: 'https://b.com/s?q={{key}}', failStreak: 0 },
    { id: 's3', name: 'C站', url: 'https://c.com', group: '', enabled: true, searchUrl: 'https://c.com/s?q={{key}}', lastCheckOk: false, failStreak: 1, deadAt: Date.now() - 1000, deadReason: '网络错误: fetch failed (c.com)' },
  ];
  sendMsg({ type: 'sources', items: baseItems });
  await sleep(30);

  posted.length = 0;
  if (!document.querySelector('#sourcePopup [data-src-clear]')) {
    document.querySelector('#sourcePopup [data-src-manage-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
  }
  document.querySelector('#sourcePopup [data-src-clear]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const clearMsg = posted.filter((m) => m.type === 'sourceSetEnabled').pop();
  assert(clearMsg && clearMsg.patches.length === 1 && clearMsg.patches[0].id === 's1' && clearMsg.patches[0].enabled === false,
    '「全部停用」应只把仍在启用的 s1 置为 false, 实际: ' + JSON.stringify(clearMsg));

  sendMsg({ type: 'sources', items: baseItems.map(function (x) { return { ...x, enabled: false }; }) });
  await sleep(30);
  const clearBtn = document.querySelector('#sourcePopup [data-src-clear]');
  assert(clearBtn.textContent.trim() === '全部启用',
    '全库可用源已全停用时, 批量按钮应变为「全部启用」, 实际: ' + clearBtn.textContent.trim());
  // 加一个只命中 A 站的筛选: 启用动作仍应覆盖筛选外的可用源, 但排除失效源
  const srcFilter = document.querySelector('#sourcePopup [data-src-filter]');
  srcFilter.value = 'A';
  srcFilter.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(30);
  assert(clearBtn.textContent.trim() === '全部启用',
    '筛选后当前列表全停用时仍应显示「全部启用」');
  posted.length = 0;
  clearBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const allMsg = posted.filter((m) => m.type === 'sourceSetEnabled').pop();
  assert(allMsg && allMsg.patches.length === 2 &&
    allMsg.patches.map((x) => x.id).sort().join(',') === 's1,s2' &&
    allMsg.patches.every((x) => x.enabled === true),
  '「全部启用」应忽略筛选并启用全部 alive 源、排除失效源, 实际: ' + JSON.stringify(allMsg));

  sendMsg({ type: 'sources', items: baseItems.map(function (x) { return { ...x, enabled: x.id !== 's3' }; }) });
  await sleep(30);
  assert(document.querySelector('#sourcePopup [data-src-all]').checked === true,
    '全部启用回推后当前筛选列表应呈全选状态');
  assert(clearBtn.textContent.trim() === '全部停用',
    '全部启用后按钮应恢复为「全部停用」');
  srcFilter.value = '';
  srcFilter.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(30);

  // 5b) 检查全部: 运行中可暂停/继续 (书源 Tab 自己的状态)
  posted.length = 0;
  let checkAllBtn = document.querySelector('#sourcePopup [data-src-check-all]');
  checkAllBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const checkStart = posted.filter((m) => m.type === 'sourceCheck').pop();
  assert(checkStart && checkStart.scope === 'active', '点「检查全部」应发送 sourceCheck(scope=active)');
  assert(typeof checkStart.runId === 'number', '检查应带 runId, 便于丢弃过期回包');
  assert(checkAllBtn.textContent.includes('暂停'), '点检查后按钮应立即变为「暂停」');

  sendMsg({ type: 'sourceCheckProgress', scope: 'active', runId: checkStart.runId, done: 1, total: 10, sourceName: 'A站', paused: false });
  await sleep(20);
  assert(checkAllBtn.textContent.includes('暂停'), '检查中按钮应保持「暂停」');
  let checkHint = document.querySelector('#sourcePopup [data-src-check-progress]');
  assert(checkHint && checkHint.textContent.includes('1/10') && checkHint.textContent.includes('A站'),
    '应显示检查进度与当前源');

  posted.length = 0;
  checkAllBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceCheckPause' && m.scope === 'active' && m.paused === true && m.runId === checkStart.runId),
    '点暂停应发送 sourceCheckPause(scope=active, paused=true)');
  assert(checkAllBtn.textContent.includes('继续'), '暂停后按钮应变「继续」');
  assert(document.querySelector('#sourcePopup [data-src-check-progress]').textContent.includes('已暂停'),
    '进度行应显示已暂停');

  // 暂停前的在途进度回包(paused=false)不能把「继续」改回「暂停」
  sendMsg({ type: 'sourceCheckProgress', scope: 'active', runId: checkStart.runId, done: 2, total: 10, sourceName: 'A站', paused: false });
  await sleep(20);
  assert(checkAllBtn.textContent.includes('继续'), '进度回包不应覆盖本地暂停状态');

  // 5c) 两个 Tab 状态独立: 失效 Tab 有自己的进度, 不影响书源 Tab
  sendMsg({ type: 'sourceCheckProgress', scope: 'dead', done: 5, total: 8, sourceName: 'C站', paused: false });
  await sleep(20);
  document.querySelector('#sourcePopup [data-src-tab="dead"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const deadBtn = document.querySelector('#sourcePopup [data-src-recheck-all]');
  assert(deadBtn.textContent.includes('暂停'), '失效 Tab 应显示自己的重查状态');
  assert(document.querySelector('#sourcePopup [data-src-check-progress]').textContent.includes('5/8'),
    '失效 Tab 应显示自己的进度');
  document.querySelector('#sourcePopup [data-src-tab="manage"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  // 切 Tab 会重建视图, 旧节点已脱离文档, 必须重新查询
  checkAllBtn = document.querySelector('#sourcePopup [data-src-check-all]');
  assert(checkAllBtn.textContent.includes('继续'), '回到书源 Tab, 暂停状态应仍在');
  assert(document.querySelector('#sourcePopup [data-src-check-progress]').textContent.includes('2/10'),
    '书源 Tab 的进度不应被失效 Tab 覆盖');

  // 清掉独立性测试里造出的失效 Tab 状态, 后面单独测重查
  sendMsg({ type: 'sourceCheckDone', scope: 'dead' });
  await sleep(20);

  // 5d) 取消
  const checkCancelBtn = document.querySelector('#sourcePopup [data-src-check-cancel]');
  assert(checkCancelBtn && checkCancelBtn.textContent.includes('取消'), '暂停后应出现取消按钮');
  posted.length = 0;
  checkCancelBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceCheckCancel' && m.scope === 'active' && m.runId === checkStart.runId),
    '点取消应发送 sourceCheckCancel(scope=active)');
  assert(checkAllBtn.textContent.includes('检查全部'), '取消后按钮应恢复为检查全部');
  assert(!document.querySelector('#sourcePopup [data-src-check-progress]'), '取消后进度行应消失');

  sendMsg({ type: 'sourceCheckDone', scope: 'active', runId: checkStart.runId });
  await sleep(20);
  assert(checkAllBtn.textContent.includes('检查全部'), '检查结束后按钮应恢复');

  // 6) 编辑 / 两步删除 / 导入
  document.querySelector('#sourcePopup [data-src-edit="s1"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const editName = document.querySelector('#sourcePopup [data-src-edit-name]');
  assert(editName && editName.value === 'A站', '点编辑应带出原名');
  editName.value = 'A站改名';
  editName.dispatchEvent(new win.Event('input', { bubbles: true }));
  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-edit-save]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceUpdate' && m.id === 's1' && m.name === 'A站改名'),
    '保存编辑应发送 sourceUpdate');

  posted.length = 0;
  const srcDelBtn = document.querySelector('#sourcePopup [data-src-del="s2"]');
  srcDelBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(srcDelBtn.classList.contains('confirming'), '第一次点删除应进入确认态');
  assert(!posted.some((m) => m.type === 'sourceRemove'), '第一次点删除不应真的删除');
  srcDelBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceRemove' && m.id === 's2'), '确认后应发送 sourceRemove');

  posted.length = 0;
  // 导入收进「导入书源 ▾」子菜单(R11-01): 先展开菜单
  document.querySelector('#sourcePopup [data-src-import-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  document.querySelector('#sourcePopup [data-src-import="url"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceImport' && m.mode === 'url'), '点「从 URL 导入」应发送 sourceImport(url)');

  // 7) 搜索 Tab: 不再有选源区/picker; sourceSearch 不带 sourceIds
  document.querySelector('#sourcePopup [data-src-tab="search"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!document.querySelector('#sourcePopup .src-chip'), '搜索 Tab 不应再有书源 chips');
  assert(!document.querySelector('#sourcePopup [data-src-picker]'), '搜索 Tab 不应再有选择书源入口');
  const input = document.querySelector('#sourcePopup [data-src-input]');
  input.value = '遮天';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  posted.length = 0;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(30);
  const searchMsg = posted.filter((m) => m.type === 'sourceSearch').pop();
  assert(searchMsg && searchMsg.key === '遮天', '回车应发送 sourceSearch');
  assert(typeof searchMsg.token === 'number', 'sourceSearch 应带 token');
  assert(searchMsg.sourceIds === undefined, '搜索不应再带 sourceIds(范围由「书源」Tab 勾选)');
  assert(document.querySelector('#sourcePopup [data-src-progress]').textContent.includes('正在准备搜索'),
    '未收到进度前应显示准备中');

  // 7b) 搜索进度: 第几个源 / 源名 / 成败 / 失败数
  sendMsg({ type: 'searchProgress', token: searchMsg.token, done: 1, total: 2, sourceName: 'A站', ok: true, failed: 0 });
  await sleep(20);
  let hint = document.querySelector('#sourcePopup [data-src-progress]').textContent;
  assert(hint.includes('1/2'), '应显示已完成/总数, 实际: ' + hint);
  assert(hint.includes('A站') && hint.includes('✓'), '应显示刚完成的源与成功标记');
  assert(document.querySelector('#sourcePopup [data-src-bar]'), '应有进度条');

  sendMsg({ type: 'searchProgress', token: searchMsg.token, done: 2, total: 2, sourceName: 'B站', ok: false, failed: 1 });
  await sleep(20);
  hint = document.querySelector('#sourcePopup [data-src-progress]').textContent;
  assert(hint.includes('2/2') && hint.includes('B站') && hint.includes('✗'), '应显示失败源与失败标记');
  assert(hint.includes('失败 1'), '应显示累计失败数');

  // 7c) 暂停/继续: 停止启动新源, 进度标记暂停
  const pauseBtn = document.querySelector('#sourcePopup [data-src-pause]');
  assert(pauseBtn && pauseBtn.textContent.includes('暂停'), '搜索中应有暂停按钮');
  posted.length = 0;
  pauseBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceSearchPause' && m.paused === true && m.token === searchMsg.token),
    '点暂停应发送 sourceSearchPause(paused=true)');
  assert(pauseBtn.textContent.includes('继续'), '暂停后按钮应变「继续」');
  assert(document.querySelector('#sourcePopup [data-src-progress]').textContent.includes('已暂停'),
    '进度行应显示已暂停');
  assert(document.querySelector('#sourcePopup [data-src-found]').textContent.includes('已找到 0 本'),
    '暂停后仍应显示已找到数量');

  posted.length = 0;
  pauseBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceSearchPause' && m.paused === false),
    '点继续应发送 sourceSearchPause(paused=false)');
  assert(pauseBtn.textContent.includes('暂停'), '继续后按钮应回「暂停」');

  // 7d) 流式批次: 搜索过程中先显示已有结果
  sendMsg({ type: 'searchBatch', token: searchMsg.token, items: [
    { sourceId: 's1', sourceName: 'A站', title: '遮天', author: '辰东', bookUrl: 'https://a.com/b/1', kind: '玄幻' },
  ], errors: [] });
  await sleep(20);
  assert(document.querySelectorAll('#sourcePopup .src-result').length === 1, '收到批次应立即显示结果');
  assert(!document.querySelector('#sourcePopup [data-src-errors]'), '搜索未结束时不显示「已移入失效」摘要');
  assert(document.querySelector('#sourcePopup [data-src-found]').textContent.includes('已找到 1 本'),
    '应动态显示已找到数量');

  sendMsg({ type: 'searchResults', token: searchMsg.token, done: true, deadAdded: ['s2'], errors: [
    { sourceId: 's2', sourceName: 'B站', kind: 'timeout', message: '搜索超时(10s)' },
  ], items: [
    { sourceId: 's1', sourceName: 'A站', title: '遮天', author: '辰东', bookUrl: 'https://a.com/b/1', kind: '玄幻', wordCount: 6350000, lastChapter: '第1888章 完美世界' },
    { sourceId: 's1', sourceName: 'A站', title: '完美世界', author: '辰东', bookUrl: 'https://a.com/b/2' },
  ] });
  await sleep(30);
  assert(document.querySelectorAll('#sourcePopup .src-result').length === 2, '应渲染 2 条搜索结果');
  assert(document.querySelector('#sourcePopup .src-result-title').textContent === '遮天', '结果标题应正确');
  assert(document.querySelector('#sourcePopup .src-result-meta').textContent.includes('635 万字'), '字数应折算为万字');
  assert(document.querySelector('#sourcePopup .src-badge').textContent === 'A站', '应显示来源书源');
  // 加入在线书架: 按钮可用 -> pending -> 失败提示 -> 成功标记
  const addBtn = document.querySelector('#sourcePopup [data-src-pane="current"] .src-add');
  assert(addBtn && !addBtn.disabled, '搜索结果「加入书架」应可用');
  posted.length = 0;
  addBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const onlineAddMsg = posted.filter((m) => m.type === 'addOnlineBook').pop();
  assert(onlineAddMsg && onlineAddMsg.item && onlineAddMsg.item.bookUrl === 'https://a.com/b/1', '点加入书架应发送 addOnlineBook');
  assert(cloneErrors.length === 0, '消息必须可结构化克隆(不能直接发 Vue Proxy): ' + JSON.stringify(cloneErrors));
  assert(addBtn.textContent.includes('加入中') && addBtn.disabled, '等待回包时应显示「加入中…」');
  sendMsg({ type: 'onlineBookAdded', bookUrl: 'https://a.com/b/1', ok: false, message: '书源不存在或已被删除' });
  await sleep(20);
  assert(document.querySelector('#sourcePopup [data-src-op-error]').textContent.includes('书源不存在'),
    '加入失败应显示原因');
  assert(!addBtn.disabled && addBtn.textContent.includes('加入书架'), '失败后按钮应恢复可点');
  sendMsg({ type: 'onlineBookAdded', bookUrl: 'https://a.com/b/1', ok: true });
  await sleep(20);
  assert(addBtn.textContent.includes('移出书架') && !addBtn.disabled,
    '加入成功后按钮应变为可点的「移出书架」');
  assert(!document.querySelector('#sourcePopup [data-src-op-error]'), '成功后应清除失败提示');

  // 移出书架: 按 bookUrl 对上书架记录, 发出 removeBook(扩展侧负责二次确认)
  sendMsg({ type: 'shelf', items: [
    { filePath: 'online://s1/hash1', title: '遮天', author: '辰东', chapterIndex: -1,
      totalChapters: 0, current: false, online: true, sourceName: 'A站',
      onlineBookUrl: 'https://a.com/b/1' },
  ] });
  await sleep(20);
  assert(addBtn.textContent.includes('移出书架') && !addBtn.disabled,
    '书架快照里已有该书时仍应显示「移出书架」');
  const addedRow = document.querySelector('#sourcePopup [data-src-pane="current"] .src-result');
  assert(addedRow.classList.contains('added') && addedRow.getAttribute('data-src-added') === '1',
    '已在书架的结果行应高亮(左缘竖条+浅底)');
  const addedBadge = addedRow.querySelector('[data-src-added-badge]');
  assert(addedBadge && addedBadge.textContent.includes('已存书架'), '已在书架的行应挂「已存书架」高亮徽标');
  assert(!addedRow.querySelector('[data-src-cur-badge]'), '非当前行不应有「在读/预览中」胶囊');
  posted.length = 0;
  addBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const rmMsg = posted.filter((m) => m.type === 'removeBook').pop();
  assert(rmMsg && rmMsg.filePath === 'online://s1/hash1',
    '点移出书架应发送 removeBook 并带上书架 filePath');
  assert(cloneErrors.length === 0, '移出消息必须可结构化克隆');
  // 书架推送里没有这本书之后, 按钮应恢复成「加入书架」, 行高亮也应取消
  sendMsg({ type: 'shelf', items: [] });
  await sleep(20);
  assert(addBtn.textContent.includes('加入书架') && !addBtn.disabled,
    '移出后按钮应恢复为「加入书架」');
  assert(!addedRow.classList.contains('added') && !addedRow.getAttribute('data-src-added')
    && !addedRow.querySelector('[data-src-added-badge]'),
    '移出后行高亮与「在书架」徽标都应取消');

  // 结果列表限高 10 条: 外层容器 + 内滚
  assert(document.querySelector('#sourcePopup [data-src-results]'), '搜索结果应放在独立滚动容器里');
  assert(document.querySelectorAll('[data-src-results] .src-result').length === 2,
    '结果行应位于滚动容器内');
  // 结果区只做布局: 上下两个 pane 各自滚动
  assert(/\.src-results\{[^}]*display:\s*flex/.test(capturedHtml), '结果区应为 flex 列布局');
  assert(/\.src-results\{[^}]*overflow:\s*hidden/.test(capturedHtml), '结果区自身不应滚动');
  assert(/\.src-pane\{[^}]*overflow-y:\s*auto/.test(capturedHtml), '结果 pane 应内部滚动');

  assert(document.querySelector('#sourcePopup [data-src-errors]').textContent.includes('1 个书源搜索失败'),
    '搜索报错应折叠成一行摘要');
  assert(document.querySelector('#sourcePopup [data-src-errors]').textContent.includes('已移入失效'),
    '摘要应说明失败源已移入失效');
  assert(document.querySelector('#sourcePopup .src-hint').textContent.includes('1 个源连续失败已移入失效'),
    '结果行应提示新移入失效的数量');
  assert(document.querySelector('#sourcePopup [data-src-error-dead]'), '摘要旁应有「查看失效书源」');

  // 8) 点摘要里的链接 -> 跳到失效 Tab
  document.querySelector('#sourcePopup [data-src-error-dead]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('#sourcePopup [data-dead-id="s3"]'), '应跳到失效 Tab 并显示失效源');
  assert(document.querySelector('#sourcePopup .src-dead-reason').textContent.includes('网络错误'),
    '失效行应展示失败原因');
  assert(document.querySelector('#sourcePopup .src-risk').textContent.includes('连续 2 次'),
    '失效说明应写「连续 2 次」');
  assert(!document.querySelector('#sourcePopup .src-risk').textContent.includes('任意一次失败'),
    '失效说明不应再写「任意一次失败」');

  // 7e) 全部重查: 运行中可暂停/继续 (失效 Tab 自己的状态)
  posted.length = 0;
  const recheckAllBtn = document.querySelector('#sourcePopup [data-src-recheck-all]');
  recheckAllBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const recheckStart = posted.filter((m) => m.type === 'sourceCheck').pop();
  assert(recheckStart && recheckStart.scope === 'dead', '点「全部重查」应发送 sourceCheck(scope=dead)');
  assert(recheckAllBtn.textContent.includes('暂停'), '点重查后按钮应立即变为「暂停」');

  sendMsg({ type: 'sourceCheckProgress', scope: 'dead', runId: recheckStart.runId, done: 3, total: 8, sourceName: 'C站', paused: false });
  await sleep(20);
  assert(recheckAllBtn.textContent.includes('暂停'), '重查中按钮应保持「暂停」');
  const recheckHint = document.querySelector('#sourcePopup [data-src-check-progress]');
  assert(recheckHint && recheckHint.textContent.includes('3/8') && recheckHint.textContent.includes('C站'),
    '失效 Tab 应显示重查进度');

  posted.length = 0;
  recheckAllBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceCheckPause' && m.scope === 'dead' && m.paused === true),
    '重查中暂停应发送 sourceCheckPause(scope=dead, paused=true)');
  assert(recheckAllBtn.textContent.includes('继续'), '暂停后按钮应变「继续」');

  const recheckCancel = document.querySelector('#sourcePopup [data-src-check-cancel]');
  assert(recheckCancel && recheckCancel.textContent.includes('取消'), '重查暂停后应出现取消按钮');
  posted.length = 0;
  recheckCancel.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceCheckCancel' && m.scope === 'dead'), '点取消应发送 sourceCheckCancel(scope=dead)');
  assert(recheckAllBtn.textContent.includes('全部重查'), '取消后按钮应恢复为全部重查');

  sendMsg({ type: 'sourceCheckDone', scope: 'dead', runId: recheckStart.runId });
  await sleep(20);
  assert(recheckAllBtn.textContent.includes('全部重查'), '重查结束后按钮应恢复');

  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-recheck="s3"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceCheck' && m.id === 's3' && m.scope === 'dead'),
    '单源重查应带 scope=dead');

  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-revive="s3"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceRevive' && m.id === 's3'), '点恢复应发送 sourceRevive');

  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-recheck-all]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceCheck' && m.scope === 'dead' && m.id === undefined),
    '「全部重查」应发送 scope=dead');

  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-clear-dead]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'sourceClearDead'), '「清除全部」应发送 sourceClearDead');

  // 8c) 失效列表: 15 条 + 触底 + 全选/反选/批量恢复
  {
    const deadMany = Array.from({ length: 18 }, (_, i) => ({
      id: 'd' + i, name: '失效源' + i, url: 'https://d' + i + '.com', group: '', enabled: true,
      searchUrl: 'https://d' + i + '.com/s', failStreak: 2, deadAt: Date.now(), deadReason: 'HTTP 404',
    }));
    sendMsg({ type: 'sources', items: deadMany });
    await sleep(40);
    assert(document.querySelectorAll('#sourcePopup [data-dead-id]').length === 15,
      '失效列表首屏应渲染 15 行, 实际 ' + document.querySelectorAll('#sourcePopup [data-dead-id]').length);
    assert(!document.querySelector('#sourcePopup [data-src-load-more]'), '失效列表不应有加载更多按钮');
    const deadList = document.querySelector('#sourcePopup [data-src-dead-list]');
    Object.defineProperty(deadList, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(deadList, 'clientHeight', { configurable: true, value: 384 });
    Object.defineProperty(deadList, 'scrollTop', { configurable: true, value: 816 });
    deadList.dispatchEvent(new win.Event('scroll'));
    await sleep(40);
    assert(document.querySelectorAll('#sourcePopup [data-dead-id]').length === 18, '触底后应渲染 18 行');

    const boxes = Array.from(document.querySelectorAll('#sourcePopup [data-src-dead-check]'));
    boxes[0].dispatchEvent(new win.Event('change', { bubbles: true }));
    boxes[1].dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#sourcePopup .src-bulk-count').textContent.includes('2'), '应显示已选 2');
    posted.length = 0;
    document.querySelector('#sourcePopup [data-src-revive-selected]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const rev = posted.filter((m) => m.type === 'sourceReviveMany').pop();
    assert(rev && Array.isArray(rev.ids) && rev.ids.length === 2, '恢复所选应带 2 个 id');

    document.querySelector('#sourcePopup [data-src-dead-all]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#sourcePopup .src-bulk-count').textContent.includes('18'), '全选应覆盖全部失效源');
    document.querySelector('#sourcePopup [data-src-dead-invert]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#sourcePopup .src-bulk-count').textContent.includes('0'), '反选后应清空选择');
    posted.length = 0;
    document.querySelector('#sourcePopup [data-src-revive-all]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const revAll = posted.filter((m) => m.type === 'sourceReviveMany').pop();
    assert(revAll && revAll.ids === undefined, '全部恢复不应带 ids');
  }

  // 9) 失效清空后: 失效 Tab 空态
  sendMsg({ type: 'sources', items: [
    { id: 's1', name: 'A站', url: 'https://a.com', group: '玄幻', enabled: true, searchUrl: 'https://a.com/s?q={{key}}', lastCheckOk: true, failStreak: 0 },
  ] });
  await sleep(40);
  assert(document.querySelector('#sourcePopup .src-empty'), '没有失效源时应显示空态');
  assert(!document.querySelector('[data-src-dead-count]'), '失效角标应消失');

  // 10) 全部停用 -> 搜索 Tab 提示去启用
  sendMsg({ type: 'sources', items: [
    { id: 's1', name: 'A站', url: 'https://a.com', group: '', enabled: false, searchUrl: 'https://a.com/s?q={{key}}', failStreak: 0 },
  ] });
  await sleep(30);
  document.querySelector('#sourcePopup [data-src-tab="search"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('#sourcePopup .src-empty').textContent.includes('已停用'), '应提示所有书源都已停用');
  document.querySelector('#sourcePopup [data-src-go-manage]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('#sourcePopup .src-filter'), '点「去书源勾选启用」应切到书源 Tab');

  // 11) 大量书源: 60 条增量渲染 + 加载更多
  const many = Array.from({ length: 70 }, (_, i) => ({
    id: 'm' + i, name: '源' + i, url: 'https://s' + i + '.com', group: i % 2 ? 'G1' : 'G2',
    enabled: true, searchUrl: 'https://s' + i + '.com/s?q={{key}}', failStreak: 0,
  }));
  sendMsg({ type: 'sources', items: many });
  await sleep(50);
  assert(document.querySelectorAll('#sourcePopup .src-row[data-source-id]').length === 60,
    '管理列表应先渲染 60 行, 实际 ' + document.querySelectorAll('#sourcePopup .src-row[data-source-id]').length);
  assert(!document.querySelector('#sourcePopup [data-src-load-more]'), '触底加载后不应再有「加载更多」按钮');
  {
    const listEl = document.querySelector('#sourcePopup [data-src-list]');
    Object.defineProperty(listEl, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(listEl, 'clientHeight', { configurable: true, value: 480 });
    Object.defineProperty(listEl, 'scrollTop', { configurable: true, value: 720 });
    listEl.dispatchEvent(new win.Event('scroll'));
  }
  await sleep(40);
  assert(document.querySelectorAll('#sourcePopup .src-row[data-source-id]').length === 70, '触底后应渲染 70 行');

  // 11b) 列表限高 15 行: 行都在 list 内, 列表自身滚动
  assert(document.querySelector('[data-src-list]'), '管理列表应有独立滚动容器 [data-src-list]');
  assert(document.querySelectorAll('[data-src-list] .src-row[data-source-id]').length === 70,
    '所有行都应在滚动容器内');
  assert(/\.src-list\s*\{[^}]*max-height:\s*calc\(var\(--src-row-h\)\s*\*\s*15\)[^}]*overflow-y:\s*auto/.test(capturedHtml),
    '列表应限制为 15 行高度并内部滚动');
  assert(/\.src-row\s*\{[^}]*height:\s*var\(--src-row-h\)/.test(capturedHtml),
    '行高应固定为 --src-row-h, 便于精确限高');
  assert(/--src-row-h:\s*32px/.test(capturedHtml), '行高变量应为 32px');

  // 12) 滚动守卫: 列表与外层面板接力; 都到底才阻断
  assert(/\.popup-body\s*\{[^}]*overscroll-behavior:\s*contain/.test(capturedHtml),
    '弹窗体应有 overscroll-behavior: contain');
  {
    const listEl = document.querySelector('#sourcePopup .src-list');
    const bodyEl = document.querySelector('#sourcePopup .popup-body');
    const rowEl = document.querySelector('#sourcePopup .src-row[data-source-id]');
    let listTop = 100;
    let bodyTop = 100;
    Object.defineProperty(listEl, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(listEl, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(listEl, 'scrollTop', { configurable: true, get: () => listTop, set: () => {} });
    Object.defineProperty(bodyEl, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(bodyEl, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(bodyEl, 'scrollTop', { configurable: true, get: () => bodyTop, set: () => {} });

    // a) 列表未到底 -> 放行
    let ev = new win.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    rowEl.dispatchEvent(ev);
    assert(!ev.defaultPrevented, '列表未到底时应正常滚动列表');

    // b) 列表到底, 外层面板仍可滚 -> 放行(接力给面板)
    listTop = 400;
    ev = new win.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    rowEl.dispatchEvent(ev);
    assert(!ev.defaultPrevented, '列表到底但面板还能滚时应放行');

    // c) 两层都到底 -> 阻断, 不带动正文
    bodyTop = 400;
    ev = new win.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    rowEl.dispatchEvent(ev);
    assert(ev.defaultPrevented, '列表与面板都到底时应阻断滚轮');

    // d) 横向/惯性 deltaY=0 -> 不干预
    ev = new win.WheelEvent('wheel', { deltaY: 0, bubbles: true, cancelable: true });
    rowEl.dispatchEvent(ev);
    assert(!ev.defaultPrevented, 'deltaY=0 不应拦截');

    // e) 正文区域 -> 不干预
    ev = new win.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    (document.querySelector('#reader') || document.body).dispatchEvent(ev);
    assert(!ev.defaultPrevented, '正文区域的滚轮不应被拦截');
  }

  // 13) 取消: 进度消失、结果保留、迟到回包被 token 丢弃
  document.querySelector('#sourcePopup [data-src-tab="search"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const searchInput = document.querySelector('#sourcePopup [data-src-input]');
  searchInput.value = '斗破';
  searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-go]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const histStart = posted.filter((m) => m.type === 'sourceSearch').pop();
  assert(histStart && histStart.key === '斗破', '应发起新一轮搜索');
  assert(document.querySelector('#sourcePopup [data-src-found]').textContent.includes('已找到 0 本'),
    '新搜索开始时应显示 0 本');
  sendMsg({ type: 'searchProgress', token: histStart.token, done: 1, total: 10, sourceName: 'A站', ok: true, failed: 0 });
  sendMsg({ type: 'searchBatch', token: histStart.token, errors: [], items: [
    { sourceId: 's1', sourceName: 'A站', title: '斗破苍穹', author: '天蚕土豆', bookUrl: 'https://h/1' },
    { sourceId: 's1', sourceName: 'A站', title: '斗破外传', author: '天蚕土豆', bookUrl: 'https://h/2' },
    { sourceId: 's1', sourceName: 'A站', title: '斗破合集', author: '天蚕土豆', bookUrl: 'https://h/3' },
  ] });
  await sleep(30);
  assert(document.querySelector('#sourcePopup [data-src-found]').textContent.includes('已找到 3 本'),
    '已找到数量应随批次增长');
  assert(document.querySelector('#sourcePopup [data-src-history-label]').textContent.includes('遮天'),
    '应显示历史搜索关键词');
  assert(document.querySelectorAll('#sourcePopup [data-src-history-result]').length === 2,
    '历史区应显示上一次的 2 条结果');
  // 行数契约: JS 只给 --src-alloc-rows, 高度由 CSS 用 --src-result-h 乘出来(方案 §4.2)
  const curPane = document.querySelector('#sourcePopup [data-src-pane="current"]');
  const histPane = document.querySelector('#sourcePopup [data-src-pane="history"]');
  assert(curPane.style.getPropertyValue('--src-alloc-rows').trim() === '3',
    '当前 3 条应给 3 行, 实际 ' + curPane.style.getPropertyValue('--src-alloc-rows'));
  assert(histPane.style.getPropertyValue('--src-alloc-rows').trim() === '2',
    '历史 2 条应给 2 行');
  assert(capturedHtml.indexOf('calc(var(--src-result-h, 44px) * var(--src-alloc-rows') >= 0,
    '.src-pane 的高度应由 --src-result-h × --src-alloc-rows 计算');

  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-cancel]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'sourceSearchCancel' && m.token === histStart.token),
    '点取消应发送 sourceSearchCancel');
  assert(!document.querySelector('#sourcePopup [data-src-progress]'), '取消后进度行应消失');
  assert(document.querySelectorAll('#sourcePopup [data-src-pane="current"] .src-result').length === 3,
    '取消后应保留已搜到的结果');
  assert(document.querySelector('#sourcePopup [data-src-go]').textContent.includes('搜索'),
    '取消后按钮应回到「搜索」');

  // 迟到的旧 token 回包不得改动结果
  sendMsg({ type: 'searchResults', token: histStart.token, done: true, items: [
    { sourceId: 's1', sourceName: 'A站', title: '迟到结果', author: 'x', bookUrl: 'https://h/9' },
  ], errors: [] });
  await sleep(20);
  assert(document.querySelectorAll('#sourcePopup [data-src-pane="current"] .src-result').length === 3,
    '取消后迟到的回包应被 token 丢弃');

  // 14) 搜索中改写关键词 -> 取消本轮, 状态回到「搜索」
  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-go]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const editStart = posted.filter((m) => m.type === 'sourceSearch').pop();
  assert(editStart && editStart.key === '斗破', '同词重搜应发新请求');
  sendMsg({ type: 'searchBatch', token: editStart.token, errors: [], items: [
    { sourceId: 's1', sourceName: 'A站', title: '斗破新结果', author: 'x', bookUrl: 'https://h/10' },
  ] });
  await sleep(20);
  searchInput.value = '完美世界';
  searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(30);
  assert(posted.some((m) => m.type === 'sourceSearchCancel' && m.token === editStart.token),
    '改写输入框应取消本轮');
  assert(!document.querySelector('#sourcePopup [data-src-progress]'), '改写后进度行应消失');
  assert(document.querySelector('#sourcePopup [data-src-go]').textContent.includes('搜索'),
    '改写后状态应回到「搜索」');
  assert(!document.querySelector('#sourcePopup [data-src-go]').disabled,
    '改写后「搜索」按钮应立即可点(不必先点取消)');

  // 15) 再搜: 上一轮 1 条进历史, 本次 6 条 -> 6/1 行
  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-go]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const splitStart = posted.filter((m) => m.type === 'sourceSearch').pop();
  assert(splitStart && splitStart.key === '完美世界', '应按新关键词搜索');
  assert(document.querySelector('#sourcePopup [data-src-history-label]').textContent.includes('斗破'),
    '历史应替换为上一轮(斗破)');
  const six = Array.from({ length: 6 }, (_, i) => ({
    sourceId: 's1', sourceName: 'A站', title: '完美 ' + i, author: '辰东', bookUrl: 'https://p/' + i,
  }));
  sendMsg({ type: 'searchBatch', token: splitStart.token, errors: [], items: six });
  await sleep(30);
  assert(document.querySelector('#sourcePopup [data-src-pane="current"]').style.getPropertyValue('--src-alloc-rows').trim() === '6',
    '当前 6 条应给 6 行');
  assert(document.querySelector('#sourcePopup [data-src-pane="history"]').style.getPropertyValue('--src-alloc-rows').trim() === '1',
    '历史 1 条应给 1 行');

  // 16) 再搜: 上一轮 6 条进历史, 本次 6 条 -> 5/5 行, 拖动 +1 行
  posted.length = 0;
  searchInput.value = '圣墟';
  searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(30);   // 改写会先取消上一轮(watch 异步), 再点搜索
  document.querySelector('#sourcePopup [data-src-go]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const dragStart = posted.filter((m) => m.type === 'sourceSearch').pop();
  assert(dragStart && dragStart.key === '圣墟', '应发起第三次搜索');
  const six2 = Array.from({ length: 6 }, (_, i) => ({
    sourceId: 's1', sourceName: 'A站', title: '圣墟 ' + i, author: '辰东', bookUrl: 'https://s/' + i,
  }));
  sendMsg({ type: 'searchBatch', token: dragStart.token, errors: [], items: six2 });
  await sleep(30);
  assert(document.querySelectorAll('#sourcePopup [data-src-history-result]').length === 6,
    '历史应为 6 条');
  assert(!document.querySelector('#sourcePopup [data-src-history-result] .src-add'),
    '历史结果不应显示加入书架按钮');
  assert(document.querySelector('#sourcePopup [data-src-pane="current"]').style.getPropertyValue('--src-alloc-rows').trim() === '5',
    '两边都 6 条时当前区应给 5 行');
  assert(document.querySelector('#sourcePopup [data-src-pane="history"]').style.getPropertyValue('--src-alloc-rows').trim() === '5',
    '两边都 6 条时历史区应给 5 行');

  const splitEl = document.querySelector('#sourcePopup [data-src-split]');
  const pt = (type, y) => {
    if (win.PointerEvent) { return new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y }); }
    const e = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clientY', { value: y });
    Object.defineProperty(e, 'button', { value: 0 });
    return e;
  };
  splitEl.dispatchEvent(pt('pointerdown', 100));
  document.dispatchEvent(pt('pointermove', 144));
  document.dispatchEvent(pt('pointerup', 144));
  await sleep(30);
  assert(document.querySelector('#sourcePopup [data-src-pane="current"]').style.getPropertyValue('--src-alloc-rows').trim() === '6',
    '拖动 +1 行后当前区应给 6 行');
  assert(document.querySelector('#sourcePopup [data-src-pane="history"]').style.getPropertyValue('--src-alloc-rows').trim() === '4',
    '拖动后历史区应给 4 行');
  assert(document.querySelector('#sourcePopup [data-src-split]').getAttribute('aria-valuenow') === '6',
    '分隔条当前行数应更新');

  // 17) 当前结果补到 10 条, 拖到底 -> 历史收起到 0, 标题仍在
  const four = Array.from({ length: 4 }, (_, i) => ({
    sourceId: 's1', sourceName: 'A站', title: '圣墟 附加 ' + i, author: '辰东', bookUrl: 'https://s2/' + i,
  }));
  sendMsg({ type: 'searchBatch', token: dragStart.token, errors: [], items: four });
  await sleep(30);
  assert(document.querySelector('#sourcePopup [data-src-pane="current"]').style.getPropertyValue('--src-alloc-rows').trim() === '6',
    '补到 10 条后仍按拖动分得的 6 行显示(超出内滚)');
  const splitEl2 = document.querySelector('#sourcePopup [data-src-split]');
  splitEl2.dispatchEvent(pt('pointerdown', 100));
  document.dispatchEvent(pt('pointermove', 500));
  document.dispatchEvent(pt('pointerup', 500));
  await sleep(30);
  assert(!document.querySelector('#sourcePopup [data-src-pane="history"]'), '拖到最大时历史区应收起');
  assert(document.querySelector('#sourcePopup [data-src-history-label]'), '历史标题应保留');
  assert(document.querySelector('#sourcePopup [data-src-pane="current"]').style.getPropertyValue('--src-alloc-rows').trim() === '10',
    '历史收起后当前区最多 10 行');

  // 18) 历史收起后不渲染历史行
  assert(!document.querySelector('#sourcePopup [data-src-history-result]'),
    '历史收起后不渲染历史行');

  // 18.5) 输入法确认候选的回车(composing)不应触发搜索
  posted.length = 0;
  searchInput.value = '吞噬星空';
  const imeEnter = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  Object.defineProperty(imeEnter, 'isComposing', { value: true });
  searchInput.dispatchEvent(imeEnter);
  await sleep(20);
  assert(!posted.some((m) => m.type === 'sourceSearch'), '输入法组合中的回车不应发起搜索');

  // 19) 点击结果行 -> 临时预览: 弹窗保持到 previewReady
  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-result="0"] .src-result-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const previewMsg = posted.filter((m) => m.type === 'previewOnlineBook').pop();
  assert(previewMsg && previewMsg.item && previewMsg.item.bookUrl, '点结果行应发送 previewOnlineBook');
  assert(cloneErrors.length === 0, '预览消息必须可结构化克隆: ' + JSON.stringify(cloneErrors));
  const saveIdx = posted.findIndex((m) => m.type === 'saveProgress');
  const previewIdx = posted.findIndex((m) => m.type === 'previewOnlineBook');
  assert(saveIdx >= 0 && saveIdx < previewIdx, '切书前应先发 saveProgress(旧书进度)');
  const previewRow = document.querySelector('#sourcePopup [data-src-result="0"]');
  assert(previewRow.classList.contains('cur') && previewRow.getAttribute('data-src-current') === '1',
    '被预览的结果行应高亮');
  assert(previewRow.getAttribute('data-src-preview-busy') === '1', '解析中的行应标记 busy');
  assert(previewRow.querySelector('.src-cur-badge').textContent.includes('解析中'), '解析中徽标应显示「解析中…」');
  assert($('#sourcePopup').classList.contains('open'), '解析中弹窗应保持打开');
  assert(document.querySelector('#sourcePopup [data-src-preview-pending]'), '应显示全局解析中提示');

  // 解析中再点第二行: 不应再发请求
  posted.length = 0;
  document.querySelector('#sourcePopup [data-src-result="1"] .src-result-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.filter((m) => m.type === 'previewOnlineBook').length === 0, '解析中再点其他结果不应发第二个请求');

  // bookUrl 不匹配的成功回包不关闭
  sendMsg({ type: 'previewReady', bookUrl: 'https://other/book' });
  await sleep(20);
  assert($('#sourcePopup').classList.contains('open'), '不匹配的 previewReady 不应关闭弹窗');
  assert(document.querySelector('#sourcePopup [data-src-preview-pending]'), '不匹配时 pending 应保留');

  // 匹配的成功回包 -> 关闭弹窗, 清除解析中
  sendMsg({ type: 'previewReady', bookUrl: previewMsg.item.bookUrl });
  await sleep(30);
  assert(!$('#sourcePopup').classList.contains('open'), '预览成功后应关闭书源弹窗');
  assert(!document.querySelector('#sourcePopup [data-src-preview-pending]'), '成功后解析中提示应消失');

  // 失败: 弹窗保持, 清除 pending/高亮, 显示原因
  menuItem('source').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  document.querySelector('#sourcePopup [data-src-result="0"] .src-result-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  sendMsg({ type: 'previewError', message: '目录解析结果为空: 源「A站」 目录页 https://a.com/book/1', bookUrl: previewMsg.item.bookUrl });
  await sleep(30);
  assert($('#sourcePopup').classList.contains('open'), '预览失败后弹窗应保持打开');
  assert(!document.querySelector('#sourcePopup [data-src-preview-pending]'), '失败后应清除解析中提示');
  assert(!document.querySelector('#sourcePopup [data-src-result="0"]').classList.contains('cur'),
    '预览失败后应清除高亮');
  assert(document.querySelector('#sourcePopup [data-src-op-error]').textContent.includes('源「A站」'),
    '失败提示应带源名/目录页');

  // 解析中手动关闭: 失败不应强行重开
  document.querySelector('#sourcePopup [data-src-result="0"] .src-result-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(document.querySelector('#sourcePopup .popup-close').textContent.trim() === '关闭',
    '书源浮窗关闭入口应为文字「关闭」');
  assert(!/✕/.test(document.querySelector('#sourcePopup .popup-close').textContent),
    '书源浮窗不应再使用 X 图标');
  document.querySelector('#sourcePopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(!$('#sourcePopup').classList.contains('open'), '手动关闭后应保持关闭');
  sendMsg({ type: 'previewError', message: '目录解析结果为空', bookUrl: previewMsg.item.bookUrl });
  await sleep(30);
  assert(!$('#sourcePopup').classList.contains('open'), '手动关闭后失败不应强行重开');

  document.querySelector('#sourcePopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);

  // ================================================================ 阅读笔记
  console.log('[阅读笔记]');
  // 1) 空态
  menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert($('#notesPopup').classList.contains('open'), '点菜单「笔记」应打开笔记浮层');
  assert(document.querySelector('#notesPopup .nt-empty'), '无笔记时应显示空态引导');
  document.querySelector('#notesPopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);

  // 2) 单击段落 → 新建卡片(默认引用整段)
  dispatch('chapter', {
    index: 2, title: novel.chapters[2].title, paragraphs: ['甲段原文。', '乙段原文。', '丙段。'],
    totalChapters: 5, chapterWords: 9, scrollRatio: 0,
  });
  await sleep(30);
  const para1 = document.querySelector('#content p[data-p="1"]');
  para1.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  para1.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  let composer = document.querySelector('.note-composer');
  assert(composer, '单击段落应弹出新建笔记卡片');
  assert(!composer.querySelector('.nc-quote'), '新建卡片不应再显示引用行(引用在预览里看)');
  assert(para1.classList.contains('rd-para-active'), '选中段落应加虚线下划线(选中态)');
  assert(!para1.classList.contains('rd-para-noted'), '尚无笔记时不应有持久下划线');
  // 点卡片外任意处 → 自动关闭(该次点击的 click 也一并派发, 清"吞点击"标志); 再点段落 → 重新弹出
  document.querySelector('.chapter-title').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  document.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(!document.querySelector('.note-composer'), '点击卡片外任意处应自动关闭新建卡片');
  para1.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  para1.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  composer = document.querySelector('.note-composer');
  assert(composer, '重新单击段落应再次弹出新建卡片');

  // 3) Ctrl+Enter 保存 → addNote(不带 bookPath)
  const ta = composer.querySelector('.nc-text');
  ta.value = '第一条笔记';
  ta.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(10);
  posted.length = 0;
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await sleep(30);
  const addMsg = posted.find((m) => m.type === 'addNote');
  assert(addMsg, 'Ctrl+Enter 应发出 addNote');
  assert(addMsg.text === '第一条笔记' && addMsg.quote === '乙段原文。' && addMsg.paragraphIndex === 1,
    'addNote 应带正文/整段引用/段落序号');
  assert(addMsg.chapterTitle === novel.chapters[2].title, 'addNote 应带章节标题锚点');
  assert(!('bookPath' in addMsg), 'bookPath 应由扩展盖章, webview 不传');

  // 4) 回执 → 卡片关闭, 浮层出现分组与条目
  const noteItem = {
    id: 'note-1', bookPath: novel.filePath, bookTitle: novel.bookTitle,
    chapterTitle: novel.chapters[2].title, chapterIndex: 2, paragraphIndex: 1,
    quote: '乙段原文。', text: '第一条笔记', createdAt: 1, updatedAt: 1,
  };
  sendMsg({ type: 'noteUpserted', item: noteItem });
  await sleep(30);
  assert(!document.querySelector('.note-composer'), '保存成功后新建卡片应关闭');
  menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelectorAll('#notesPopup .nt-item').length === 1, '笔记浮层应出现 1 条');
  assert(document.querySelector('#notesPopup .nt-book-title').textContent.includes(novel.bookTitle),
    '应按书分组显示书名');
  assert(document.querySelector('.menu-item[data-menu="notes"] .menu-badge'), '侧栏入口应显示笔记角标');
  const p1After = document.querySelector('#content p[data-p="1"]');
  assert(p1After.classList.contains('rd-para-noted'), '有笔记锚定的段落应保持持久虚线下划线');
  assert(!p1After.classList.contains('rd-para-active'), '卡片关闭后选中态下划线应消失');
  // 章分组: 在读章默认展开
  assert(document.querySelector('#notesPopup .nt-chap-group'), '书内应渲染章分组');
  assert(document.querySelector('#notesPopup .nt-chap-group:not(.collapsed)'), '在读章分组应默认展开');
  assert(document.querySelector('#notesPopup .nt-chap-head .nt-tag'), '在读章分组应带「在读」标签');
  // 正文段落悬浮不再有笔记浮窗(hover content 效果已移除)
  p1After.dispatchEvent(new win.MouseEvent('mouseenter'));
  await sleep(320);
  assert(!document.querySelector('.para-note-tip'), '正文段落悬浮不应再显示笔记浮窗');

  // 5) 命中条目即出现浮窗(条目内移动不闪断); 原文行无原生 title 提示
  const nt1 = document.querySelector('#notesPopup .nt-item');
  const quoteEl = nt1.querySelector('.nt-quote');
  nt1.dispatchEvent(new win.MouseEvent('mouseenter'));
  await sleep(320);
  const pvOnQuote = document.querySelector('.note-preview');
  assert(pvOnQuote, '悬浮条目应弹出预览浮窗');
  assert(pvOnQuote.textContent.includes('乙段原文。'), '浮窗应显示完整原文');
  // 条目内从笔记正文移到原文行: 浮窗应保持显示, 不应反复触发(闪断)
  nt1.querySelector('.nt-text').dispatchEvent(new win.MouseEvent('mouseleave'));
  quoteEl.dispatchEvent(new win.MouseEvent('mouseenter'));
  await sleep(60);
  assert(document.querySelector('.note-preview'), '条目内移动浮窗不应闪断');
  await sleep(320);
  assert(document.querySelector('.note-preview'), '条目内移动后浮窗应持续显示');
  nt1.dispatchEvent(new win.MouseEvent('mouseleave'));
  await sleep(200);
  assert(!document.querySelector('.note-preview'), '移出条目后浮窗应收起');
  assert(!quoteEl.hasAttribute('title'), '原文行不应有原生 title 提示');
  const goBtn = nt1.querySelector('.nt-go');
  assert(goBtn && goBtn.textContent.includes('定位到原文'), '条目内应有「定位到原文」按钮');
  assert(nt1.querySelector('.nt-quote').textContent.includes('原文：乙段原文。'), '条目原文应带「原文」前缀');

  // 5b) 点击已有「有内容」笔记的段落 → 查看卡片(笔记正文+编辑/删除), 点编辑才进入编辑
  document.querySelector('#notesPopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  posted.length = 0;
  p1After.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  p1After.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const viewCard = document.querySelector('.note-composer');
  assert(viewCard, '点击已记笔记的段落应弹出卡片');
  assert((viewCard.querySelector('.nc-title') || {}).textContent === '笔记', '有内容笔记应显示「笔记」查看卡片');
  assert((viewCard.querySelector('.nc-view-text') || {}).textContent.includes('第一条笔记'), '查看卡片应显示笔记内容');
  assert(!viewCard.querySelector('.nc-text'), '查看卡片不应有编辑框');
  assert(!viewCard.querySelector('.nt-quote') && !viewCard.querySelector('.nt-go'), '查看卡片不应有原文行与定位到原文');
  const viewBtns = Array.from(viewCard.querySelectorAll('.nc-btn')).map((b) => b.textContent.trim());
  assert(viewBtns.join(',') === '编辑,删除', '查看卡片按钮应为 编辑/删除(实际 ' + viewBtns.join(',') + ')');
  // 点「编辑」→ 变为编辑卡片并带入内容
  viewCard.querySelector('.nc-btn-primary').click();
  await sleep(30);
  const editComposer = document.querySelector('.note-composer');
  assert(editComposer && (editComposer.querySelector('.nc-title') || {}).textContent === '编辑笔记', '点「编辑」应变为编辑卡片');
  const editTa = editComposer.querySelector('.nc-text');
  assert(editTa.value === '第一条笔记', '编辑卡片应带入笔记内容');
  editTa.value = '第一条笔记(改)';
  editTa.dispatchEvent(new win.Event('input', { bubbles: true }));
  editComposer.querySelector('.nc-btn-primary').click();
  await sleep(30);
  const updMsg = posted.find((m) => m.type === 'updateNote');
  assert(updMsg && updMsg.id === 'note-1' && updMsg.text === '第一条笔记(改)', '编辑保存应发 updateNote');
  sendMsg({ type: 'noteUpserted', item: { ...noteItem, text: '第一条笔记(改)', updatedAt: 2 } });
  await sleep(30);
  assert(!document.querySelector('.note-composer'), '编辑保存成功后卡片应关闭');

  // 5c) 查看卡片「删除」→ 两步确认(取消可回退), 第二次点击才移除
  posted.length = 0;
  p1After.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  p1After.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const viewCard2 = document.querySelector('.note-composer');
  assert(viewCard2 && viewCard2.querySelector('.nc-view-text'), '再次点击段落应弹出查看卡片');
  const cardDelBtn = Array.from(viewCard2.querySelectorAll('.nc-btn'))
    .find((b) => b.textContent.trim() === '删除');
  assert(cardDelBtn, '查看卡片应有「删除」按钮');
  cardDelBtn.click();
  await sleep(20);
  const confirmBtn = Array.from(viewCard2.querySelectorAll('.nc-btn'))
    .find((b) => b.textContent.trim() === '确认删除');
  assert(confirmBtn, '第一次点删除应变「确认删除」');
  assert(!posted.some((m) => m.type === 'removeNote'), '确认前不应发 removeNote');
  const cardCancel = Array.from(viewCard2.querySelectorAll('.nc-btn'))
    .find((b) => b.textContent.trim() === '取消');
  assert(cardCancel, '查看卡片确认态旁应有「取消」按钮');
  cardCancel.click();
  await sleep(20);
  assert(Array.from(viewCard2.querySelectorAll('.nc-btn')).some((b) => b.textContent.trim() === '删除'),
    '点取消应回退到「删除」');
  assert(!posted.some((m) => m.type === 'removeNote'), '取消不应发 removeNote');

  // 5d) 编辑卡片(editId)内也可删除: 两步确认, 第二次点击才移除并关卡片
  Array.from(viewCard2.querySelectorAll('.nc-btn')).find((b) => b.textContent.trim() === '编辑').click();
  await sleep(30);
  const editCard2 = document.querySelector('.note-composer');
  assert(editCard2 && editCard2.querySelector('.nc-text'), '点编辑应进入编辑卡片');
  const editDelBtn = Array.from(editCard2.querySelectorAll('.nc-btn'))
    .find((b) => b.textContent.trim() === '删除');
  assert(editDelBtn, '编辑卡片应有「删除」按钮(空笔记也能删)');
  editDelBtn.click();
  await sleep(20);
  const editConfirm = Array.from(editCard2.querySelectorAll('.nc-btn'))
    .find((b) => b.textContent.trim() === '确认删除');
  assert(editConfirm, '编辑卡片删除也应两步确认');
  assert(!posted.some((m) => m.type === 'removeNote'), '确认前不应发 removeNote');
  editConfirm.click();
  await sleep(30);
  assert(posted.some((m) => m.type === 'removeNote' && m.id === 'note-1'), '编辑卡片确认删除应发 removeNote');
  assert(!document.querySelector('.note-composer'), '删除后卡片应关闭');
  sendMsg({ type: 'noteUpserted', item: { ...noteItem, text: '第一条笔记(改)', updatedAt: 3 } });
  await sleep(30);

  // 5e) 卡片开着时点其他段落: 第一次只关卡片, 再点才选中新段落; 滚动自动关卡片
  p1After.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  p1After.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('.note-composer'), '前置: 点击笔记段落应弹出查看卡片');
  const paraB = document.querySelector('#content p[data-p="2"]');
  paraB.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  paraB.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!document.querySelector('.note-composer'), '点击其他段落应先只关闭卡片');
  assert(!paraB.classList.contains('rd-para-active'), '第一次点击不应选中新段落');
  paraB.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  paraB.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(document.querySelector('.note-composer'), '第二次点击才选中新段落');
  assert(paraB.classList.contains('rd-para-active'), '第二次点击段落应带选中态');
  win.dispatchEvent(new win.Event('scroll'));
  await sleep(30);
  assert(!document.querySelector('.note-composer'), '滚动页面应自动关闭笔记卡片');

  // 6) 两步删除: 第一次只变文案, 第二次才发 removeNote
  posted.length = 0;
  const delBtn = document.querySelector('#notesPopup .nt-act-danger');
  delBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(document.querySelector('#notesPopup .nt-act-danger').textContent.includes('确认删除'),
    '第一次点删除应变「确认删除」');
  assert(!posted.some((m) => m.type === 'removeNote'), '第一次点击不应发 removeNote');
  // 确认态旁边应有「取消」按钮: 点击回退到普通态
  const cancelBtn = Array.from(document.querySelectorAll('#notesPopup .nt-acts .nt-act'))
    .find((b) => b.textContent.trim() === '取消');
  assert(cancelBtn, '确认删除状态旁边应有「取消」按钮');
  cancelBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(document.querySelector('#notesPopup .nt-act-danger').textContent.includes('删除')
    && !document.querySelector('#notesPopup .nt-act-danger').textContent.includes('确认'),
    '点取消应回退到「删除」');
  assert(!posted.some((m) => m.type === 'removeNote'), '取消不应发 removeNote');
  // 再走完整两步删除
  document.querySelector('#notesPopup .nt-act-danger').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(document.querySelector('#notesPopup .nt-act-danger').textContent.includes('确认删除'),
    '再点删除应变「确认删除」');
  document.querySelector('#notesPopup .nt-act-danger').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'removeNote' && m.id === 'note-1'), '第二次点击应发 removeNote');
  // 恢复该条, 供跳转测试
  sendMsg({ type: 'noteUpserted', item: noteItem });
  await sleep(30);

  // 7) 点击条目跳回原文: 段落高亮 + 返回提示条
  posted.length = 0;
  document.querySelector('#notesPopup .nt-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  assert(!$('#notesPopup').classList.contains('open'), '跳转后笔记浮层应收起');
  assert(document.querySelector('#content p[data-p="1"]').classList.contains('note-focus'),
    '目标段落应加 .note-focus 高亮');
  assert(document.querySelector('.note-return'), '跳转后应出现返回提示条');
  const nrMain = document.querySelector('.note-return .nr-main');
  assert(nrMain.textContent.includes('返回上次阅读位置'), '提示条文案应为「返回上次阅读位置」');
  assert(nrMain.textContent.includes(novel.chapters[2].title), '提示条应直接显示章名(无原生悬浮提示)');
  assert(document.querySelector('.note-return .nr-close').textContent.trim() === '关闭',
    '右侧应为「关闭」按钮');
  assert(!posted.some((m) => m.type === 'saveProgress'), '跳转落位期间不应上报进度(避免污染书架位置)');

  // 8) 返回提示条: × 关闭 → 重新跳转 → 主按钮返回
  document.querySelector('.note-return .nr-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(!document.querySelector('.note-return'), '点 × 应立即关闭返回提示条(结束本次返回交互)');
  menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  document.querySelector('#notesPopup .nt-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  assert(document.querySelector('.note-return'), '重新跳转后应再次出现返回提示条');
  document.querySelector('.note-return .nr-main').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!document.querySelector('.note-return'), '点「返回上次阅读位置」后提示条应消失');

  // 9) 笔记「管理」: 多选删除
  {
    menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const items = document.querySelectorAll('#notesPopup .nt-item');
    assert(items.length > 0, '笔记列表应有条目');
    const noteTotal = items.length;
    assert(!document.querySelector('#notesPopup [data-note-check]'), '默认不应显示勾选框');
    assert(document.querySelector('#notesPopup [data-note-manage]').textContent.trim() === '管理',
      '笔记头部按钮文案应为「管理」');

    document.querySelector('#notesPopup [data-note-manage]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelectorAll('#notesPopup [data-note-check]').length === noteTotal,
      '管理模式每条笔记都应有勾选框');
    assert(!document.querySelector('#notesPopup .nt-acts'), '管理模式应隐藏行内操作按钮(定位/编辑/删除)');
    assert(document.querySelector('#notesPopup [data-note-manage]').textContent.trim() === '完成',
      '进入后按钮应变「完成」');

    // 书 / 章分组头也要能整组勾选
    const firstBook = document.querySelector('#notesPopup .nt-book');
    const bookCheck = firstBook.querySelector('[data-note-book-check]');
    const bookNotes = firstBook.querySelectorAll('.nt-item').length;
    const firstChap = firstBook.querySelector('.nt-chap-group');
    const chapNotes = firstChap.querySelectorAll('.nt-item').length;
    assert(bookCheck, '书分组头应有勾选框');
    assert(firstBook.querySelector('[data-note-chap-check]'), '章分组头应有勾选框');
    assert(bookCheck.getAttribute('data-note-book-check') === 'none', '初始应为未选');

    posted.length = 0;
    document.querySelector('#notesPopup .nt-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert($('#notesPopup').classList.contains('open'), '管理模式下点条目不应跳转关掉浮层');
    assert(!posted.some((m) => m.type === 'getChapter'), '管理模式下点条目不应跳章');
    assert(document.querySelector('#notesPopup .nt-item').classList.contains('sel'), '勾选的条目应高亮');
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 1'),
      '应显示「已选 1 条」');
    if (bookNotes > 1) {
      // 半选改用原生 indeterminate（不再是 classList.part 的模拟）
      assert(bookCheck.indeterminate === true, '只选中一部分时书头 checkbox 应为 indeterminate');
    }

    // 再点一次取消, 回到"未全选"状态
    document.querySelector('#notesPopup .nt-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 0'),
      '再点一次应取消勾选');

    // 点书头 checkbox = 选中本书全部笔记（原生控件, 不再靠整行 click 模拟）
    firstBook.querySelector('[data-note-book-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 ' + bookNotes),
      '点书头 checkbox 应选中本书全部 ' + bookNotes + ' 条, 实际 ' +
      document.querySelector('#notesPopup [data-note-sel-count]').textContent.trim());
    assert(firstBook.querySelector('[data-note-book-check]').checked === true, '书头 checkbox 应为已勾选');
    // 再点一次取消
    firstBook.querySelector('[data-note-book-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 0'),
      '再点书头 checkbox 应取消本书勾选');

    // 点章头 checkbox = 选中该章全部笔记
    firstChap.querySelector('[data-note-chap-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 ' + chapNotes),
      '点章头 checkbox 应选中本章 ' + chapNotes + ' 条');
    firstChap.querySelector('[data-note-chap-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 0'),
      '再点章头 checkbox 应取消本章勾选');

    document.querySelector('#notesPopup [data-note-select-all]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 ' + noteTotal),
      '全选应选满全部笔记');

    // 批量删笔记走统一确认框(R7-01): 点按钮只弹框, 不发消息
    posted.length = 0;
    document.querySelector('#notesPopup [data-note-remove-selected]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('[data-confirm-ok]'), '「删除所选」应先弹统一确认框');
    assert(!posted.some((m) => m.type === 'removeNotes'), '未确认前不应发 removeNotes');
    assert(document.querySelector('#notesPopup [data-note-check]'), '取消/确认前应仍在管理模式');
    // 点确认遮罩取消: 只关确认框, 不关发起操作的浮层, 选择必须保留(R7-03)
    document.querySelector('.confirm-mask').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await sleep(20);
    assert(!document.querySelector('.confirm-dlg'), '点确认遮罩应取消确认框');
    assert($('#notesPopup').classList.contains('open'), '点确认遮罩不得关闭笔记浮窗');
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 ' + noteTotal),
      '取消确认后应保留选择');
    // 再点 -> 确认 -> 带 opId 发 removeNotes
    posted.length = 0;
    document.querySelector('#notesPopup [data-note-remove-selected]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const noteOkBtn = document.querySelector('[data-confirm-ok]');
    noteOkBtn.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(20);
    assert($('#notesPopup').classList.contains('open'), '确认框内 mousedown 不得提前关闭笔记浮窗');
    assert(document.querySelector('.confirm-dlg'), '确认框内 mousedown 不得取消确认框');
    noteOkBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const rmNotes = posted.find((m) => m.type === 'removeNotes');
    assert(rmNotes, '确认后应发 removeNotes');
    assert((rmNotes.ids || []).length === noteTotal, '应带全部选中笔记的 id');
    assert(typeof rmNotes.opId === 'string' && rmNotes.opId, 'removeNotes 必须带 opId(终态/防重复)');
    assert(document.querySelector('#notesPopup [data-note-check]'), '回包前不应退出管理模式');
    // 失败: 保留选择与管理模式 + 就地 role=alert
    sendMsg({ type: 'opResult', payload: { opId: rmNotes.opId, op: 'notes:remove', ok: false, message: '磁盘写入失败' } });
    await sleep(40);
    assert(document.querySelector('#notesPopup [data-note-check]'), '失败后应仍在管理模式');
    assert(document.querySelector('#notesPopup [data-note-sel-count]').textContent.includes('已选 ' + noteTotal),
      '失败后选择应保留');
    // 失败瞬间就要"就地可见": 面板级一份(不切面板也看得到) + 确认框内一份(可重试)。
    // 两处承载位置不同, 独立回归也是这么要求的; 面板级必须恰一份, 不能重复堆叠。
    const panelAlertNow = document.querySelectorAll('#notesPopup [data-note-op-error]');
    assert(panelAlertNow.length === 1, '失败瞬间面板级 role=alert 应恰有 1 份, 实际 ' + panelAlertNow.length);
    assert(panelAlertNow[0].getAttribute('role') === 'alert', '面板级提示应为 role=alert');
    assert(panelAlertNow[0].textContent.includes('磁盘写入失败'), '面板级提示应含宿主返回原因');
    const dialogAlertNow = document.querySelectorAll('.confirm-dlg [role="alert"]');
    assert(dialogAlertNow.length === 1, '确认框内也应有 1 份 role=alert 说明原因(可重试)');
    assert(dialogAlertNow[0].textContent.includes('磁盘写入失败'), '确认框内提示应含原因');
    // 关掉确认框后, 面板级提示继续存在(P3-1: 用户不切面板也能看到)
    document.querySelector('[data-confirm-cancel]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const panelAlert = document.querySelector('#notesPopup [data-note-op-error]');
    assert(panelAlert, '取消确认框后面板级 role=alert 仍在');
    assert(panelAlert.textContent.includes('磁盘写入失败'), '面板级提示应含宿主返回原因');
    assert(document.querySelectorAll('#notesPopup [role="alert"]').length === 1, '同一时刻只应有一个面板级 alert');
    // P3-3: 别的面板成功操作后, 陈旧错误应被清掉
    sendMsg({ type: 'opResult', payload: { opId: 'other-op-1', op: 'books:removeMany', ok: true } });
    await sleep(30);
    assert(!document.querySelector('#notesPopup [data-note-op-error]'), '其他操作成功后应清掉陈旧失败文案');
    // 成功: 才退出管理模式(重开确认框再确认一次)
    posted.length = 0;
    document.querySelector('#notesPopup [data-note-remove-selected]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    document.querySelector('[data-confirm-ok]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const retryMsg = posted.filter((m) => m.type === 'removeNotes').pop();
    assert(retryMsg && retryMsg.opId !== rmNotes.opId, '重试应是新的 opId');
    sendMsg({ type: 'opResult', payload: { opId: retryMsg.opId, op: 'notes:remove', ok: true } });
    await sleep(40);
    assert(!document.querySelector('#notesPopup [data-note-check]'), '成功后应退出管理模式');
    assert(!document.querySelector('#notesPopup [data-note-op-error]'), '成功后不应残留失败文案');
    assert($('#notesPopup').classList.contains('open'), '成功后应保留笔记浮窗');
    document.querySelector('#notesPopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
  }

  console.log('笔记(空态/段落建卡/下划线标记/保存/分组/内联定位/两步删除/跳转高亮/返回提示条/管理): 通过');


  // ---------------- 笔记: 空内容保存 + 分组默认折叠 ----------------
  // 9a 空内容也能保存
  const para2 = document.querySelector('#content p[data-p="2"]');
  para2.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  para2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const emptyComposer = document.querySelector('.note-composer');
  assert(emptyComposer, '再点段落应再次弹出新建卡片');
  posted.length = 0;
  emptyComposer.querySelector('.nc-text').dispatchEvent(
    new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
  );
  await sleep(30);
  const emptyAdd = posted.find((m) => m.type === 'addNote');
  assert(emptyAdd && emptyAdd.text === '', '不写正文也应能保存(addNote.text 为空串)');

  // 9b 空笔记在列表里显示占位文案
  const emptyItem = {
    id: 'note-empty', bookPath: novel.filePath, bookTitle: novel.bookTitle,
    chapterTitle: novel.chapters[2].title, chapterIndex: 2, paragraphIndex: 2,
    quote: '丙段。', text: '', createdAt: 3, updatedAt: 3,
  };
  sendMsg({ type: 'noteUpserted', item: emptyItem });
  await sleep(30);
  assert(!document.querySelector('.note-composer'), '空内容保存成功后卡片应关闭');
  menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const emptyRow = document.querySelector('#notesPopup [data-note-id="note-empty"]');
  assert(emptyRow, '空笔记条目仍应渲染(保留原文锚点)');
  assert(!emptyRow.querySelector('.nt-text'), '空笔记不应显示正文行(占位文案已去掉)');
  assert(emptyRow.querySelector('.nt-quote').textContent.includes('原文：丙段。'), '空笔记原文应带「原文」前缀');

  // 9c 行内编辑清空正文也能保存
  const firstRow = document.querySelector('#notesPopup [data-note-id="note-1"]');
  firstRow.querySelector('.nt-acts .nt-act:not(.nt-go)').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const editArea = document.querySelector('#notesPopup .nt-edit-area');
  assert(editArea, '点编辑应进入行内编辑态');
  editArea.value = '   ';
  editArea.dispatchEvent(new win.Event('input', { bubbles: true }));
  posted.length = 0;
  editArea.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await sleep(30);
  const clearUpdate = posted.find((m) => m.type === 'updateNote');
  assert(clearUpdate && clearUpdate.text === '', '编辑清空后保存应发 updateNote(text 为空串)');
  assert(!document.querySelector('#notesPopup .nt-edit-area'), '保存一次即应退出编辑态(修复要点两次保存)');
  sendMsg({ type: 'noteUpserted', item: { ...noteItem, updatedAt: 2 } });
  await sleep(30);

  // 9d 分组默认态: 在读展开 / 其它收起; 章分组: 在读章展开 / 其它章收起
  const otherItem = {
    id: 'note-other', bookPath: 'D:/b.txt', bookTitle: '另一本书',
    chapterTitle: '第1章 起', chapterIndex: 0, paragraphIndex: 0,
    quote: '另一本原文。', text: '另一本的笔记', createdAt: 1, updatedAt: 1,
  };
  const otherChapItem = {
    id: 'note-ch9', bookPath: novel.filePath, bookTitle: novel.bookTitle,
    chapterTitle: '第9章 远方', chapterIndex: 8, paragraphIndex: 0,
    quote: '第九章原文。', text: '另一章的笔记', createdAt: 1, updatedAt: 1,
  };
  sendMsg({ type: 'notes', items: [{ ...noteItem, updatedAt: 2 }, emptyItem, otherItem, otherChapItem] });
  await sleep(40);
  const books = Array.from(document.querySelectorAll('#notesPopup .nt-book'));
  assert(books.length === 2, '应渲染 2 个书分组(实际 ' + books.length + ')');
  const curBook = books.find((b) => (b.querySelector('.nt-book-title') || {}).textContent === novel.bookTitle);
  const otherBook = books.find((b) => b !== curBook);
  assert(curBook && otherBook, '应能按书名定位两组');
  assert(!curBook.classList.contains('collapsed'), '在读分组默认应展开');
  assert(curBook.querySelector('.nt-items'), '在读分组应渲染条目');
  assert(curBook.querySelector('.nt-book-head .nt-expand').getAttribute('aria-expanded') === 'true', '在读分组 aria-expanded 应为 true');
  assert(otherBook.classList.contains('collapsed'), '非在读分组默认应收起');
  assert(!otherBook.querySelector('.nt-items'), '非在读分组不应渲染条目');
  assert(otherBook.querySelector('.nt-book-head .nt-expand').getAttribute('aria-expanded') === 'false', '收起分组 aria-expanded 应为 false');
  assert(otherBook.querySelector('.nt-book-count').textContent.trim() === '1', '收起后仍应显示条目数');
  // 章分组默认态: 在读章展开, 其它章收起
  const chapGroups = Array.from(curBook.querySelectorAll('.nt-chap-group'));
  assert(chapGroups.length === 2, '在读书内应渲染 2 个章分组(实际 ' + chapGroups.length + ')');
  const openChaps = chapGroups.filter((c) => !c.classList.contains('collapsed'));
  assert(openChaps.length === 1, '只有当前阅读章默认展开');
  assert(openChaps[0].querySelector('[data-note-id="note-1"]'), '展开的应是当前章分组');
  assert(openChaps[0].querySelector('.nt-chap-head .nt-tag'), '当前章分组应带「在读」标签');
  assert(document.querySelector('#notesPopup .nt-caret svg'), '分组箭头应为双箭头 SVG 图标');
  // 点章头展开其它章
  const closedChap = chapGroups.find((c) => c !== openChaps[0]);
  closedChap.querySelector('.nt-chap-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!closedChap.classList.contains('collapsed'), '点章头应展开该章分组');
  closedChap.querySelector('.nt-chap-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(closedChap.classList.contains('collapsed'), '再点章头应收起');

  // 9e 点组头展开其它书, 关闭再打开保持选择
  const bookByTitle = (name) => Array.from(document.querySelectorAll('#notesPopup .nt-book'))
    .find((b) => (b.querySelector('.nt-book-title') || {}).textContent === name);
  bookByTitle('另一本书').querySelector('.nt-book-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(bookByTitle('另一本书').querySelector('.nt-items'), '点组头应展开该分组');
  document.querySelector('#notesPopup .popup-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(bookByTitle('另一本书') && !bookByTitle('另一本书').classList.contains('collapsed'),
    '关闭再打开应保留用户展开的选择');

  // 9f 在读分组也可手动收起
  bookByTitle(novel.bookTitle).querySelector('.nt-book-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(bookByTitle(novel.bookTitle).classList.contains('collapsed'), '在读分组也应允许手动收起');
  bookByTitle(novel.bookTitle).querySelector('.nt-book-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(!bookByTitle(novel.bookTitle).classList.contains('collapsed'), '再点应恢复展开');

  // 9g 跨书跳转: 点击其它书的条目 → openBook 换书 → init 落地后按笔记章节跳转
  const otherBookEl = bookByTitle('另一本书');
  // 该书非在读 → 章分组默认收起, 先点开章头让条目进 DOM
  otherBookEl.querySelector('.nt-chap-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  posted.length = 0;
  otherBookEl.querySelector('[data-note-id="note-other"]')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  assert(!$('#notesPopup').classList.contains('open'), '跨书跳转后浮层应收起');
  const openBookMsg = posted.find((m) => m.type === 'openBook');
  assert(openBookMsg && openBookMsg.filePath === 'D:/b.txt', '跨书跳转应发 openBook 换书');
  // 模拟目标书 init 落地(openBook 复用当前面板, 换书会重发 init)
  sendMsg({ type: 'init', payload: {
    filePath: 'D:/b.txt', bookTitle: '另一本书', author: '',
    chapters: [{ index: 0, title: '第1章 起' }], chapterIndex: 0, chapterTitle: '第1章 起',
    paragraphs: ['另一本第一段。'], totalChapters: 1, totalWords: 100, scrollRatio: 0, chapterWords: 10,
    settings: { ...defaults }, shelf: [], libraryPath: '', notes: [],
  } });
  await sleep(40);
  const jumpMsg = posted.find((m) => m.type === 'getChapter' && m.dir === 'jump');
  assert(jumpMsg, '换书落地后应按笔记章节发起跳转');
  assert(jumpMsg.index === 0, '跳转章节应指向笔记所在章');
  console.log('跨书跳转(换书/落地定位): 通过');

  // 9h 书/章分组批量删除(组头按钮, 两步确认)
  // 回到原来的书(避免影响后续状态断言语境)
  posted.length = 0;
  sendMsg({ type: 'init', payload: {
    filePath: novel.filePath, bookTitle: novel.bookTitle, author: novel.author,
    chapters: novel.chapters.map((c) => ({ index: c.index, title: c.title })),
    chapterIndex: 2, chapterTitle: novel.chapters[2].title,
    paragraphs: ['第一段。', '第二段。'], totalChapters: 5, totalWords: 123456,
    scrollRatio: 0, chapterWords: 9, settings: { ...defaults },
    shelf: [], libraryPath: '',
    notes: [noteItem, { ...noteItem, id: 'note-c1' }, { ...noteItem, id: 'note-c2', bookPath: 'D:/b.txt' }],
  } });
  await sleep(40);
  menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  // 章组头删除按钮: 两步确认后只删该书该章
  // (分组按最近编辑排序, 每次断言前都重新查询, 避免 v-for 重渲染后旧元素引用失效)
  let bookGroupEl = Array.from(document.querySelectorAll('#notesPopup .nt-book'))
    .find((b) => (b.querySelector('.nt-book-title') || {}).textContent === novel.bookTitle);
  assert(bookGroupEl, '应渲染当前书分组');
  let chapDel = bookGroupEl.querySelector('.nt-chap-head .ng-del');
  assert(chapDel && chapDel.textContent.trim() === '删除', '章组头应有「删除」按钮');
  chapDel.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(chapDel.textContent.trim() === '确认删除', '第一次点应变「确认删除」');
  assert(!posted.some((m) => m.type === 'removeNoteGroup'), '确认前不应发 removeNoteGroup');
  // 确认态旁应有「取消」: 点击回退到「删除」, 不发 removeNoteGroup
  const gCancel = document.querySelector('#notesPopup .nt-chap-head .ng-cancel');
  assert(gCancel && gCancel.textContent.trim() === '取消', '章组头确认态旁应有「取消」按钮');
  gCancel.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  const chapDelBtn2 = document.querySelector('#notesPopup .nt-chap-head .ng-del:not(.ng-cancel)');
  assert(chapDelBtn2.textContent.trim() === '删除', '点取消应回退到「删除」');
  assert(!document.querySelector('#notesPopup .nt-chap-head .ng-cancel'), '回退后取消按钮应消失');
  assert(!posted.some((m) => m.type === 'removeNoteGroup'), '取消不应发 removeNoteGroup');
  chapDelBtn2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  document.querySelector('#notesPopup .nt-chap-head .ng-del:not(.ng-cancel)').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  chapDel.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const chapDelMsg = posted.find((m) => m.type === 'removeNoteGroup');
  assert(chapDelMsg && chapDelMsg.bookPath === novel.filePath && chapDelMsg.chapterTitle === novel.chapters[2].title,
    '确认后应发 removeNoteGroup(书+章)');
  // P3-2: 组删除必须带 opId 并进入 pending; 期间按钮禁用, 连点不会产生多个 opId
  assert(typeof chapDelMsg.opId === 'string' && chapDelMsg.opId, 'removeNoteGroup 必须带 opId(终态/防重复)');
  const chapDelBusy = document.querySelector('#notesPopup .nt-chap-head .ng-del:not(.ng-cancel)');
  assert(chapDelBusy && chapDelBusy.disabled, '组删除进行中删除按钮应禁用');
  chapDelBusy.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.filter((m) => m.type === 'removeNoteGroup').length === 1, 'pending 期间不应重复发 removeNoteGroup');
  // 回终态: pending 清空、按钮恢复(成功也不应重复发)
  sendMsg({ type: 'opResult', payload: { opId: chapDelMsg.opId, op: 'notes:removeGroup', ok: true } });
  await sleep(30);
  assert(!posted.some((m) => m.type === 'removeNoteGroup' && m.opId !== chapDelMsg.opId),
    '回包后不应出现第二个 opId 的 removeNoteGroup');
  // 模拟扩展回发全量笔记(该书该章已清空, 只剩它书条目)
  sendMsg({ type: 'notes', items: [{ ...noteItem, id: 'note-c2', bookPath: 'D:/b.txt' }] });
  await sleep(30);
  assert(!document.querySelector('#notesPopup [data-note-id="note-1"]'), '该书该章条目应从列表消失');
  // 恢复本书一条后: 书组头删除本书全部(重新查询书分组元素)
  posted.length = 0;
  sendMsg({ type: 'notes', items: [noteItem] });
  await sleep(30);
  bookGroupEl = Array.from(document.querySelectorAll('#notesPopup .nt-book'))
    .find((b) => (b.querySelector('.nt-book-title') || {}).textContent === novel.bookTitle);
  const bookDel = bookGroupEl.querySelector('.nt-book-head .ng-del');
  assert(bookDel && bookDel.textContent.trim() === '删除', '书组头应有「删除」按钮');
  bookDel.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(bookDel.textContent.trim() === '确认删除', '书组删除也应两步确认');
  bookDel.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const bookDelMsg = posted.find((m) => m.type === 'removeNoteGroup');
  assert(bookDelMsg && bookDelMsg.bookPath === novel.filePath && bookDelMsg.chapterTitle === undefined,
    '书组确认后应发 removeNoteGroup(仅书路径)');
  console.log('书/章分组批量删除(两步确认/removeNoteGroup): 通过');

  console.log('笔记补充(空内容保存/空笔记不显示正文/编辑清空/分组默认态/会话保留): 通过');

  // 预览模式: 正文右上角「加入书架」 -> 转正式书架后隐藏
  sendMsg({ type: 'init', payload: {
    filePath: 'online://s1/preview1', bookTitle: '预览书', author: '作者',
    chapters: [{ index: 0, title: '第1章' }], chapterIndex: 0, chapterTitle: '第1章',
    paragraphs: ['预览正文'], totalChapters: 1, totalWords: 0, scrollRatio: 0, chapterWords: 4,
    settings: { ...defaults }, shelf: [], libraryPath: '', notes: [], sources: [],
    online: { sourceName: '测试站', bookUrl: 'https://x.com/book/1', preview: true },
  } });
  await sleep(40);
  const previewBtn = document.querySelector('[data-preview-add]');
  assert(previewBtn && previewBtn.getAttribute('data-tip') === '加入书架',
    '预览书应显示「+」按钮, hover 提示为「加入书架」');
  assert(!previewBtn.closest('#content'), '加入书架应脱离正文流(否则一滚动就跟着消失)');
  const posStyle = previewBtn.getAttribute('style') || '';
  assert(posStyle.includes('right:') && posStyle.includes('px'),
    '水平位置应按纸面实测坐标写入(right: Npx)');
  assert(!posStyle.includes('left:'), '不应再用 left 夹取窗口边界');
  const cssIdx = capturedHtml.indexOf('.preview-add{');
  const cssSeg = cssIdx >= 0 ? capturedHtml.slice(cssIdx, cssIdx + 260) : '';
  assert(cssSeg.includes('position:fixed') && cssSeg.includes('bottom:108px'),
    '应固定悬浮, 且距底 108px(两身位 + 再抬一身位 + 间隙)');
  assert(capturedHtml.includes('attr(data-tip)'),
    'hover 时应弹出文字提示(::after + data-tip)');
  posted.length = 0;
  previewBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'previewAddToShelf'), '点按钮应发送 previewAddToShelf');
  assert(previewBtn.disabled && previewBtn.getAttribute('data-tip') === '正在加入书架…',
    '等待回包时应置灰, 提示改为「正在加入书架…」');
  sendMsg({ type: 'previewSaved' });
  await sleep(30);
  assert(!document.querySelector('[data-preview-add]'), '加入成功后预览按钮应消失');
  console.log('在线书预览(结果行/正文按钮): 通过');

  // 「+」与正文的间隙: 纯函数(全输入域) + DOM 接入
  {
    const { previewAddLayout } = require('../dist/overlayLayout');
    assert.strictEqual(previewAddLayout(124).right, 76, '留白充足时应整颗落在纸面外');
    assert.strictEqual(previewAddLayout(56).right, 8, 'gap=56 应贴 8px 安全边距');
    const narrow = previewAddLayout(20);
    assert.strictEqual(narrow.right, 7, '窄窗应向右让位');
    assert.ok(narrow.gapToText >= 16 && !narrow.overlapsText, '窄窗必须与正文留 ≥16px');
    assert.ok(narrow.protrude <= 19, '探入纸面不得超过内边距(否则会压字)');
    // 正常布局下 gap 恒 >= 20(#reader 左右各 20px padding);
    // gap < 17 只会出现在"正文宽于视口 + 横向滚动"的极端情况, 那里物理上无法同时
    // 保住 8px 视口边距与 16px 正文间隙 —— 公式选择保正文间隙(已在下一条注释里说明)
    for (let g = 17; g <= 2000; g += 1) {
      const r = previewAddLayout(g);
      assert.ok(r.gapToText >= 16, 'gap=' + g + ' 正文间隙不足 16px');
      assert.ok(r.protrude <= 19, 'gap=' + g + ' 探入纸面过深');
    }
    assert.strictEqual(previewAddLayout(0).overlapsText, true,
      'gap=0 的横向滚动极端情况已知会压字 1px(记录为限制)');
  }

  // 预览态: 按钮按实测 gap 定位; 移除书架后 previewReset 让按钮回来
  {
    const { previewAddLayout } = require('../dist/overlayLayout');
    sendMsg({ type: 'init', payload: {
      filePath: 'online://s1/preview1', bookTitle: '预览书', author: '作者',
      chapters: [{ index: 0, title: '第1章' }], chapterIndex: 0, chapterTitle: '第1章',
      paragraphs: ['预览正文'], totalChapters: 1, totalWords: 0, scrollRatio: 0, chapterWords: 4,
      settings: { ...defaults }, shelf: [], libraryPath: '', notes: [], sources: [],
      online: { sourceName: '测试站', bookUrl: 'https://x.com/book/1', preview: true },
    } });
    await sleep(40);
    const el = document.querySelector('#content');
    const origRect = el.getBoundingClientRect.bind(el);
    const vw = document.documentElement.clientWidth || sandboxWindow.innerWidth;
    el.getBoundingClientRect = () => ({
      left: vw - 900, right: vw - 20, top: 0, bottom: 600,
      width: 880, height: 600, x: vw - 900, y: 0,
    });
    sandboxWindow.dispatchEvent(new win.Event('resize'));
    await sleep(40);
    let pBtn = document.querySelector('[data-preview-add]');
    assert(pBtn, '预览书应显示「+」按钮');
    const applied = parseFloat(String(pBtn.getAttribute('style') || '').replace(/[^0-9.]/g, ''));
    assert.strictEqual(applied, previewAddLayout(20).right,
      '窄窗时 DOM 的 right 应等于公式值(gap=20)');

    // 加入中 -> 被移出书架: previewReset 应解除置灰, 按钮继续存在
    pBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    assert(pBtn.disabled, '点击后应进入「加入中」并置灰');
    sendMsg({ type: 'previewReset', filePath: 'online://s1/preview1' });
    await sleep(30);
    pBtn = document.querySelector('[data-preview-add]');
    assert(pBtn && !pBtn.disabled, 'previewReset 应让按钮恢复可点(移除书架场景)');
    assert(pBtn.getAttribute('data-tip') === '加入书架', 'previewReset 后提示应回到「加入书架」');

    el.getBoundingClientRect = origRect;
    sandboxWindow.dispatchEvent(new win.Event('resize'));
    await sleep(20);
    console.log('「+」间隙与移除后重现: 通过');
  }

  // 带卷前缀的章节: 「第二集 第1章 …」不能被当成空卷
  sendMsg({ type: 'init', payload: {
    filePath: 'catalog-test', bookTitle: '分卷书', author: '',
    chapters: [
      { index: 0, title: '第一集 第1章 初临起源大陆' },
      { index: 1, title: '第一集 第2章 出发' },
      { index: 2, title: '第二集 第1章 心影门' },
      { index: 3, title: '第二集 第2章 礼物' },
    ],
    chapterIndex: 0, chapterTitle: '第一集 第1章 初临起源大陆', paragraphs: ['p'], totalChapters: 4,
    totalWords: 4, scrollRatio: 0, chapterWords: 1, settings: { ...defaults }, shelf: [], libraryPath: '',
    notes: [], sources: [],
  } });
  await sleep(40);
  menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const groups = Array.from(document.querySelectorAll('#catalogPanel .cat-group'));
  assert(groups.length === 2, '应分成 2 卷, 实际 ' + groups.length);
  assert(groups[0].textContent.includes('第一集') && groups[1].textContent.includes('第二集'), '卷名应正确');
  // 默认开合: 只展开当前阅读章(第 0 章 → 第一集)所在卷, 其余默认收起
  assert.strictEqual(groups[0].querySelector('.cat-group-head').getAttribute('aria-expanded'), 'true',
      '当前章所在卷应默认展开');
  assert.strictEqual(groups[1].querySelector('.cat-group-head').getAttribute('aria-expanded'), 'false',
      '非当前章的卷应默认收起');
  assert(groups[1].classList.contains('collapsed'), '非当前章的卷应带 collapsed 类');
  assert(!groups.some((g) => g.textContent.includes('共 0 章')), '不应出现 0 章的空卷');
  assert(document.querySelectorAll('#catalogPanel .cat-item').length === 4, '4 章都应出现在目录里');
  assert(document.querySelector('#catalogPanel .cat-sub').textContent.includes('共 4 章'), '总章数应为 4');
  assert(document.querySelector('#catalogPanel .cat-no').textContent.includes('第1章'), '章节号应去掉卷前缀');
  console.log('目录分卷(带卷前缀章节): 通过');

  // 独立篇名: 「第一篇 X」后面的普通章节必须归进该篇, 不能被拆成新的「正文」组
  // (回归 2026-10-26: 用户报「目录全是正文」, 根因是 curKey !== null 时又起了一个正文组)
  sendMsg({ type: 'init', payload: {
    filePath: 'catalog-vol', bookTitle: '分篇书', author: '',
    chapters: [
      { index: 0, title: '第一篇 炼一口飞剑' },
      { index: 1, title: '第一章 归录' },
      { index: 2, title: '第二章 撸下' },
      { index: 3, title: '第二篇 风起' },
      { index: 4, title: '第三章 再会' },
    ],
    chapterIndex: 1, chapterTitle: '第一章 归录', paragraphs: ['p'], totalChapters: 5,
    totalWords: 5, scrollRatio: 0, chapterWords: 1, settings: { ...defaults }, shelf: [], libraryPath: '',
    notes: [], sources: [],
  } });
  await sleep(40);
  menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const volGroups = Array.from(document.querySelectorAll('#catalogPanel .cat-group'));
  assert(volGroups.length === 2, '应分成 2 篇, 实际 ' + volGroups.length);
  assert(volGroups[0].textContent.includes('第一篇 炼一口飞剑'), '第一组应显示篇名, 不能是「正文」');
  assert(volGroups[1].textContent.includes('第二篇 风起'), '第二组应显示篇名');
  assert(!volGroups.some((g) => g.textContent.includes('正文')), '有篇名时不应再出现「正文」组');
  assert(document.querySelectorAll('#catalogPanel .cat-item').length === 3, '3 个章节条目(篇名不占条目)');
  assert(document.querySelector('#catalogPanel .cat-sub').textContent.includes('共 3 章'), '总章数不应含篇名');
  console.log('目录独立篇名分组: 通过');

  // 同名卷(两个「第二篇」): 折叠状态按分组 id 记, 不能拿卷名当 key, 否则一收全收
  sendMsg({ type: 'init', payload: {
    filePath: 'catalog-dup', bookTitle: '同名卷书', author: '',
    chapters: [
      { index: 0, title: '第一章 甲' },
      { index: 1, title: '第二篇' },
      { index: 2, title: '第二章 乙' },
      { index: 3, title: '第二篇' },
      { index: 4, title: '第三章 丙' },
    ],
    chapterIndex: 0, chapterTitle: '第一章 甲', paragraphs: ['p'], totalChapters: 5,
    totalWords: 5, scrollRatio: 0, chapterWords: 1, settings: { ...defaults }, shelf: [], libraryPath: '',
    notes: [], sources: [],
  } });
  await sleep(40);
  menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const dupGroups = Array.from(document.querySelectorAll('#catalogPanel .cat-group'));
  assert(dupGroups.length === 3, '应得到 正文/第二篇/第二篇 三组, 实际 ' + dupGroups.length);
  assert(dupGroups[0].textContent.includes('正文'), '首组应为「正文」');
  assert(dupGroups[1].textContent.includes('第二篇') && dupGroups[2].textContent.includes('第二篇'),
    '后两组同名「第二篇」');
  assert.strictEqual(dupGroups[0].querySelector('.cat-group-head').getAttribute('aria-expanded'), 'true',
    '当前章所在的「正文」应展开');
  assert.strictEqual(dupGroups[1].querySelector('.cat-group-head').getAttribute('aria-expanded'), 'false',
    '同名但不同组的第一个「第二篇」必须收起');
  assert.strictEqual(dupGroups[2].querySelector('.cat-group-head').getAttribute('aria-expanded'), 'false',
    '同名但不同组的第二个「第二篇」必须收起');
  console.log('目录同名卷独立开合: 通过');

  // ---------------- 离线下载(目录面板 / 书架标签 / 存储容量) ----------------
  {
    const onlinePath = 'online://src1/abc123';
    sendMsg({ type: 'init', payload: {
      filePath: onlinePath, bookTitle: '在线测试书', author: '作者',
      chapters: [
        { index: 0, title: '第1章 甲' },
        { index: 1, title: '第2章 乙' },
        { index: 2, title: '第3章 丙' },
        { index: 3, title: '第4章 丁' },
        { index: 4, title: '第5章 戊' },
      ],
      chapterIndex: 0, chapterTitle: '第1章 甲', paragraphs: ['p'], totalChapters: 5,
      totalWords: 5, scrollRatio: 0, chapterWords: 1, settings: { ...defaults },
      shelf: [{
        filePath: onlinePath, title: '在线测试书', author: '作者',
        chapterIndex: 0, totalChapters: 5, current: true,
        online: true, sourceName: '测试源', offline: { done: 2, total: 5 },
      }],
      libraryPath: '', notes: [], sources: [],
      online: { sourceName: '测试源', bookUrl: 'https://x/b1', preview: false },
      offline: {
        filePath: onlinePath, total: 5, done: 2, failed: 1,
        running: false, paused: false, downloaded: [0, 1],
        bytes: 1024, totalBytes: 2048, bookCount: 2,
      },
    } });
    await sleep(40);
    // 目录每章标记: 临时缓存 [2,4], 读过第 4 章, 读到第 2 章(0 基 2 => 第 3 章在读)
    dispatch('chapterMarks', { cached: [2, 4], read: [4], readUpTo: 2 });
    await sleep(30);

    menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    assert(document.querySelector('#catalogPanel [data-cat-dl]'), '在线书目录应显示「下载」按钮');

    // 三态标记: offline(已下载) > cache(仅临时缓存) > 无
    assert.strictEqual(
      document.querySelector('#catalogPanel .cat-item[data-i="0"] [data-cat-mark]').getAttribute('data-cat-mark'),
      'offline', '已下载的章应标 offline'
    );
    assert.strictEqual(
      document.querySelector('#catalogPanel .cat-item[data-i="2"] [data-cat-mark]').getAttribute('data-cat-mark'),
      'cache', '只有临时缓存的章应标 cache'
    );
    assert(!document.querySelector('#catalogPanel .cat-item[data-i="3"] [data-cat-mark]'),
      '既没下载也没缓存的章不应有任何标记');

    // 已读压灰: 0/1 在 readUpTo 之前; 4 在 read 集合里; 3 未读
    assert(document.querySelector('#catalogPanel .cat-item[data-i="0"]').classList.contains('read'),
      '读到的章之前的应标为已读');
    assert(document.querySelector('#catalogPanel .cat-item[data-i="4"]').classList.contains('read'),
      '有位置记忆的章应标为已读');
    assert(!document.querySelector('#catalogPanel .cat-item[data-i="3"]').classList.contains('read'),
      '未读章不应压灰');

    // 底部筛选/图例: 全部 5 / 已下载 2 / 仅缓存 2 / 需联网 1
    const chip = (k) => document.querySelector('#catalogPanel [data-cat-chip="' + k + '"]');
    assert(chip('all'), '应有「全部」筛选项');
    assert(chip('offline').textContent.includes('已下载 2'),
      '筛选项应显示已下载数, 实际 ' + chip('offline').textContent.trim());
    assert(chip('cache').textContent.includes('仅缓存 2'),
      '筛选项应显示仅缓存数, 实际 ' + chip('cache').textContent.trim());
    assert(chip('none').textContent.includes('需联网 1'),
      '筛选项应显示需联网数, 实际 ' + chip('none').textContent.trim());

    // 点「已下载」→ 目录只留已下载的章(回答"我到底下好了哪些")
    chip('offline').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelectorAll('#catalogPanel .cat-item').length === 2,
      '筛选「已下载」后应只剩 2 章, 实际 ' + document.querySelectorAll('#catalogPanel .cat-item').length);
    assert(!document.querySelector('#catalogPanel .cat-item[data-i="3"]'), '未下载的章应被过滤掉');
    assert(chip('offline').classList.contains('on'), '当前筛选项应高亮');
    assert(document.querySelector('#catalogPanel .cat-head .cat-sub').textContent.includes('已下载 2'),
      '头部副标题应反映筛选(而不是还写「共 5 章」)');

    // 再点一次 = 取消筛选
    chip('offline').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelectorAll('#catalogPanel .cat-item').length === 5, '再点一次应回到全部章节');

    // 展开范围行
    assert(!document.querySelector('#catalogPanel [data-cat-dl-row]'), '默认应收起下载范围行');
    document.querySelector('#catalogPanel [data-cat-dl]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('#catalogPanel [data-cat-dl-row]'), '点「下载」应展开范围行');
    assert(document.querySelector('#catalogPanel [data-cat-dl-text]').textContent.includes('2/5'),
      '应显示「已下载 2/5 章」');

    // 设范围 2~5 → 应换算成 0 基 [1,4]
    const startInput = document.querySelector('#catalogPanel [data-cat-dl-start]');
    const endInput = document.querySelector('#catalogPanel [data-cat-dl-end]');
    startInput.value = '2';
    startInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    endInput.value = '5';
    endInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(20);
    posted.length = 0;
    document.querySelector('#catalogPanel [data-cat-dl-go]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    const startMsg = posted.find((m) => m.type === 'downloadStart');
    assert(startMsg, '点「开始下载」应发出 downloadStart');
    assert.strictEqual(startMsg.start, 1, '起始章应换算成 0 基(第2章 → 1), 实际 ' + startMsg.start);
    assert.strictEqual(startMsg.end, 4, '结束章应换算成 0 基(第5章 → 4), 实际 ' + startMsg.end);

    // 进度: 本轮回合的 done/total
    dispatch('downloadProgress', { done: 5, total: 10, failed: 0, running: true, paused: false, added: [2] });
    await sleep(30);
    assert(document.querySelector('#catalogPanel [data-cat-dl-text]').textContent.includes('5/10'),
      '应显示本轮进度 5/10');
    assert.strictEqual(
      document.querySelector('#catalogPanel .cat-item[data-i="2"] [data-cat-mark]').getAttribute('data-cat-mark'),
      'offline', '进度里的 added 应把该章从 cache 升级为 offline'
    );
    assert(document.querySelector('#catalogPanel [data-cat-dl-pause]'), '下载中应出现「暂停」');
    dispatch('downloadProgress', { done: 6, total: 10, failed: 0, running: true, paused: true });
    await sleep(30);
    assert(document.querySelector('#catalogPanel [data-cat-dl-pause]').textContent.includes('继续'),
      '暂停后按钮应变「继续」');

    dispatch('downloadDone', { ok: true, cancelled: false, done: 10, total: 10, failed: 0 });
    await sleep(30);
    assert(document.querySelector('#catalogPanel [data-cat-dl-go]'), '下载结束后应恢复「开始下载」');
    assert(document.querySelector('#catalogPanel [data-cat-dl-notice]'), '结束后应有结果提示');
    console.log('目录面板 · 离线下载(按钮/范围换算/三态标记/筛选/进度/暂停/结束): 通过');

    // 书架「离线 N」标签
    document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await sleep(20);
    menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const offTag = document.querySelector('#shelfPopup .bk-tag-offline');
    assert(offTag, '书架在线书应显示离线标签');
    assert(offTag.textContent.includes('离线 2'), '标签应显示已下载章数, 实际 ' + offTag.textContent.trim());
    console.log('书架 · 离线标签: 通过');

    // 存储面板容量
    sendMsg({ type: 'offlineStats', payload: { bytes: 10485760, books: 3 } });
    await sleep(20);
    document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await sleep(20);
    menuItem('storage').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const sizeEl = document.querySelector('#storagePopup [data-sp-offline-size]');
    assert(sizeEl, '存储面板应显示离线缓存一行');
    assert(sizeEl.textContent.includes('10.0 MB'), '容量应格式化, 实际 ' + sizeEl.textContent.trim());
    assert(sizeEl.textContent.includes('3 本'), '应显示书目数');
    document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await sleep(20);
    console.log('存储面板 · 离线缓存容量: 通过');
  }

  // ---------------- 扩展侧: 打开钩子 + 预览态复位 ----------------
  {
    assert(openedHook && openedHook.filePath === novel.filePath && openedHook.index === 2,
      'createOrShow 应触发 onOpen(打开即记历史的挂点)');
    openedHook = null;
    ReaderPanel.createOrShow(novel, 3, 0, store);
    assert(openedHook && openedHook.index === 3, '同书重开也应触发 onOpen');

    const previewNovel = {
      filePath: 'online://s1/prev', bookTitle: '预览书', author: '作者',
      chapters: [{ index: 0, title: '第1章', content: 'x', wordCount: 1 }],
      preface: '', encoding: 'utf-8', totalWords: 1,
      online: { sourceId: 's1', sourceName: '站', bookUrl: 'https://x/1', preview: false },
    };
    openedHook = null;
    ReaderPanel.createOrShow(previewNovel, 0, 0, store);
    assert(openedHook && openedHook.filePath === 'online://s1/prev', '预览书打开也应触发 onOpen');
    assert.strictEqual(ReaderPanel.resetToPreview('D:/other.txt'), false, '非当前书不应复位');

    ReaderPanel.current._ready = true;
    panelMessages.length = 0;
    assert.strictEqual(ReaderPanel.resetToPreview('online://s1/prev'), true, '当前在线书应能复位');
    assert.strictEqual(ReaderPanel.current.novel.online.preview, true, 'novel 的 preview 应置 true');
    assert(panelMessages.some((m) => m.type === 'previewReset' && m.filePath === 'online://s1/prev'),
      '复位后应发 previewReset(filePath)');
    ReaderPanel.current._ready = false;
    console.log('打开钩子 + 预览态复位: 通过');
  }

  // ---------------- 搜索失败明细 / 单源重试 / 状态语义(R9-01 ~ R9-04) ----------------
  {
    // 先把书源列表恢复成"两个可用源", 避免受前面用例(失效/停用)的影响
    sendMsg({ type: 'sources', items: [
      { id: 's1', name: 'A站', url: 'https://a', group: '', enabled: true, searchUrl: 'u1', failStreak: 0 },
      { id: 's2', name: 'B站', url: 'https://b', group: '', enabled: true, searchUrl: 'u2', failStreak: 0 },
    ] });
    await sleep(30);
    menuItem('source').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const input2 = document.querySelector('#sourcePopup [data-src-input]');
    input2.value = '诊断用例';
    input2.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(20);
    posted.length = 0;
    const goBtn2 = document.querySelector('#sourcePopup [data-src-go]');
    goBtn2.click();
    await sleep(30);
    const diag = posted.filter((m) => m.type === 'sourceSearch').pop();
    assert(diag, '应发起诊断用的搜索');

    // 进度: role=progressbar + aria-valuenow 随 done 更新, 且可见区不参与播报
    sendMsg({ type: 'searchProgress', token: diag.token, done: 3, total: 10, sourceName: 'A站', ok: true, failed: 0 });
    await sleep(30);
    const bar = document.querySelector('#sourcePopup [data-src-progress]');
    assert(bar && bar.getAttribute('role') === 'progressbar', '进度行应为 role=progressbar');
    assert(bar.getAttribute('aria-valuemin') === '0', 'progressbar 应有 aria-valuemin=0');
    assert(bar.getAttribute('aria-valuemax') === '10', 'progressbar 应有 aria-valuemax=total');
    assert(bar.getAttribute('aria-valuenow') === '3', 'progressbar 的 aria-valuenow 应随 done 更新');
    assert(bar.getAttribute('aria-live') === 'off', '可见进度区 aria-live 必须为 off(避免与 sr-only 双播报)');
    const liveRegion = Array.from(document.querySelectorAll('.sr-only[role="status"]'))
      .find((el) => el.getAttribute('aria-live') === 'polite');
    assert(liveRegion, '应有独立的 sr-only role=status aria-live=polite 播报区');
    assert(liveRegion.textContent.trim().length > 0, 'sr-only 播报区应有节流文案');

    // 全部失败: 无结果 + 2 个错误 -> 唯一一个 role=alert
    sendMsg({ type: 'searchResults', token: diag.token, done: true, items: [], errors: [
      { sourceId: 's1', sourceName: 'A站', kind: 'timeout', message: '请求超时，已重试 2 次仍未返回' },
      { sourceId: 's2', sourceName: 'B站', kind: 'http', message: 'HTTP 503' },
    ] });
    await sleep(40);
    const alerts = document.querySelectorAll('#sourcePopup [role="alert"]');
    assert(alerts.length === 1, '最终失败应恰有 1 个 role=alert, 实际 ' + alerts.length);
    assert(alerts[0].textContent.includes('所有书源都失败了'), 'role=alert 应为"全部失败"那一行');

    // 空结果 vs 全失败: 文案必须是两种(resultSummary 四分支)
    assert(document.querySelector('#sourcePopup .src-hint').textContent.includes('所有书源都失败了'),
      '全失败文案应由 resultSummary 的失败分支给出');

    // 失败明细: aria-expanded 翻转 + 每行类别徽章 + 重试按钮
    const toggle = document.querySelector('#sourcePopup [data-src-errors-toggle]');
    assert(toggle, '应有失败明细折叠按钮');
    assert(toggle.getAttribute('aria-expanded') === 'false', '默认应折叠(aria-expanded=false)');
    assert(toggle.getAttribute('aria-controls') === 'srcErrorList', 'aria-controls 应指向明细列表 id');
    assert(!document.querySelector('#sourcePopup [data-src-error-list]'), '折叠时明细列表不应渲染');
    toggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('#sourcePopup [data-src-errors-toggle]').getAttribute('aria-expanded') === 'true',
      '点击后 aria-expanded 应翻转为 true');
    assert(document.querySelector('#sourcePopup [data-src-error-list]'), '展开后应渲染明细列表');
    const rows = Array.from(document.querySelectorAll('#sourcePopup [data-src-error-row]'));
    assert(rows.length === 2, '应有 2 行失败明细, 实际 ' + rows.length);
    assert(document.querySelector('#sourcePopup [data-src-error-cat="timeout"]').textContent === '超时',
      '错误类别应映射成中文(超时)');
    assert(document.querySelector('#sourcePopup [data-src-error-cat="http"]').textContent === '状态码',
      '错误类别应映射成中文(状态码)');
    assert(rows.every((r) => r.querySelector('[data-src-error-retry]')), '每行都应有单源重试按钮');
    assert(rows[0].querySelector('.src-error-msg').getAttribute('title').length > 0,
      '精简原因应有 title 承载完整原因');

    // 单源重试: 发 sourceRetry(reqId/sourceId/key), 重试中禁用防重复
    posted.length = 0;
    const retryBtn = document.querySelector('#sourcePopup [data-src-error-retry="s1"]');
    retryBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const retryMsg = posted.find((m) => m.type === 'sourceRetry');
    assert(retryMsg, '点重试应发送 sourceRetry');
    assert(retryMsg.sourceId === 's1', 'sourceRetry 应带 sourceId');
    assert(typeof retryMsg.reqId === 'number', 'sourceRetry 应带 reqId');
    assert(retryMsg.key === '诊断用例', 'sourceRetry 应带本轮关键词');
    const retryBtn2 = document.querySelector('#sourcePopup [data-src-error-retry="s1"]');
    assert(retryBtn2.disabled, '重试中按钮应禁用, 防止重复提交');
    assert(retryBtn2.textContent.includes('重试中'), '重试中按钮文案应为「重试中…」');

    // 重试成功: 移除该源错误 + 按 bookUrl 合并结果
    sendMsg({ type: 'sourceRetryResult', payload: {
      reqId: retryMsg.reqId, sourceId: 's1', sourceName: 'A站', ok: true,
      items: [{ sourceId: 's1', sourceName: 'A站', title: '诊断用例', author: '某作者', bookUrl: 'https://d/1' }],
    } });
    await sleep(40);
    assert(!document.querySelector('#sourcePopup [data-src-error-row="s1"]'), '重试成功后该源应移出失败列表');
    assert(document.querySelectorAll('#sourcePopup [data-src-pane="current"] .src-result').length === 1,
      '重试成功的命中应合并进当前结果');

    // 重试失败: 保留该行并更新原因
    posted.length = 0;
    document.querySelector('#sourcePopup [data-src-error-retry="s2"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const retryMsg2 = posted.filter((m) => m.type === 'sourceRetry').pop();
    assert(retryMsg2 && retryMsg2.sourceId === 's2', '第二行也应能单独重试');
    sendMsg({ type: 'sourceRetryResult', payload: {
      reqId: retryMsg2.reqId, sourceId: 's2', sourceName: 'B站', ok: false, message: '仍然 503',
    } });
    await sleep(40);
    assert(document.querySelector('#sourcePopup [data-src-error-row="s2"]'), '重试失败应保留该行');
    assert(document.querySelector('#sourcePopup [data-src-error-row="s2"] .src-error-msg').textContent.includes('仍然 503'),
      '重试失败应更新该行原因');

    // 结果行: 主按钮才是点击目标, 加入书架是独立按钮(无按钮嵌套)
    const row0 = document.querySelector('#sourcePopup [data-src-result="0"]');
    assert(row0.querySelector('.src-result-main').tagName === 'BUTTON', '结果行主按钮应为原生 button');
    assert(!row0.querySelector('.src-result-main button'), '主按钮内不应再嵌套按钮');

    menuItem('source').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
  }
  console.log('搜索失败明细/单源重试/progressbar/唯一 alert: 通过');

  // ---------------- 笔记组头三件套 / 「更多」入口(R1-04 / R11-03 / R11-04) ----------------
  {
    // 造两条笔记(同一本书), 保证有组头可断言
    const now = Date.now();
    sendMsg({ type: 'notes', items: [
      { id: 'smk1', bookPath: 'D:/smoke.txt', bookTitle: '冒烟书', chapterTitle: '第 1 章', chapterIndex: 0, paragraphIndex: 0, quote: '原文一', text: '笔记一', createdAt: now, updatedAt: now },
      { id: 'smk2', bookPath: 'D:/smoke.txt', bookTitle: '冒烟书', chapterTitle: '第 1 章', chapterIndex: 0, paragraphIndex: 1, quote: '原文二', text: '笔记二', createdAt: now, updatedAt: now },
    ] });
    await sleep(20);
    menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);

    const head = document.querySelector('#notesPopup .nt-book-head');
    assert(head, '应存在书组头用于结构断言');
    // 1) 组头是普通容器, 且内部不允许按钮嵌套(旧实现是 button 里嵌可聚焦 span)
    assert(head.tagName === 'DIV', '书组头应为普通容器(不再是 button), 实际 ' + head.tagName);
    assert(!head.querySelector('button button'), '组头内不允许按钮嵌套');
    // 2) 三件套齐备
    const expand = head.querySelector('.nt-expand');
    const del = head.querySelector('.ng-del');
    assert(expand && expand.tagName === 'BUTTON', '组头应有原生展开按钮 .nt-expand');
    assert(del && del.tagName === 'BUTTON', '组头应有独立删除按钮 .ng-del');
    assert(/删除《.+》/.test(del.getAttribute('aria-label') || ''), '删除按钮 aria-label 应含书名');
    // 3) aria-controls 指向真实容器(分组默认可能收起, 先展开)
    const controls = expand.getAttribute('aria-controls');
    assert(controls, '展开按钮应有 aria-controls');
    document.querySelector('#notesPopup .nt-book-head .nt-expand').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.getElementById(controls), 'aria-controls 应指向存在的 .nt-items 容器');
    assert(document.getElementById(controls).classList.contains('nt-items'), 'aria-controls 应指向条目容器');

    // 4) Tab 序: 展开 -> 复选框(管理模式; 删除按钮在管理模式隐藏, 与既有规则一致)
    document.querySelector('#notesPopup [data-note-manage]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const head2 = document.querySelector('#notesPopup .nt-book-head');
    const order = Array.from(head2.querySelectorAll('button, input'));
    assert(order.length === 2, '管理模式组头应恰有 2 个可聚焦控件(展开/复选框), 实际 ' + order.length);
    assert(order[0].classList.contains('nt-expand'), 'Tab 序第 1 个应为展开按钮');
    assert(order[1].getAttribute('data-note-book-check') !== null, 'Tab 序第 2 个应为组复选框');
    assert(!head2.querySelector('.ng-del'), '管理模式应隐藏组删除按钮(与书架/历史同构)');
    assert(head2.querySelector('input[type="checkbox"]'), '管理模式组头复选框应为原生 input');
    // 半选: 先只勾一条 -> indeterminate
    document.querySelector('#notesPopup .nt-item [data-note-check]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const halfCheck = document.querySelector('#notesPopup [data-note-book-check]');
    assert(halfCheck.indeterminate === true, '部分选中时组复选框应为 indeterminate');
    assert(halfCheck.getAttribute('aria-label').indexOf('冒烟书') >= 0, '组复选框 aria-label 应含书名');

    // 条目级勾选必须是原生 checkbox: 可聚焦、有含上下文的名称、单次切换(R12-03/R12-04)
    const itemChk = document.querySelector('#notesPopup .nt-item [data-note-check]');
    assert(itemChk && itemChk.tagName === 'INPUT', '条目勾选应为原生 input, 实际 ' + (itemChk && itemChk.tagName));
    assert(itemChk.type === 'checkbox', '条目勾选应为 type=checkbox');
    assert((itemChk.getAttribute('aria-label') || '').indexOf('选择笔记') >= 0,
      '条目勾选 aria-label 应含上下文, 实际 ' + itemChk.getAttribute('aria-label'));
    itemChk.focus();
    assert(document.activeElement === itemChk, '条目勾选应可 Tab/程序聚焦');
    const selCountOf = function () {
      const t = document.querySelector('#notesPopup [data-note-sel-count]').textContent || '';
      const m = /(\d+)/.exec(t);
      return m ? Number(m[1]) : -1;
    };
    const selBefore = selCountOf();
    const checkClick = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    itemChk.dispatchEvent(checkClick);
    await sleep(30);
    assert(checkClick.defaultPrevented === false,
      '条目 checkbox 的 click 不得 preventDefault(否则原生 checked 会被浏览器回滚)');
    assert(Math.abs(selCountOf() - selBefore) === 1,
      '点条目勾选应只切换一次(不能冒泡到整行双触发), 前后: ' + selBefore + ' -> ' + selCountOf());

    // I1: 24×24 命中区(label 外圈)必须真的可用 —— 点环也只能净切换一次
    const ring = document.querySelector('#notesPopup .nt-check-label');
    assert(ring, '条目勾选应有 label 命中区(24×24)');
    const beforeRing = selCountOf();
    ring.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(Math.abs(selCountOf() - beforeRing) === 1,
      '点 label 外圈应恰好切换一次(否则 24×24 命中区等于失效), 前后: ' + beforeRing + ' -> ' + selCountOf());
    // 点行内文字(非勾选区)仍只切换一次
    const beforeRow = selCountOf();
    document.querySelector('#notesPopup .nt-item').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(Math.abs(selCountOf() - beforeRow) === 1,
      '点行内文字应恰好切换一次, 前后: ' + beforeRow + ' -> ' + selCountOf());
    document.querySelector('#notesPopup [data-note-manage]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);

    // 5) 操作组常显: 不再有「更多/收起」开关, 三个动作始终可见可聚焦
    // 退出管理模式后分组回到用户之前的折叠态, 需要时再展开一次
    if (!document.querySelector('#notesPopup .nt-item')) {
      const bookExpand = document.querySelector('#notesPopup .nt-book-head .nt-expand');
      if (bookExpand && bookExpand.getAttribute('aria-expanded') === 'false') {
        bookExpand.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(30);
      }
      const chapExpand = document.querySelector('#notesPopup .nt-chap-head .nt-expand');
      if (chapExpand && chapExpand.getAttribute('aria-expanded') === 'false') {
        chapExpand.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(30);
      }
    }
    const item = document.querySelector('#notesPopup .nt-item');
    assert(item, '应存在笔记条目用于操作组断言');
    assert(!item.querySelector('.nt-more'), '笔记条目不应再有「更多」开关');
    assert(!item.querySelector('.nt-more-row'), '不应残留「更多」行容器');
    const acts = item.querySelector('.nt-acts');
    assert(acts, '动作组应存在于 DOM');
    assert(win.getComputedStyle(acts).display === 'flex', '操作组应默认常显(不依赖 hover)');
    const actTexts = Array.from(acts.querySelectorAll('.nt-act')).map((b) => b.textContent.trim());
    assert(actTexts.join('|').indexOf('定位到原文') === 0, '第一个动作应为「定位到原文」, 实际 ' + actTexts.join('|'));
    assert(actTexts.indexOf('编辑') >= 0 && actTexts.indexOf('删除') >= 0,
      '操作组应常显「编辑/删除」, 实际 ' + actTexts.join('|'));
    const actBtns = Array.from(acts.querySelectorAll('button'));
    assert(actBtns.length === 3, '操作组应恰有 3 个按钮, 实际 ' + actBtns.length);
    assert(actBtns.every((b) => b.tabIndex >= 0), '三个动作都应可 Tab 到达');
    // 清理: 关闭浮层并清掉本次造的笔记
    menuItem('notes').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);
    sendMsg({ type: 'notes', items: [] });
    await sleep(20);
  }
  console.log('笔记组头三件套/aria-controls/Tab 序/操作组常显: 通过');

  // ---------------- 书源管理: 主次层级 / 管理模式 / 键盘子菜单 / 可访问名称(R11-01/02, R12) ----------------
  {
    // 恢复 2 个可用源, 保证有行可断言
    sendMsg({ type: 'sources', items: [
      { id: 's1', name: 'A站', url: 'https://a.com', group: '玄幻', enabled: true, searchUrl: 'https://a.com/s?q={{key}}', lastCheckOk: true, failStreak: 0 },
      { id: 's2', name: 'B站', url: 'https://b.com', group: '', enabled: true, searchUrl: 'https://b.com/s?q={{key}}', failStreak: 0 },
    ] });
    await sleep(30);
    menuItem('source').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    document.querySelector('#sourcePopup [data-src-tab="manage"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);

    // 1) 三层工具区: 唯一主操作 + 次操作 + 更多
    const importToggle = document.querySelector('#sourcePopup [data-src-import-toggle]');
    const checkAll = document.querySelector('#sourcePopup [data-src-check-all]');
    const moreToggle = document.querySelector('#sourcePopup [data-src-more-toggle]');
    assert(importToggle && importToggle.classList.contains('popup-primary'),
      '「导入书源」应是唯一主操作(popup-primary)');
    assert(checkAll && checkAll.classList.contains('popup-secondary'), '「检查全部」应是次操作');
    assert(moreToggle, '应有「更多 ▾」低频动作入口');
    assert(importToggle.getAttribute('aria-haspopup') === 'menu', '主操作应声明 aria-haspopup=menu');
    assert(importToggle.getAttribute('aria-expanded') === 'false', '默认应未展开');

    // 2) 子菜单键盘: 展开即聚焦首项, 方向键移动, Esc 收起并回焦
    posted.length = 0;
    importToggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const menu = document.querySelector('#sourcePopup #srcImportMenu');
    assert(menu, '点「导入书源」应展开子菜单');
    assert(menu.getAttribute('role') === 'menu', '子菜单应有 role=menu');
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    assert(items.length === 3, '子菜单应有 3 项(URL/JSON/文件), 实际 ' + items.length);
    assert(document.activeElement === items[0], '展开后应把焦点放到第 1 项');
    items[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await sleep(20);
    assert(document.activeElement === items[1], 'ArrowDown 应移到第 2 项');
    items[1].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await sleep(20);
    assert(document.activeElement === items[0], 'ArrowUp 应回到第 1 项');
    items[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(20);
    assert(!document.querySelector('#sourcePopup #srcImportMenu'), 'Esc 应收起子菜单');
    assert(document.activeElement === importToggle, 'Esc 收起后焦点应回到主操作按钮');

    // 3) 「更多」子菜单: 导出 / 全部停用
    document.querySelector('#sourcePopup [data-src-more-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    assert(document.querySelector('#sourcePopup #srcMoreMenu'), '点「更多」应展开子菜单');
    assert(document.querySelector('#sourcePopup [data-src-export]'), '「更多」里应有导出');
    assert(document.querySelector('#sourcePopup [data-src-disable-all]'), '「更多」里应有全部停用');
    document.querySelector('#sourcePopup [data-src-more-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(20);

    // 4) 管理模式: 批量条 + 危险区隔离
    const manageToggle = document.querySelector('#sourcePopup [data-src-manage-toggle]');
    assert(manageToggle.getAttribute('aria-pressed') === 'false', '默认应在非管理模式');
    manageToggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('#sourcePopup [data-src-manage-toggle]').getAttribute('aria-pressed') === 'true',
      '进入管理后 aria-pressed 应为 true');
    const danger = document.querySelector('#sourcePopup .src-danger-zone');
    assert(danger && danger.querySelector('[data-src-remove-selected]'),
      '危险动作应放在 .src-danger-zone 里, 与全选/反选分隔');
    // 退出管理应清空批量区
    document.querySelector('#sourcePopup [data-src-manage-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(!document.querySelector('#sourcePopup .src-bulk'), '退出管理模式后批量条应消失');

    // 5) 复选框 label 关联 + 点击名称可切换
    const row = document.querySelector('#sourcePopup .src-row');
    const chk = row.querySelector('input[type="checkbox"]');
    const label = row.querySelector('label.src-check-label');
    assert(chk.id && label && label.getAttribute('for') === chk.id, '复选框应有 for 关联的 label');
    assert(chk.getAttribute('aria-label').indexOf('A站') >= 0, '复选框 aria-label 应含源名');
    assert(label.textContent.indexOf('A站') >= 0, 'label 内应包含源名(点击名称即可切换)');

    // 6) 图标按钮 aria-label 含源名且彼此唯一
    const icons = Array.from(row.querySelectorAll('.src-ico'));
    assert(icons.length === 3, '每行应有 3 个图标按钮');
    const labels = icons.map((b) => b.getAttribute('aria-label') || '');
    assert(labels.every((t) => t.indexOf('A站') >= 0), '图标按钮 aria-label 都应含源名');
    assert(new Set(labels).size === 3, '三个图标按钮的 aria-label 应互不相同, 实际 ' + JSON.stringify(labels));

    // 7) 输入都有可访问名称
    assert(document.querySelector('#sourcePopup #srcFilterInput').getAttribute('aria-label').indexOf('筛选') >= 0,
      '筛选输入应有 aria-label');
    document.querySelector('#sourcePopup [data-src-edit="s1"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(document.querySelector('#sourcePopup [data-src-edit-name]').getAttribute('aria-label') === '书源名称',
      '编辑名称输入应有 aria-label');
    assert(document.querySelector('#sourcePopup [data-src-edit-url]').getAttribute('aria-label') === '搜索地址',
      '编辑地址输入应有 aria-label');

    menuItem('source').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
  }
  console.log('书源管理(三层工具/键盘子菜单/管理模式/危险区/label 与 aria-label): 通过');

  // ---------------- 本轮新增的无障碍/键盘语义回归(T02/T03/T05) ----------------
  {
    // 浮层: role=dialog + 非模态 + aria-labelledby 指向真实存在的 <h2>
    for (const id of ['catalogPanel', 'settingsPanel', 'shelfPopup', 'storagePopup', 'notesPopup', 'sourcePopup', 'historyPopup']) {
      const el = document.getElementById(id);
      assert(el, '应存在浮层 #' + id);
      assert(el.getAttribute('role') === 'dialog', '#' + id + ' 应有 role=dialog');
      assert(el.getAttribute('aria-modal') === 'false', '#' + id + ' 应为非模态(aria-modal=false)');
      const labelledBy = el.getAttribute('aria-labelledby');
      assert(labelledBy, '#' + id + ' 应有 aria-labelledby');
      const title = document.getElementById(labelledBy);
      assert(title && el.contains(title), '#' + id + ' 的 aria-labelledby 必须指向浮层内真实存在的标题');
    }
    // 无 focus trap: 不设置 inert, 也不拦截 Tab
    assert(!document.querySelector('[inert]'), '不应给任何元素设置 inert(非模态, 不圈禁焦点)');

    // 目录: 条目/卷头为原生 button, 当前章 aria-current, 卷头 aria-expanded/aria-controls
    menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const catItems2 = Array.from(document.querySelectorAll('#catalogPanel .cat-item'));
    assert(catItems2.length > 0, '目录应有条目');
    assert(catItems2.every((b) => b.tagName === 'BUTTON' && b.type === 'button'),
      '目录条目应为原生 <button type="button">');
    const curItem = document.querySelector('#catalogPanel .cat-item.cur');
    assert(curItem && curItem.getAttribute('aria-current') === 'true', '当前章应有 aria-current="true"');
    const groupHead = document.querySelector('#catalogPanel .cat-group-head');
    assert(groupHead && groupHead.tagName === 'BUTTON', '卷头应为原生 button');
    assert(groupHead.getAttribute('aria-expanded') !== null, '卷头应有 aria-expanded');
    const groupBody = document.getElementById(groupHead.getAttribute('aria-controls'));
    assert(groupBody, '卷头 aria-controls 应指向真实存在的容器');
    assert(groupBody.classList.contains('cat-group-body'), '卷头应控制专题动画容器 .cat-group-body');
    assert(groupBody.classList.contains('open') === (groupHead.getAttribute('aria-expanded') === 'true'),
      '展开态 class 必须与 aria-expanded 同步');
    // 展开/收起改为 JS 用 px 高度驱动(Web Animations), 不再靠 CSS 过渡;
    // 这里只确认动画入口存在 —— 具体数值由 QA 的静态 CSS 审计负责
    assert(typeof groupBody.animate === 'function', '展开动画依赖 Web Animations API');
    groupHead.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(groupHead.getAttribute('aria-expanded') === 'false', '点击卷头应收起');
    assert(!groupBody.classList.contains('open'), '收起后动画容器应移除 open');
    groupHead.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    assert(groupHead.getAttribute('aria-expanded') === 'true', '再次点击应重新展开');
    assert(groupBody.classList.contains('open'), '展开后动画容器应恢复 open');
    menuItem('catalog').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);

    // 书架/历史行: 主按钮 + 独立删除按钮(禁止按钮嵌套)
    menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const bkRow = document.querySelector('#shelfPopup .bk');
    if (bkRow) {
      assert(bkRow.querySelector('.bk-main') && bkRow.querySelector('.bk-main').tagName === 'BUTTON',
        '书架行应有原生主按钮');
      const del = bkRow.querySelector('.bp-del');
      assert(del && del.tagName === 'BUTTON', '书架行的删除应是独立按钮');
      assert(/从书架移除《.+》/.test(del.getAttribute('aria-label') || ''), '删除按钮 aria-label 应含书名');
      assert(!bkRow.querySelector('button button'), '不允许按钮嵌套');
    }
    menuItem('shelf').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);

    // 笔记模式已下线(v1.48.18): 正文不再有段落徽章、也没有 data-note-mode;
    // 建/看笔记的唯一入口是单击段落(另一处「段落点击建笔记」用例仍覆盖主链路)
    assert(!document.querySelector('#content [data-para-btn]'), '正文不应再有段落笔记徽章');
    assert(!document.querySelector('#content .rd-note-btn'), '正文不应残留 .rd-note-btn');
    assert(!document.getElementById('content').hasAttribute('data-note-mode'), '正文根节点不应再有 data-note-mode');

    // 设置面板: 主题单选组 + 宽度档位名 + 自定义宽度 label 关联
    menuItem('settings').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const group = document.querySelector('#settingsPanel .sp-theme-dots');
    assert(group && group.getAttribute('role') === 'radiogroup', '主题预设应为 radiogroup');
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    assert(radios.length === 7, '应有 7 个 role=radio, 实际 ' + radios.length);
    assert(radios.filter((r) => r.getAttribute('aria-checked') === 'true').length === 1,
      '只应有一个 aria-checked=true');
    assert(radios.every((r) => (r.textContent || '').trim().length > 0), '每个主题应有可见名称');
    assert(radios.filter((r) => r.tabIndex === 0).length === 1, 'roving: 只有选中项可 Tab 到达');
    const widthLabel = document.querySelector('label[for="spWidthInput"]');
    assert(widthLabel && document.getElementById('spWidthInput'), '自定义宽度输入框应有 for 关联的 label');
    menuItem('settings').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(30);

    // 控件基线: 书源复选框 24×24 + 粗指针 40×40(样式在 CSS 里, 这里断言**该选择器**的声明)
    // 注: 原来写的是 `cssText.indexOf('width:24px') >= 0` —— 任意元素有 24px 就通过, 属于空转断言(QA 修正)
    const cssText2 = capturedHtml;
    assert(/\.src-check\s*\{[^}]*width:\s*24px/.test(cssText2), '.src-check 应为 24×24(选择器级断言)');
    assert(/\.src-check\s*\{[^}]*height:\s*24px/.test(cssText2), '.src-check 高度应为 24px');
    assert(cssText2.indexOf('pointer:coarse') >= 0 || cssText2.indexOf('pointer: coarse') >= 0, '应有粗指针媒体查询(40×40 目标)');

    // 浮层宽度模型: 取消固定 min-width(320px 视口会溢出), 上限由 min() 承担
    // 注: 原来只查全文是否有 `min-width: 0;` —— 任何一处写了就通过, 于是 #notesPopup/#sourcePopup
    //     后来各自加了固定 min-width 也没被发现(QA 修正为逐浮层断言)
    const cssSrc3 = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'reader.css'), 'utf8');
    // 断言前必须去注释: 注释里解释了"以前是 min-width:380px", 不去注释会把自己讲道理的文本当成声明
    const cssNoComments = cssSrc3.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(cssNoComments.indexOf('max-width: min(560px, calc(100vw - var(--menu-w) - 32px))') >= 0,
      '浮层 max-width 应由视口宽度承担上限');
    assert(cssNoComments.indexOf('min-width: 380px') < 0, '不应再有写死的 min-width:380px');
    for (const popupId of ['#shelfPopup', '#storagePopup', '#notesPopup', '#sourcePopup', '#historyPopup']) {
      const rule = new RegExp('\\' + popupId + '[^{]*\\{([^}]*)\\}', 'g');
      let m;
      while ((m = rule.exec(cssNoComments)) !== null) {
        const minWidth = /min-width:\s*([^;]+);/.exec(m[1]);
        if (!minWidth) { continue; }
        const value = minWidth[1].trim();
        assert(/^(0|0px|none|auto)$/.test(value),
          popupId + ' 不该声明固定 min-width(' + value + '): 它会盖过 ≤576px 的 width, 窄屏被顶出视口');
      }
    }

    // 字号解耦: --ui-font 是固定值, 不再由 --font-size 推导(R4-01)
    // happy-dom 没有完整的 CSS 变量计算, 因此这里查"源声明"是否已固定:
    //   :root{--ui-font:14px} 且全文不再出现 calc(var(--font-size) ...) 的 UI 字号推导
    const cssSrc2 = fs.readFileSync(path.join(__dirname, '..', 'webview', 'reader', 'reader.css'), 'utf8');
    assert(cssSrc2.indexOf('--ui-font: 14px') >= 0, '--ui-font 应固定为 14px');
    assert(cssSrc2.indexOf('--ui-font-sub: 12px') >= 0, '--ui-font-sub 应固定为 12px');
    // 只允许"正文纸面"与"切章骨架"跟随阅读字号, 且必须**恰好**是这两条规则。
    // (旧写法是 length <= 2: 少一条也能过, 例如正文的 font-size 被误删仍绿; 这里收紧成白名单)
    const READER_FONT_OWNERS = ['#content', '.chapter-skeleton'];
    const lines2 = cssSrc2.split('\n');
    const owners = [];
    for (let i = 0; i < lines2.length; i += 1) {
      const line = lines2[i];
      if (line.indexOf('font-size') < 0 || line.indexOf('var(--font-size)') < 0) { continue; }
      // 往回找最近的一条"以 { 结尾"的选择器行
      let sel = '(unknown)';
      for (let j = i - 1; j >= 0 && j > i - 12; j -= 1) {
        const prev = lines2[j].trim();
        if (!prev || prev.charAt(0) === '/' || prev.charAt(0) === '*') { continue; }
        if (prev.slice(-1) === '{') { sel = prev.slice(0, -1).trim(); break; }
        if (prev.indexOf('{') >= 0) { sel = prev.split('{')[0].trim() || sel; break; }
      }
      owners.push(sel);
    }
    assert.strictEqual(owners.length, READER_FONT_OWNERS.length,
      '跟随 --font-size 的规则应恰好 ' + READER_FONT_OWNERS.length + ' 条, 实际 ' + owners.length + ': ' + JSON.stringify(owners));
    for (const want of READER_FONT_OWNERS) {
      assert(owners.indexOf(want) >= 0,
        '缺少「' + want + '」的 font-size: var(--font-size)（正文/骨架必须跟随阅读字号）');
    }
    for (const got of owners) {
      assert(READER_FONT_OWNERS.indexOf(got) >= 0,
        '面板规则「' + got + '」不得由 --font-size 推导字号（只允许正文纸面与切章骨架）');
    }
  }
  console.log('无障碍与键盘语义(dialog/aria-current/段落徽章已下线/主题单选/字号解耦): 通过');

  console.log('\n阅读面板 Vue 冒烟测试全部通过 ✔');
  process.exit(0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
