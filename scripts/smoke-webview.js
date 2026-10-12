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
  toolbarCollapsed: false,
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
// 只检查 HTML/CSS 部分(脚本里合法使用的 isNaN 等不应误报)
const htmlPart = capturedHtml.split('<script')[0];
assert(!htmlPart.includes('undefined') && !htmlPart.includes('NaN'), '模板中不应有 undefined/NaN');
checkInlineScript(capturedHtml, '阅读面板');
console.log('内嵌脚本语法: 通过');

const panelIds = [
  'settingsPanel', 'settingsClose', 'themeSwatches', 'fontSize', 'fontFamily',
  'lineHeight', 'paraSpacing', 'contentWidth', 'progressFill', 'content',
  'bookInfo', 'chapterInfo',
  'fabs', 'fabPrev', 'fabCatalog', 'fabNext', 'fabSettings',
  'catalogPanel', 'catSub', 'catBody', 'catClose', 'catReverse', 'catPrev', 'catNext', 'catPos',
  'chapterWords',
];
for (const id of panelIds) {
  assert(capturedHtml.includes(`id="${id}"`), `阅读面板缺少元素 #${id}`);
}
console.log('关键 UI 元素: 通过 (' + panelIds.length + ' 个)');

// --- 顶部工具栏已移除 ---
for (const gone of [
  'id="prevBtn"', 'id="nextBtn"', 'id="chapterSelect"', 'id="toolbarToggle"',
  'id="fontSizeText"', 'class="toolbar"', 'id="floatBall"', 'id="settingsBtn"',
]) {
  assert(!capturedHtml.includes(gone), `工具栏元素应已移除: ${gone}`);
}
console.log('顶部工具栏已移除: 通过');

// --- 悬浮球工具栏: 上一章/目录/下一章/字 (方形圆角, icon+文字) ---
assert(/\.fab\s*\{[^}]*border-radius:\s*12px/.test(capturedHtml), '悬浮球应为方形圆角');
assert(capturedHtml.includes('fab-label'), '悬浮球应采用 icon+文字 样式');
assert(
  capturedHtml.includes('>上一章</span>') && capturedHtml.includes('>目录</span>') &&
    capturedHtml.includes('>下一章</span>') && capturedHtml.includes('>阅读设置</span>'),
  '四球文案应为 上一章/目录/下一章/阅读设置'
);
assert(/\.fab-label-sm\s*\{[^}]*var\(--font-size\) \* 0\.55/.test(capturedHtml), '长文案标签应用缩小字号');
const fabOrder = ['fabPrev', 'fabCatalog', 'fabNext', 'fabSettings'].map((id) => capturedHtml.indexOf(`id="${id}"`));
assert(
  fabOrder.every((v) => v >= 0) && fabOrder[0] < fabOrder[1] && fabOrder[1] < fabOrder[2] && fabOrder[2] < fabOrder[3],
  '四球顺序应为 上一章 → 目录 → 下一章 → 字'
);
assert(capturedHtml.includes("'fabPrev'") && capturedHtml.includes("'fabNext'"), '上一章/下一章球应已接线');
assert(capturedHtml.includes("fabPrev.classList.toggle('off'"), '首末章应置灰上一章/下一章球');
assert(capturedHtml.includes('pointerdown'), '悬浮球应支持拖动');
assert(capturedHtml.includes('touch-action: none'), '触摸拖动不应触发滚动');
// 底部导航按钮已移除(并入悬浮球工具栏)
for (const gone of ['id="navPrev"', 'id="navCatalog"', 'id="navNext"']) {
  assert(!capturedHtml.includes(gone), `底部导航按钮应已移除: ${gone}`);
}
// 默认位置应跟随阅读区域(正文列右侧留白), 而非贴窗口右缘
assert(capturedHtml.includes('function syncFabAnchor'), '悬浮球位置应跟随阅读区域');
assert(
  /function syncFabAnchor\(\)[\s\S]{0,600}--content-width/.test(capturedHtml),
  '跟随位置应按阅读宽度计算'
);
assert(
  /syncFabAnchor\(\)[\s\S]{0,80}else/.test(capturedHtml) || capturedHtml.includes('syncFabAnchor();'),
  '按设置/窗口变化时重算悬浮球位置'
);
assert(capturedHtml.includes('fabDragged'), '拖动过之后应以拖动位置为准');
assert(capturedHtml.includes('resetFabPosition'), '双击应能恢复跟随阅读区域的位置');
assert(capturedHtml.includes('fabLeft'), '拖动后的位置应可持久化');
assert(capturedHtml.includes('#fabs.awake'), '闲置后应淡化以免遮挡正文');
// 关键回归: 点击必须在 pointerup 上生效, 不能依赖 click 事件
// (pointerdown 就 setPointerCapture 会把后续 click 重定向到容器, 导致点了没反应)
assert(capturedHtml.includes('function activateFab'), '应有统一的悬浮球动作处理');
assert(
  /function endDrag\(\)[\s\S]{0,900}activateFab\(pressId\)/.test(capturedHtml),
  '未发生拖动时应在 pointerup 触发动作(不依赖 click)'
);
assert(
  /if \(!dragging\)[\s\S]{0,400}setPointerCapture/.test(capturedHtml),
  '只有真正拖动后才捕获指针(避免吞掉点击)'
);
console.log('悬浮球工具栏(上/目录/下/阅读设置, 方形圆角): 通过');

// --- 目录面板(参考起点中文网) ---
assert(capturedHtml.includes('id="catalogPanel"'), '应有目录面板');
assert(/\.cat-items\s*\{[^}]*grid-template-columns:\s*repeat\(2/.test(capturedHtml), '目录应为双列展示');
assert(capturedHtml.includes('cat-group-head'), '目录应有分卷(层级)结构');
assert(capturedHtml.includes('cat-group-count'), '分卷应显示章节数');
assert(capturedHtml.includes('.cat-item.cur'), '当前章节应高亮');
assert(capturedHtml.includes('chapterParts'), '目录应拆分章节序号与标题');
assert(capturedHtml.includes("state.catReverse"), '应支持正序/倒序切换');
assert(capturedHtml.includes("type: 'getChapter'"), '点击章节应跳转');
assert(capturedHtml.includes('closeCatalog()'), '跳转后应关闭目录面板');
assert(capturedHtml.includes('scrollIntoView'), '打开目录应定位到当前章');
// 分卷标题只做展开/收起, 不得跳转或关闭面板(否则点箭头会误关整个面板)
assert(capturedHtml.includes('class="cat-group-head" title="展开 / 收起本卷"'), '分卷标题应只负责展开收起');
assert(
  !capturedHtml.includes('gotoChapter(Number(head.dataset.i))'),
  '分卷标题不应触发跳转/关闭面板'
);
// 目录字号应与阅读区同步: 条目 = 正文字号, 分卷/面板标题 ≈ 章节标题字号
assert(
  /\.cat-item \.cat-name\s*\{[^}]*clamp\(13px, var\(--font-size\)/.test(capturedHtml),
  '目录条目字号应与正文字号一致'
);
assert(
  /\.cat-group-name\s*\{[^}]*var\(--font-size\) \* 1\.05\)/.test(capturedHtml),
  '分卷标题字号应≈章节标题(略大于正文)'
);
console.log('目录面板(分卷/双列/高亮/跳转/倒序): 通过');

// --- 进度条移到底部状态栏内 ---
assert(
  /<footer class="statusbar">[\s\S]*progress-track[\s\S]*<\/footer>/.test(capturedHtml),
  '进度条应位于底部状态栏内'
);
assert(
  !/\.progress-track\s*\{[^}]*position:\s*(sticky|fixed)/.test(capturedHtml),
  '进度条不应再吸顶(应随状态栏固定在底部)'
);
assert(capturedHtml.includes('.statusbar .progress-track'), '状态栏内应有进度条样式');
console.log('进度条移到底部: 通过');

// 脚本引用的所有元素 id 必须真实存在(否则脚本初始化即抛错, 事件全部失效)
const usedIds = [...capturedHtml.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
const declaredIds = new Set([...capturedHtml.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const missingIds = [...new Set(usedIds)].filter((id) => !declaredIds.has(id));
assert(missingIds.length === 0, `脚本引用了不存在的元素: ${missingIds.join(', ')}`);
console.log('元素 id 完整性(脚本 ↔ HTML): 通过 (' + declaredIds.size + ' 个)');

// --- 章节计数只在底部状态栏(顶部工具栏已移除) ---
assert(capturedHtml.includes('id="chapterInfo"'), '底部应显示章节位置');
assert(!capturedHtml.includes('id="progressText"'), '不应再有顶部章节计数');
console.log('章节计数仅在底部: 通过');

// --- 主题切换: 留白/纸面/面板/悬浮球 全部跟随主题 ---
assert(/#reader\s*\{[^}]*background:\s*var\(--page-bg\)/.test(capturedHtml), '留白区域应使用主题留白色');
assert(
  /#content\s*\{[^}]*background:\s*var\(--bg\)/.test(capturedHtml),
  '正文"纸面"应使用主题纸面色(与留白区分)'
);
assert(capturedHtml.includes('--page-bg:'), '主题应提供留白底色');
assert(!capturedHtml.includes('--chrome-bg: var(--vscode-editorWidget'), '面板底色应跟随阅读主题而非 VS Code');
assert(
  /background:\s*var\(--chrome-bg\)/.test(capturedHtml),
  '状态栏/面板应使用主题面板底色'
);
assert(
  /--btn-bg:\s*#[0-9a-fA-F]{3,8}/.test(capturedHtml),
  '悬浮球应使用主题主色(不再是 VS Code 按钮蓝)'
);
assert(
  /--input-bg:\s*#[0-9a-fA-F]{3,8}/.test(capturedHtml),
  '输入控件应跟随主题纸面色'
);
console.log('主题(留白/纸面/面板/悬浮球): 通过');

// --- 设置面板字号同步阅读字号 ---
assert(
  /\.settings-head h3\s*\{[^}]*var\(--font-size\) \* 1\.2/.test(capturedHtml),
  '设置面板标题应随阅读字号'
);
assert(
  /\.settings-grid > label\s*\{[^}]*var\(--font-size\)/.test(capturedHtml),
  '设置面板标签应随阅读字号'
);
assert(
  /\.ctl-row output\s*\{[^}]*var\(--font-size\)/.test(capturedHtml),
  '设置面板数值应随阅读字号'
);
assert(
  /\.swatch\s*\{[^}]*var\(--font-size\)/.test(capturedHtml),
  '主题色块应随阅读字号'
);
console.log('设置面板字号同步: 通过');

// --- 底部状态栏显示当前章字数 ---
assert(capturedHtml.includes('chapterWords:'), '章节载荷应携带本章字数');
assert(capturedHtml.includes("'本章 ' + String(words)"), '状态栏应显示本章字数');
assert(capturedHtml.includes('id="chapterWords"'), '状态栏应有字数元素');
console.log('状态栏本章字数: 通过');
console.log('底部导航按钮已移除(并入悬浮球): 通过');

// --- 设置面板必须是固定悬浮窗(不随内容滚动) ---
assert(
  /#settingsPanel\s*\{[^}]*position:\s*fixed/.test(capturedHtml),
  '设置面板必须是固定悬浮窗(position: fixed)'
);
assert(capturedHtml.includes('translateX(-50%)'), '悬浮窗应水平居中');
assert(capturedHtml.includes('#settingsPanel') && capturedHtml.includes('top: 12px'), '面板应固定在顶部');
assert(capturedHtml.includes('box-shadow'), '悬浮窗应有阴影以区分于正文');
assert(capturedHtml.includes("e.key === 'Escape'"), '支持 Esc 关闭面板');
assert(capturedHtml.includes("addEventListener('mousedown'"), '支持点击面板外关闭');
assert(
  !capturedHtml.includes("settingsPanel.scrollIntoView"),
  '悬浮窗不应使用 scrollIntoView(会随内容滚动)'
);
console.log('设置面板悬浮窗(逻辑未改动): 通过');

// --- 就绪后下发 init(含章内滚动位置) ---
panelMessages = [];
panelMsgHandler({ type: 'ready' });
const init1 = panelMessages.find((m) => m.type === 'init');
assert(init1, 'webview 就绪后应下发 init');
assert(init1.payload.bookTitle === '测试之书', 'init 应带上书名');
assert(Math.abs(init1.payload.scrollRatio - 0.5) < 1e-6, 'init 应带上章内滚动位置(延续阅读状态)');
assert(init1.payload.chapterWords === 6, 'init 应携带当前章字数');
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
  'paneSettings', 'libValue', 'btnPickLib', 'btnOpenLib', 'btnClearLib', 'btnReaderSettings',
];
for (const id of sideIds) {
  assert(chapterHtml.includes(`id="${id}"`), `侧边栏缺少元素 #${id}`);
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

// --- 消息协议 ---
received.length = 0;
provider.setMode('shelf');
assert(received.some((m) => m.type === 'mode' && m.mode === 'shelf'), 'setMode 应推送 mode 消息');
provider.setMode('settings');
assert(received.some((m) => m.type === 'mode' && m.mode === 'settings'), '应支持设置模式');

received.length = 0;
provider.setLibrary('D:/我的书库');
const libMsg = received.find((m) => m.type === 'library');
assert(libMsg && libMsg.path === 'D:/我的书库', 'setLibrary 应推送书库目录');
provider.setLibrary('');
assert(received[received.length - 1].path === '', '未设置书库时应推送空路径');

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
msgHandler({ type: 'pickLibrary' });
msgHandler({ type: 'clearLibrary' });
msgHandler({ type: 'openLibraryFolder' });
msgHandler({ type: 'openReaderSettings' });
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
  'novelReader.openSettings',
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
