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

// ================================================================ 1. 阅读面板(已迁移 Vue3, 见 smoke-reader-vue.js)

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
  onDidDispose: () => ({ dispose() {} }),
  visible: true,
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
  'paneSettings', 'libValue', 'btnPickLib', 'btnOpenLib', 'btnClearLib',
  'btnAddBook', 'shelfCount',
];
for (const id of sideIds) {
  assert(chapterHtml.includes(`id="${id}"`), `侧边栏缺少元素 #${id}`);
}
// 侧边栏设置页的「打开阅读设置」按钮已移除(阅读页右侧工具栏里有)
assert(!chapterHtml.includes('btnReaderSettings'), '侧边栏不应再有「打开阅读设置」按钮');
assert(!chapterHtml.includes('openReaderSettings'), '侧边栏不应再发送 openReaderSettings 消息');
// 按钮文案统一为「添加书籍」, 不再出现别扭的"打开小说文件"
assert(chapterHtml.includes('>添加书籍</button>'), '侧边栏按钮文案应为「添加书籍」');
assert(!chapterHtml.includes('打开小说文件'), '侧边栏不应再出现「打开小说文件」');
// 书架底部黏底按钮: 书籍多时列表内部滚动, 按钮固定不随滚动
assert(chapterHtml.includes('id="btnAddBook"'), '书架底部应有「添加书籍」按钮');
assert(/\.shelf-foot\s*\{[^}]*position:\s*sticky/.test(chapterHtml), '书架底部按钮区应黏底');
assert(/\.shelf-foot\s*\{[^}]*z-index/.test(chapterHtml), '黏底区应有层级避免被列表覆盖');
assert(!/elShelfFoot\.textContent\s*=/.test(chapterHtml), '计数应写入独立元素, 不能覆盖底部按钮');
assert(chapterHtml.includes('elShelfCount.textContent'), '书架计数应写入 #shelfCount');
// 标题栏命令: 去掉「＋ 添加」按钮(统一走书架底部黏底按钮)
{
  const pkgJson = require('../package.json');
  const cmds = pkgJson.contributes.commands;
  const titleItems = (pkgJson.contributes.menus['view/title'] || []).map((m) => m.command);
  assert(!cmds.some((c) => c.command === 'novelReader.addBook'), '「＋ 添加」命令应已移除');
  assert(!titleItems.includes('novelReader.addBook'), '标题栏不应再有「＋ 添加」');
  assert(!titleItems.includes('novelReader.openFile'), '标题栏不应挂「打开小说文件」');
  assert(titleItems.includes('novelReader.refresh'), '刷新目录按钮应保留');
  // 切换入口必须带图标且标题完整(用户偏好图标按钮)
  for (const [cmd, icon, title] of [
    ['novelReader.showBookshelf', '$(library)', '我的书架'],
    ['novelReader.showChapters', '$(book)', '章节目录'],
  ]) {
    const def = cmds.find((x) => x.command === cmd);
    assert(def && def.icon === icon && def.title === title, `${cmd} 应为图标按钮(${icon}/${title})`);
  }
  // 激活事件: onCommand/onView 由 VS Code 自动生成, 手写会报警告
  const manual = (pkgJson.activationEvents || []).filter((e) => /^on(Command|View):/.test(e));
  assert(manual.length === 0, '不应手写 onCommand/onView 激活事件: ' + manual.join(','));
  // 容器 id 与扩展标识统一(r- 前缀)
  assert(
    (pkgJson.contributes.viewsContainers.activitybar || []).some((v) => v.id === 'r-novel-reader'),
    '视图容器 id 应为 r-novel-reader'
  );
  // 三个互斥视图: 视图名即标题栏文字
  const views = pkgJson.contributes.views['r-novel-reader'];
  const names = views.map((v) => v.name).join('/');
  assert(names === '书架/目录/设置', '应有 书架/目录/设置 三个视图');
  const viewIds = views.map((v) => v.id);
  assert(
    viewIds.length === 3 && views.every((v) => v.type === 'webview'),
    '三个视图都应是 webview 且登记在容器下(激活事件由 VS Code 自动生成)'
  );
  // when 必须与命令设置的 context key 对应(互斥)
  const modes = views.map((v) => (v.when || '').replace(/[^a-z]+/g, ''));
  assert(
    modes[0].includes('shelf') && modes[1].includes('chapters') && modes[2].includes('settings'),
    '视图 when 条件应与 viewMode 对应'
  );
  assert(viewIds.length === 3 && new Set(viewIds).size === 3, '视图 id 不能重复');
  // 主题色同步起点: 白/米白/羊皮纸/护眼绿/浅蓝/黑夜(黑夜沿用原配色)
  assert(
    JSON.stringify(pkgJson.contributes.configuration.properties['novelReader.theme'].enum) ===
      JSON.stringify(['white', 'beige', 'sepia', 'green', 'blue', 'dark']),
    '主题枚举应与起点六色一致'
  );
  // 设置面板独立配色(浅色=白面板+起点红, 黑夜=深色面板), 由 Vue store.applyThemeVars 实时维护
  // (阅读面板已迁 Vue3, 直接检查 dist-webview 产物)
  const vueCss = fs.readFileSync(path.join(__dirname, '..', 'dist-webview', 'reader.css'), 'utf8');
  const vueJs = fs.readFileSync(path.join(__dirname, '..', 'dist-webview', 'reader.js'), 'utf8');
  assert(
    /background:\s*var\(--sp-bg\)/.test(vueCss) &&
      /setProperty\((['"])--sp-bg\1/.test(vueJs),
    '设置面板应有独立配色变量且随主题实时跟随'
  );
  // when 必须用 view =~ /novelReader/ 匹配三个视图
  // (禁用 view == 旧 id: 只对单视图有效; 禁用 view in 字面量列表: 右侧必须是 context key, 两者都会让按钮全消失)
  for (const m of pkgJson.contributes.menus['view/title']) {
    assert(/view =~ \/novelReader\//.test(m.when || ''), `标题栏 when 应用 view =~ /novelReader/ 匹配视图: ${m.command}`);
    assert(!/view in |view == novelReaderChapters/.test(m.when || ''), `标题栏 when 禁用坏语法: ${m.command}`);
  }
  // 兜底: 上下文键未设置时也要有可见视图, 否则活动栏图标会整个消失
  assert(
    views.some((v) => /!novelReader\.viewMode/.test(v.when || '')),
    '三视图全依赖上下文键会让活动栏图标消失, 必须留兜底视图'
  );
  assert(
    pkgJson.activationEvents.includes('onStartupFinished'),
    '需在启动后激活以设置 viewMode 上下文(同时支撑启动自动恢复)'
  );
  // 设置页标题栏: 只出现「返回」(分栏/刷新/设置 都要隐藏)
  const backCmd = cmds.find((c) => c.command === 'novelReader.backFromSettings');
  assert(backCmd && backCmd.title === '返回', '应有「返回」命令');
  const titleMenus = pkgJson.contributes.menus['view/title'];
  const backMenu = titleMenus.find((m) => m.command === 'novelReader.backFromSettings');
  assert(backMenu && /viewMode == settings/.test(backMenu.when), '设置页应显示「返回」');
  for (const [cmd, label] of [
    ['novelReader.refresh', '刷新目录'],
    ['novelReader.showSettings', '设置'],
    ['novelReader.showChapters', '目录切换'],
  ]) {
    const menu = titleMenus.find((m) => m.command === cmd);
    // 设置模式下隐藏: when 要么显式排除 settings, 要么只匹配 chapters/shelf
    const hiddenInSettings =
      menu && (/viewMode != settings/.test(menu.when) || /viewMode == (chapters|shelf)/.test(menu.when));
    assert(hiddenInSettings, `设置页不应显示「${label}」`);
  }
}
assert(chapterHtml.includes('bk-del'), '书架条目应有移除按钮');
assert(chapterHtml.includes('书架空空如也'), '书架应有空状态');
console.log('书架 UI 元素: 通过');

// --- 设置模式(存储位置) ---
assert(chapterHtml.includes('书库目录'), '设置页应有书库目录项');
assert(chapterHtml.includes('未设置 · 读取文件原路径'), '默认应显示未设置(读原路径)');
assert(chapterHtml.includes('导入时会把小说复制到该目录'), '设置页应说明拷贝行为');
assert(chapterHtml.includes('选择书库目录'), '设置页应有选择目录按钮');
console.log('设置页(存储位置): 通过');

// --- 侧边栏脚本运行时行为: 用最小 DOM 桩真实执行脚本 ---
// (防止"引用未定义变量"之类的初始化/渲染抛错 —— v1.7.4 曾因 applyNovel 缺 var key 导致列表全空)
const vm = require('vm');
let scrollCalls = [];
function makeEl() {
  const el = {
    children: [],
    textContent: '', value: '', title: '', dataset: {}, style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    _ls: {},
    addEventListener(type, fn) { (el._ls[type] ||= []).push(fn); }, removeEventListener(){},
    querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
    closest(){ return null; }, contains(){ return false; },
    scrollIntoView(opts) { scrollCalls.push(opts || null); }, focus(){}, click(){}, appendChild(){},
    setAttribute(){}, getAttribute(){ return null; },
    getBoundingClientRect(){ return { left: 0, top: 0, right: 58, bottom: 100, width: 58, height: 100 }; },
  };
  // 极简 innerHTML 模拟: 赋值时按 <div 出现次数生成 children, 供 renderChapters 的
  // `Array.prototype.slice.call(el.children)` 遍历
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return el._html || ''; },
    set(v) {
      el._html = String(v);
      const count = (el._html.match(/<div\b/g) || []).length;
      el.children = [];
      for (let i = 0; i < count; i++) { el.children.push(makeEl()); }
    },
  });
  return el;
}
const sidebarPosted = [];
const elsById = {};
const sidebarMessageHandlers = [];
const sidebarScript = chapterHtml
  .split('<script nonce=')[1]
  .split('</script>')[0]
  .replace(/^[^>]*>/, '');
const sidebarSandbox = {
  acquireVsCodeApi() {
    return {
      postMessage(m) { sidebarPosted.push(m); },
      getState() { return {}; },
      setState() {},
    };
  },
  document: {
    getElementById(id) { return (elsById[id] ||= makeEl()); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    addEventListener() {},
    body: makeEl(),
    documentElement: makeEl(),
  },
  window: {
    addEventListener(type, fn) { if (type === 'message') { sidebarMessageHandlers.push(fn); } },
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle() { return { getPropertyValue() { return '720px'; } }; },
    scrollTo() {},
  },
  console, setTimeout, clearTimeout,
  location: { href: '' }, navigator: { userAgent: 'node' },
};
vm.createContext(sidebarSandbox);
vm.runInContext(sidebarScript, sidebarSandbox, { filename: 'sidebar-webview.js' });
assert(sidebarMessageHandlers.length > 0, '侧边栏脚本应注册 message 监听');

function dispatchNovel(payload) {
  for (const fn of sidebarMessageHandlers) {
    fn({ data: { type: 'novel', payload } });
  }
}
// 第一本书(3 章, 当前第 3 章)
dispatchNovel({
  hasNovel: true, bookTitle: '测试书A',
  chapters: [ { index: 0, title: '第1章 甲' }, { index: 1, title: '第2章 乙' }, { index: 2, title: '第3章 丙' } ],
  currentIndex: 2,
});
assert(elsById.chapterList.innerHTML.includes('data-i="2"'), '应渲染章节列表');
assert(elsById.currentTitle.textContent.includes('第3章'), '当前阅读条应显示当前章');

// 切换到另一本书(2 章, 当前第 2 章) —— v1.7.4 换书滚动定位的回归点
dispatchNovel({
  hasNovel: true, bookTitle: '测试书B',
  chapters: [ { index: 0, title: '序章' }, { index: 1, title: '第一章' } ],
  currentIndex: 1,
});
assert(elsById.chapterList.innerHTML.includes('第一章'), '切换书目后列表应更新为新书');
assert(elsById.currentTitle.textContent.includes('第一章'), '切换书目后当前阅读条应更新');

// 带 center 的定位消息应触发滚动(换书后把列表滚到当前章)
scrollCalls.length = 0;
for (const fn of sidebarMessageHandlers) {
  fn({ data: { type: 'current', index: 1, center: true } });
}
assert(scrollCalls.length > 0, 'center=true 时应滚动定位到当前章');
assert(scrollCalls[0] && scrollCalls[0].block === 'center', '应把当前章滚动到列表中间');
scrollCalls.length = 0;
for (const fn of sidebarMessageHandlers) {
  fn({ data: { type: 'current', index: 0, center: false } });
}
assert(scrollCalls.length === 0, 'center=false 时不应改变滚动位置(阅读中翻章不打扰)');

// 从书架模式切回目录模式时必须重新定位(章节列表在书架模式下隐藏, 隐藏期间定位无效)
scrollCalls.length = 0;
for (const fn of sidebarMessageHandlers) {
  fn({ data: { type: 'mode', mode: 'shelf' } });
}
assert(scrollCalls.length === 0, '切到书架模式不应触发滚动');
for (const fn of sidebarMessageHandlers) {
  fn({ data: { type: 'mode', mode: 'chapters' } });
}
assert(scrollCalls.length > 0, '切回目录模式应重新定位到当前章');

// 书架: 计数写入独立元素 + 底部「添加书籍」按钮接线
function fireSide(id, type, ev) {
  const el = elsById[id];
  const list = (el && el._ls && el._ls[type]) || [];
  for (const fn of list) { fn(ev); }
}
for (const fn of sidebarMessageHandlers) {
  fn({ data: { type: 'shelf', items: [
    { filePath: 'D:/a.txt', title: 'A', author: '', chapterIndex: 2, totalChapters: 10, current: true },
    { filePath: 'D:/b.txt', title: 'B', author: '', chapterIndex: -1, totalChapters: 5, current: false },
  ] } });
}
assert(elsById.shelfCount.textContent === '共 2 本 · 阅读进度自动记录', '书架底部应显示册数统计');
assert(elsById.shelfList.innerHTML.includes('A') && elsById.shelfList.innerHTML.includes('B'), '书架列表应渲染');
sidebarPosted.length = 0;
fireSide('btnAddBook', 'click', {});
assert(
  sidebarPosted.some((m) => m.type === 'openFile'),
  '点击底部「添加书籍」应触发添加小说流程'
);
console.log('侧边栏脚本运行时(渲染/换书/高亮/定位/书架/添加书籍): 通过');


// --- 消息协议 ---
received.length = 0;
provider.setMode('shelf');
assert(received.some((m) => m.type === 'mode' && m.mode === 'shelf'), 'setMode 应推送 mode 消息');
provider.setMode('settings');
assert(received.some((m) => m.type === 'mode' && m.mode === 'settings'), '应支持设置模式');
provider.setMode('shelf');
provider.setMode('settings');
assert(provider.previousMode === 'shelf', '进入设置前的模式应被记住(供「返回」按钮使用)');

received.length = 0;
provider.setLibrary('D:/我的书库');
const libMsg = received.find((m) => m.type === 'library');
assert(libMsg && libMsg.path === 'D:/我的书库', 'setLibrary 应推送书库目录');
provider.setLibrary('');
assert(received[received.length - 1].path === '', '未设置书库时应推送空路径');

received.length = 0;
provider.setCurrent(5, true);
const centerMsg = received.find((m) => m.type === 'current');
assert(centerMsg && centerMsg.center === true, 'setCurrent(center=true) 应推送居中定位消息');
provider.setCurrent(6);
assert(received[received.length - 1].center === false, '默认 setCurrent 不应触发滚动');
received.length = 0;
provider.setShelf([
  { filePath: 'D:/a.txt', title: '测试之书', author: '测试作者', chapterIndex: 275, totalChapters: 454, current: true },
  { filePath: 'D:/b.txt', title: '另一本', author: '', chapterIndex: -1, totalChapters: 100, current: false },
]);
const shelfMsg = received.find((m) => m.type === 'shelf');
assert(shelfMsg && shelfMsg.items.length === 2, 'setShelf 应推送书架列表');
assert(shelfMsg.items[0].chapterIndex === 275 && shelfMsg.items[0].current === true, '书架条目进度/当前标记不正确');

received.length = 0;
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
msgHandler({ type: 'pickLibrary' });
msgHandler({ type: 'clearLibrary' });
msgHandler({ type: 'openLibraryFolder' });
const expected = [
  'novelReader.openBook',
  'novelReader.removeFromShelf',
  'novelReader.resumeCurrent',
  'novelReader.openFile',
  'novelReader.openChapter',
  'novelReader.showBookshelf',
  'novelReader.showChapters',
  'novelReader.pickLibraryPath',
  'novelReader.clearLibraryPath',
  'novelReader.openLibraryFolder',
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
