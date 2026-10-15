/**
 * smoke-sidebar-vue.js — 侧边栏(Vue 3 产物)冒烟测试
 * 用 happy-dom 真实执行 dist-webview/sidebar.js, 验证 书架/目录/设置 的渲染与交互行为
 *
 * 用法: node scripts/smoke-sidebar-vue.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Window } = require('happy-dom');

// ---------------------------------------------------------------- vscode 桩(加载扩展)
const vscodeStub = {
  ViewColumn: { One: 1 },
  window: {
    ViewColumn: { One: 1 },
    createWebviewPanel: () => ({ webview: {}, onDidDispose: () => {}, reveal: () => {}, dispose: () => {} }),
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
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
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
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return vscodeStub; }
  return origLoad.call(this, request, parent, isMain);
};
const { ChapterViewProvider } = require('../dist/chapterViewProvider');

// 产物必须先构建
const sidebarJs = path.join(__dirname, '..', 'dist-webview', 'sidebar.js');
const sidebarCss = path.join(__dirname, '..', 'dist-webview', 'sidebar.css');
assert(fs.existsSync(sidebarJs), 'dist-webview/sidebar.js 不存在, 请先 npm run build:webview');
assert(fs.existsSync(sidebarCss), 'dist-webview/sidebar.css 不存在, 请先 npm run build:webview');

// ---------------------------------------------------------------- 外壳断言
let chapterHtml = '';
let msgHandler = null;
const viewStub = {
  visible: true,
  webview: {
    options: {},
    set html(v) { chapterHtml = v; },
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: (h) => { msgHandler = h; },
  },
  onDidChangeVisibility: () => {},
  onDidDispose: () => {},
};
const provider = new ChapterViewProvider();
provider.resolveWebviewView(viewStub);

console.log('[侧边栏·外壳]');
console.log('HTML 长度:', chapterHtml.length);
assert(chapterHtml.includes('Content-Security-Policy'), '应包含 CSP');
assert(chapterHtml.includes('id="app"'), 'Vue 挂载点 #app 应存在');
const nonceMatch = chapterHtml.match(/script-src 'nonce-([0-9a-f]+)'/);
assert(nonceMatch && chapterHtml.includes('nonce="' + nonceMatch[1] + '"'), 'script 应带同款 nonce');
console.log('外壳(CSP/挂载点/nonce): 通过');

// ---------------------------------------------------------------- 运行时(happy-dom)
console.log('[侧边栏·运行时(Vue)]');
const win = new Window({ url: 'https://localhost/' });
const document = win.document;
const scriptStart = chapterHtml.lastIndexOf('<script nonce="');
const scriptOpenEnd = chapterHtml.indexOf('>', scriptStart);
const scriptEnd = chapterHtml.lastIndexOf('</script>');
const bundle = chapterHtml.slice(scriptOpenEnd + 1, scriptEnd);
assert(bundle.length > 30000, '内联脚本应为完整 bundle');

document.head.innerHTML = '<style>' + fs.readFileSync(sidebarCss, 'utf8') + '</style>';
document.body.innerHTML = '<div id="app"></div>';

const posted = [];
win.acquireVsCodeApi = function () {
  const api = {
    postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
    getState: () => undefined,
    setState: () => undefined,
  };
  delete win.acquireVsCodeApi; // 真实 webview: 调用后即删除
  return api;
};
win.Element.prototype.scrollIntoView = function (opts) { scrollCalls.push(opts || null); };
if (!win.ResizeObserver) { win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; }
const scrollCalls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vm = require('vm');
vm.createContext(win);
vm.runInContext(bundle, win, { filename: 'sidebar-bundle.js' });

const $ = (sel) => document.querySelector(sel);

function dispatch(type, payloadOrExtra) {
  const data = Object.assign({ type }, payloadOrExtra || {});
  win.dispatchEvent(new win.MessageEvent('message', { data }));
}

(async function run() {
  await sleep(30);
  assert(posted.some((m) => m.type === 'ready'), '挂载后应发送 ready');

  // 初始状态: 未打开小说 -> 目录空状态
  assert(document.body.textContent.includes('尚未打开小说'), '目录面板应显示空状态');

  // 全量同步: mode/shelf/library/novel
  dispatch('mode', { mode: 'chapters' });
  dispatch('shelf', { items: [] });
  dispatch('library', { path: '' });
  dispatch('novel', {
    payload: {
      hasNovel: true, bookTitle: '测试书A',
      chapters: [
        { index: 0, title: '第1章 甲' }, { index: 1, title: '第2章 乙' }, { index: 2, title: '第3章 丙' },
      ],
      currentIndex: 2,
    },
  });
  await sleep(30);
  assert(document.querySelectorAll('.ch').length === 3, '应渲染 3 章');
  const cur = document.querySelector('.ch.cur');
  assert(cur && cur.dataset.i === '2', '当前章应高亮');
  assert($('#currentCard .t').textContent.includes('第3章'), '当前阅读条应显示当前章');
  assert(scrollCalls.some((c) => c && c.block === 'center'), '初始带 index 的 novel 同步应滚动定位到当前章');
  console.log('目录(渲染/高亮/当前阅读条/定位): 通过');

  // 换书: 列表更新 + 重新定位
  scrollCalls.length = 0;
  dispatch('novel', {
    payload: {
      hasNovel: true, bookTitle: '测试书B',
      chapters: [ { index: 0, title: '序章' }, { index: 1, title: '第一章' } ],
      currentIndex: 1,
    },
  });
  await sleep(30);
  assert(document.body.textContent.includes('第一章'), '换书后列表应更新');
  assert($('#currentCard .t').textContent.includes('第一章'), '当前阅读条应更新');
  assert(scrollCalls.some((c) => c && c.block === 'center'), '换书后应重新定位到当前章');

  // center=false 不应改变滚动位置
  scrollCalls.length = 0;
  dispatch('current', { index: 0, center: false });
  await sleep(30);
  assert(scrollCalls.length === 0, 'center=false 不应触发滚动');
  console.log('章节切换/换书定位: 通过');

  // 模式切换: 切到书架不滚动, 切回目录重新定位
  scrollCalls.length = 0;
  dispatch('mode', { mode: 'shelf' });
  await sleep(20);
  assert(scrollCalls.length === 0, '切到书架模式不应触发滚动');
  dispatch('mode', { mode: 'chapters' });
  await sleep(30);
  assert(scrollCalls.some((c) => c && c.block === 'center'), '切回目录模式应重新定位到当前章');
  console.log('模式切换重定位: 通过');

  // 点击章节 -> openChapter
  posted.length = 0;
  const ch1 = Array.from(document.querySelectorAll('.ch')).find((el) => el.dataset.i === '1');
  ch1.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'openChapter' && m.index === 1), '点章节应发 openChapter');

  // 当前阅读条点击 -> resumeCurrent
  posted.length = 0;
  $('#currentCard').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'resumeCurrent'), '点当前阅读条应发 resumeCurrent');
  console.log('目录/当前阅读条交互: 通过');

  // 书架: 渲染 + 当前标记 + 移除 + 打开 + 底部按钮
  dispatch('shelf', { items: [
    { filePath: 'D:/a.txt', title: 'A书', author: '作者A', chapterIndex: 2, totalChapters: 10, current: true },
    { filePath: 'D:/b.txt', title: 'B书', author: '', chapterIndex: -1, totalChapters: 5, current: false },
  ] });
  await sleep(30);
  const bkEls = document.querySelectorAll('.bk');
  assert(bkEls.length === 2, '书架应渲染 2 本');
  assert(bkEls[0].classList.contains('cur'), '当前书应高亮');
  assert(document.body.textContent.includes('共 2 本 · 阅读进度自动记录'), '书架底部应显示册数');
  assert(document.body.textContent.includes('读至 第 3 章'), '应显示阅读进度');

  posted.length = 0;
  bkEls[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'openBook' && m.filePath === 'D:/a.txt'), '点书架条目应发 openBook');

  posted.length = 0;
  bkEls[1].querySelector('.bk-del').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'removeBook' && m.filePath === 'D:/b.txt'), '点移除应发 removeBook');

  posted.length = 0;
  document.querySelector('.shelf-add').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  assert(posted.some((m) => m.type === 'openFile'), '点底部「添加书籍」应发 openFile');
  console.log('书架(渲染/进度/移除/打开/添加): 通过');

  // 设置: 书库目录展示与按钮显隐
  dispatch('library', { path: 'D:/我的书库' });
  await sleep(20);
  const libVal = document.querySelector('.set-val');
  assert(libVal.textContent === 'D:/我的书库', '设置页应显示书库目录');
  const btns = Array.from(document.querySelectorAll('.set-btn'));
  const hiddenCount = btns.filter((b) => b.classList.contains('hidden')).length;
  assert(hiddenCount === 0, '已设置书库时「打开/清除」按钮应可见');

  dispatch('library', { path: '' });
  await sleep(20);
  assert(document.querySelector('.set-val').textContent.includes('未设置'), '未设置时应显示默认文案');
  const hiddenAgain = Array.from(document.querySelectorAll('.set-btn')).filter((b) => b.classList.contains('hidden')).length;
  assert(hiddenAgain === 2, '未设置时「打开/清除」按钮应隐藏');
  console.log('设置页(书库目录/按钮显隐): 通过');

  // 空小说状态
  dispatch('novel', { payload: { hasNovel: false, bookTitle: '', chapters: [], currentIndex: -1 } });
  await sleep(30);
  assert(document.body.textContent.includes('尚未打开小说'), '清空小说后应回到空状态');
  assert(!$('#currentWrap').classList.contains('visible'), '空状态应隐藏当前阅读条');
  console.log('空状态: 通过');

  console.log('\n侧边栏 Vue 冒烟测试全部通过 ✔');
  process.exit(0);
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
