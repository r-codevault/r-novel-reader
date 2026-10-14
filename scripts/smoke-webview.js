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

// 直接复用真实的默认设置, 避免测试桩与 settings.ts 漂移
const { DEFAULT_SETTINGS } = require('../dist/settings');
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
  'settingsPanel', 'settingsClose', 'themeSwatches',
  'fontDec', 'fontInc', 'fontSizeVal', 'fontFamilySeg',
  'lineDec', 'lineInc', 'lineHeightVal',
  'paraDec', 'paraInc', 'paraSpacingVal', 'widthSeg',
  'progressFill', 'content',
  'bookInfo', 'chapterInfo',
  'fabs', 'fabPrev', 'fabCatalog', 'fabNext', 'fabSettings',
  'catalogPanel', 'catSub', 'catBody', 'catClose', 'catReverse', 'catPrev', 'catNext', 'catPos',
  'chapterWords', 'shortcutHint',
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
  /function fabLayoutMetrics[\s\S]{0,600}--content-width/.test(capturedHtml),
  '位置计算应基于阅读宽度(--content-width)'
);
assert(
  /function syncFabAnchor\(\)[\s\S]{0,300}fabLayoutMetrics\(\)/.test(capturedHtml),
  '默认位置应按阅读宽度重算'
);
assert(
  /syncFabAnchor\(\)[\s\S]{0,80}else/.test(capturedHtml) || capturedHtml.includes('syncFabAnchor();'),
  '按设置/窗口变化时重算悬浮球位置'
);
assert(capturedHtml.includes('fabDragged'), '拖动过之后应以拖动位置为准');
assert(capturedHtml.includes('resetFabPosition'), '双击应能恢复跟随阅读区域的位置');
// 纵向边界: 必须按实测高度 + 底部状态栏钳制, 不能用写死的估算值(四球工具栏会超出下边界)
assert(capturedHtml.includes('function fabMaxTop'), '应有纵向边界钳制函数');
assert(
  /function fabMaxTop\(\)[\s\S]{0,300}offsetHeight/.test(capturedHtml),
  '纵向钳制应按悬浮球实测高度计算'
);
assert(capturedHtml.includes('els.fabs.offsetHeight') && !capturedHtml.includes('innerHeight - 110'), '不应再用写死的高度估算');
// 视图尺寸变化(含侧边栏展开/收起) 后必须重新贴合正文两侧
assert(capturedHtml.includes('function syncFabOnResize'), '应有尺寸变化后的位置修正');
assert(capturedHtml.includes("addEventListener('resize', syncFabOnResize)"), '窗口缩放应触发位置修正');
assert(capturedHtml.includes('ResizeObserver'), '侧边栏展开/收起应能被兜底捕获');
assert(
  /if \(!fabDragged\)[\s\S]{0,400}snapFabPosition/.test(capturedHtml),
  '拖动过的情况下也应在尺寸变化后重新贴合正文两侧'
);
assert(capturedHtml.includes('fabLeft'), '拖动后的位置应可持久化');
assert(capturedHtml.includes('#fabs.awake'), '闲置后应淡化以免遮挡正文');
// 关键回归: 点击必须在 pointerup 上生效, 不能依赖 click 事件
// (pointerdown 就 setPointerCapture 会把后续 click 重定向到容器, 导致点了没反应)
assert(
  /function snapFabPosition[\s\S]{0,300}fabLayoutMetrics\(\)/.test(capturedHtml),
  '拖动松手应吸附到正文列两侧(按阅读宽度计算)'
);
assert(
  /function endDrag\(\)[\s\S]{0,900}snapFabPosition/.test(capturedHtml),
  '松手时应调用吸附函数'
);
assert(capturedHtml.includes("'left' : 'right'"), '应根据落点吸附到左侧或右侧');
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

// --- 设置面板字号同步阅读字号(起点风格新结构) ---
assert(
  /\.sp-title\s*\{[^}]*var\(--font-size\)/.test(capturedHtml),
  '设置面板标题应随阅读字号'
);
assert(
  /\.sp-label\s*\{[^}]*var\(--font-size\)/.test(capturedHtml),
  '设置面板标签应随阅读字号'
);
assert(
  /\.sp-dot\s*\{[^}]*border-radius:\s*50%/.test(capturedHtml),
  '主题色块应为起点风格的圆形色点'
);
assert(
  /\.sp-step-btn\s*\{[^}]*var\(--font-size\)/.test(capturedHtml),
  '字号步进按钮应随阅读字号'
);
console.log('设置面板字号同步: 通过');

// --- 底部状态栏显示当前章字数 ---
assert(capturedHtml.includes('chapterWords:'), '章节载荷应携带本章字数');
assert(capturedHtml.includes("'本章 ' + String(words)"), '状态栏应显示本章字数');
assert(capturedHtml.includes('id="chapterWords"'), '状态栏应有字数元素');
console.log('状态栏本章字数: 通过');
console.log('底部导航按钮已移除(并入悬浮球): 通过');

// --- 可自定义快捷键 + Ctrl+滚轮缩放 ---
assert(capturedHtml.includes('function parseShortcut'), '应有快捷键解析');
assert(capturedHtml.includes('function matchShortcut'), '应有快捷键匹配');
assert(capturedHtml.includes('state.prevCombo') && capturedHtml.includes('state.nextCombo'), '应使用配置的快捷键');
assert(/addEventListener\(\s*'wheel'/.test(capturedHtml), '应监听滚轮事件');
assert(capturedHtml.includes('passive: false'), '滚轮监听需可阻止默认缩放');
assert(capturedHtml.includes('shortcutLabel'), '设置面板应展示快捷键提示');
// 设置面板定位: 贴着悬浮工具栏弹出 + 视口内夹取
assert(capturedHtml.includes('function positionSettingsPanel'), '设置面板应有定位函数');
assert(
  /function positionSettingsPanel[\s\S]{0,1600}getBoundingClientRect/.test(capturedHtml),
  '设置面板应参照悬浮工具栏位置'
);
assert(
  /function positionSettingsPanel[\s\S]{0,2000}maxHeight/.test(capturedHtml),
  '设置面板应限制高度避免超出视口'
);
assert(
  /function openSettings\(\)[\s\S]{0,200}positionSettingsPanel\(\)/.test(capturedHtml),
  '打开设置面板时应先定位'
);
console.log('快捷键自定义 + Ctrl+滚轮缩放: 通过');

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

// --- 阅读面板脚本运行时行为: 用最小 DOM 桩真实执行脚本并派发消息 ---
// (防止"字段没传下去/引用未定义变量"这类只有运行时才暴露的问题)
{
  const vm = require('vm');
  const byId = {};
  const scrollCalls2 = [];
  const docListeners = {};
  const styleVars = {};
  function el2() {
    const classes = new Set();
    const el = {
      children: [], textContent: '', value: '', title: '', dataset: {}, _ls: {},
      style: {
        setProperty(k, v) { styleVars[k] = v; },
        getPropertyValue(k) { return styleVars[k] || ''; },
        removeProperty(k) { delete styleVars[k]; },
      },
      disabled: false, offsetHeight: 246, offsetWidth: 58,
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) { classes.add(c); } else { classes.delete(c); }
          return on;
        },
        contains(c) { return classes.has(c); },
      },
      addEventListener(type, fn) { (el._ls[type] ||= []).push(fn); }, removeEventListener() {},
      querySelector(){ return el2(); }, querySelectorAll(){ return []; },
      closest(){ return null; }, contains(){ return false; },
      scrollIntoView(o){ scrollCalls2.push(o || null); }, focus(){}, click(){}, appendChild(){},
      setAttribute(){}, getAttribute(){ return null; }, setPointerCapture(){},
      getBoundingClientRect(){ return { left: 0, top: 0, right: 58, bottom: 246, width: 58, height: 246 }; },
    };
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get() { return el._html || ''; },
      set(v) {
        el._html = String(v);
        const count = (el._html.match(/<div\b/g) || []).length;
        el.children = [];
        for (let i = 0; i < count; i++) { el.children.push(el2()); }
      },
    });
    return el;
  }
  const panelMsgHandlers = [];
  const panelPosted = [];
  const panelScript = capturedHtml
    .split('<script nonce=')[1]
    .split('</script>')[0]
    .replace(/^[^>]*>/, '');
  const sandbox2 = {
    acquireVsCodeApi() {
      return { postMessage(m) { panelPosted.push(m); }, getState() { return {}; }, setState() {} };
    },
    document: {
      getElementById(id) { return (byId[id] ||= el2()); },
      querySelector() { return el2(); },
      querySelectorAll() { return []; },
      createElement() { return el2(); },
      addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
      body: el2(),
      documentElement: el2(),
      title: '',
    },
    window: {
      addEventListener(type, fn) { if (type === 'message') { panelMsgHandlers.push(fn); } },
      innerWidth: 1400, innerHeight: 900, scrollTo() {},
    },
    getComputedStyle() { return { getPropertyValue() { return '720px'; } }; },
    requestAnimationFrame(fn) { fn(); },
    ResizeObserver: class { observe() {} disconnect() {} },
    console,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(id) { if (id > 0) { timers[id - 1] = null; } },
    location: { href: '' }, navigator: { userAgent: 'node' },
  };
  // 定时器改成可控队列, 便于验证防抖提交的内容
  const timers = [];
  function flushTimers() {
    for (let i = 0; i < timers.length; i++) { const fn = timers[i]; if (fn) { fn(); } }
    timers.length = 0;
  }
  function fire(key, type, ev) {
    const el = byId[key];
    const list = (el && el._ls && el._ls[type]) || [];
    for (const fn of list) { fn(ev); }
  }
  vm.createContext(sandbox2);
  vm.runInContext(panelScript, sandbox2, { filename: 'readerPanel-webview.js' });
  assert(panelMsgHandlers.length > 0, '阅读面板脚本应注册 message 监听');

  function dispatch2(msg) {
    for (const fn of panelMsgHandlers) { fn({ data: msg }); }
  }
  dispatch2({
    type: 'init',
    payload: {
      filePath: 'D:/a.txt', bookTitle: '运行时测试书', author: '作者',
      chapters: [
        { index: 0, title: '第1章 甲' }, { index: 1, title: '第2章 乙' }, { index: 2, title: '第3章 丙' },
      ],
      chapterIndex: 2, chapterTitle: '第3章 丙',
      paragraphs: ['第一段', '第二段'], totalChapters: 3, totalWords: 3000,
      chapterWords: 1234, scrollRatio: 0.25,
      settings: {
        fontSize: 16, fontFamily: 'system', lineHeight: 1.8,
        paragraphSpacing: 0.8, theme: 'sepia', contentWidth: 720,
        shortcutPrev: 'alt+arrowleft', shortcutNext: 'alt+arrowright',
      },
    },
  });
  assert(byId.content.innerHTML.includes('第3章 丙'), 'init 后应渲染正文');
  assert(byId.chapterInfo.textContent === '第 3 章 / 共 3 章', 'init 后应显示章节位置');
  // 关键回归: init 时必须把本章字数一起传给渲染(否则底部字数空白, 点目录后才出现)
  assert(byId.chapterWords.textContent === '本章 1,234 字', 'init 后底部应显示本章字数');
  assert(byId.catSub.textContent === '共 3 章', '侧栏目录应显示总章数');

  dispatch2({
    type: 'chapter',
    payload: {
      index: 0, title: '第1章 甲', paragraphs: ['x'], totalChapters: 3,
      chapterWords: 55, scrollRatio: 0,
    },
  });
  assert(byId.chapterWords.textContent === '本章 55 字', '切章后字数应更新');
  assert(byId.chapterInfo.textContent === '第 1 章 / 共 3 章', '切章后章节位置应更新');

  // 侧边栏「打开阅读设置」按钮 -> openSettings 消息必须真的打开设置面板
  dispatch2({ type: 'openSettings' });
  assert(byId.settingsPanel.classList.contains('open'), 'openSettings 消息应打开设置面板');
  // 设置面板应贴着悬浮工具栏弹出并被夹在视口内
  const spLeft = parseFloat(byId.settingsPanel.style.left);
  const spTop = parseFloat(byId.settingsPanel.style.top);
  assert(isFinite(spLeft) && spLeft >= 12, '设置面板左边界应夹在视口内');
  assert(isFinite(spTop) && spTop >= 12, '设置面板上边界应夹在视口内');
  assert(!!byId.settingsPanel.style.maxHeight, '设置面板应限制最大高度避免超出');

  // 自定义快捷键: 默认 alt+arrowleft / alt+arrowright 应触发上/下一章
  function keyEvent(key, mods) {
    return Object.assign({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      target: { tagName: 'BODY' }, preventDefault() {} }, mods || {});
  }
  // 先定位到第 2 章, 便于同时验证 上一章(->1) 与 下一章(->3)
  dispatch2({
    type: 'chapter',
    payload: { index: 1, title: '第2章 乙', paragraphs: ['y'], totalChapters: 3, chapterWords: 88, scrollRatio: 0 },
  });
  panelPosted.length = 0;
  for (const fn of (docListeners.keydown || [])) { fn(keyEvent('ArrowLeft', { altKey: true })); }
  assert(
    panelPosted.some((m) => m.type === 'getChapter' && m.index === 0),
    '默认 alt+← 应切到上一章'
  );
  panelPosted.length = 0;
  for (const fn of (docListeners.keydown || [])) { fn(keyEvent('ArrowRight', { altKey: true })); }
  assert(
    panelPosted.some((m) => m.type === 'getChapter' && m.index === 2),
    '默认 alt+→ 应切到下一章'
  );
  // 输入控件获得焦点时不应触发翻章(避免与滑块方向键冲突)
  panelPosted.length = 0;
  for (const fn of (docListeners.keydown || [])) {
    fn(keyEvent('ArrowLeft', { altKey: true, target: { tagName: 'INPUT' } }));
  }
  assert(panelPosted.length === 0, '设置面板输入控件聚焦时不应翻章');

  // 回归: 切主题后设置面板配色必须实时跟随(--sp-* 由 applySettings 动态维护)
  dispatch2({
    type: 'settings',
    payload: {
      fontSize: 16, fontFamily: 'kaiti', lineHeight: 1.8,
      paragraphSpacing: 0.8, theme: 'dark', contentWidth: 720,
      shortcutPrev: 'alt+arrowleft', shortcutNext: 'alt+arrowright',
    },
  });
  assert(styleVars['--sp-bg'] === '#1c1c1c', '黑夜主题下面板应用深色配色');
  assert(styleVars['--sp-accent'] === '#c9963f', '黑夜主题下面板沿用暖金强调');
  dispatch2({
    type: 'settings',
    payload: {
      fontSize: 16, fontFamily: 'kaiti', lineHeight: 1.8,
      paragraphSpacing: 0.8, theme: 'sepia', contentWidth: 720,
      shortcutPrev: 'alt+arrowleft', shortcutNext: 'alt+arrowright',
    },
  });
  assert(styleVars['--sp-bg'] === '#ffffff', '浅色主题下面板应用白面板(起点风格)');

  // Ctrl + 滚轮 缩放字号
  dispatch2({
    type: 'settings',
    payload: {
      fontSize: 16, fontFamily: 'system', lineHeight: 1.8,
      paragraphSpacing: 0.8, theme: 'sepia', contentWidth: 720,
      shortcutPrev: 'alt+arrowleft', shortcutNext: 'alt+arrowright',
    },
  });
  const wheelHandler = (docListeners.wheel || [])[0];
  assert(wheelHandler, '应注册 wheel 监听');
  let prevented = 0;
  wheelHandler({ ctrlKey: true, deltaY: -1, preventDefault() { prevented++; } });
  assert(byId.fontSizeVal.textContent === '17', 'Ctrl+滚轮上滚应放大字号');
  assert(prevented > 0, 'Ctrl+滚轮应阻止默认缩放');
  wheelHandler({ ctrlKey: false, deltaY: -1, preventDefault() { prevented++; } });
  assert(byId.fontSizeVal.textContent === '17', '无 Ctrl 的滚轮不应改变字号');

  // 回归: 字号改动必须与随后的其它设置改动合并提交, 不能被顶掉后回弹
  panelPosted.length = 0;
  wheelHandler({ ctrlKey: true, deltaY: -1, preventDefault() {} }); // 17 -> 18
  assert(byId.fontSizeVal.textContent === '18', '滚轮应立即放大字号');
  fire('themeSwatches', 'click', { target: { closest: () => ({ dataset: { theme: 'dark' } }) } });
  flushTimers();
  const settingsUpdate = panelPosted.filter((m) => m.type === 'updateSettings').pop();
  assert(
    settingsUpdate && settingsUpdate.patch.fontSize === 18 && settingsUpdate.patch.theme === 'dark',
    '字号与主题改动应合并提交(否则字号会被扩展回推的旧值还原)'
  );

  console.log('阅读面板脚本运行时(正文/字数/设置面板/快捷键/缩放): 通过');
}

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
  // 设置面板独立配色(浅色=白面板+起点红, 黑夜=深色面板), 且由 applySettings 实时维护
  assert(
    capturedHtml.includes('background: var(--sp-bg)') &&
      capturedHtml.includes("setProperty('--sp-bg'"),
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
