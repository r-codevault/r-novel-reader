/**
 * test-slacker.js — 摸鱼模式测试
 * 用法: node scripts/test-slacker.js
 *
 * 覆盖: 注释折行 / 伪代码生成(默认 JS + 全语言注释前缀 + 块注释转义 + 种子稳定)
 *       虚拟文档 URI 往返 / SlackerController(打开/翻章/越界/老板键/缓存)
 *       命令与快捷键清单(package.json + extension.ts 接线)
 */

'use strict';

const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- vscode 桩

class FakeUri {
  constructor(parts) { Object.assign(this, parts); }
  static parse(s) {
    const m = /^(\w+):\/\/([^/]*)([^?]*)\??(.*)$/.exec(s);
    assert.ok(m, `Uri.parse 无法解析: ${s}`);
    return new FakeUri({
      scheme: m[1], authority: m[2], path: m[3], query: m[4] || '',
      fsPath: decodeURIComponent(m[3]), toString: () => s,
    });
  }
  static file(p) {
    return new FakeUri({ scheme: 'file', path: p, fsPath: p, query: '', toString: () => p });
  }
}

const statusMsgs = [];
const statusBarItems = [];
let activeEditor = undefined;
let activeEditorWatchers = [];
const vscodeStub = {
  Uri: FakeUri,
  EventEmitter: class {
    constructor() { this.listeners = []; }
    get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
    fire(v) { this.listeners.forEach((l) => l(v)); }
    dispose() {}
  },
  ViewColumn: { One: 1, Two: 2 },
  ConfigurationTarget: { Global: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    get activeTextEditor() { return activeEditor; },
    onDidChangeActiveTextEditor: (fn) => { activeEditorWatchers.push(fn); return { dispose() {} }; },
    createStatusBarItem: (alignment, priority) => {
      const item = { alignment, priority, text: '', tooltip: '', command: '', shown: false };
      item.show = () => { item.shown = true; };
      item.hide = () => { item.shown = false; };
      item.dispose = () => {};
      statusBarItems.push(item);
      return item;
    },
    showTextDocument: async () => ({ viewColumn: 1 }),
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    setStatusBarMessage: (msg) => { statusMsgs.push(msg); return { dispose() {} }; },
    tabGroups: {
      all: [],
      close: async () => {},
      tabChangeWatchers: [],
      onDidChangeTabs(fn) { this.tabChangeWatchers.push(fn); return { dispose() {} }; },
    },
  },
  workspace: {
    openTextDocument: async () => ({}),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    closeWatchers: [],
    onDidCloseTextDocument(fn) { this.closeWatchers.push(fn); return { dispose() {} }; },
  },
  Disposable: { from: (...ds) => ({ dispose() { ds.forEach((d) => d.dispose && d.dispose()); } }) },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return vscodeStub; }
  return origLoad.call(this, request, parent, isMain);
};

const {
  SLACKER_SCHEME, LANGS, getLang, wrapText, buildFakeCode, slackerUri,
  hashSeed, SlackerController,
} = require('../dist/slacker');

// ---------------------------------------------------------------- 样例数据

const NOVEL = {
  filePath: 'D:/books/吞噬星空2.txt',
  bookTitle: '吞噬星空2',
  author: '我吃西红柿',
  chapters: [
    { index: 0, title: '第1章 起源', content: '夜色渐深，罗峰站在楼顶。\n城市的灯火在他脚下延绵。', wordCount: 20 },
    { index: 1, title: '第2章 试炼', content: '第二天的清晨来得很快，雾气还没有散去。', wordCount: 18 },
  ],
};

function fakeNovel(paras) {
  return { ...NOVEL, chapters: [{ index: 0, title: '第1章 起源', content: paras.join('\n'), wordCount: 10 }] };
}

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ${name}: 通过`);
  } catch (err) {
    console.error(`  ${name}: 失败 -> ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

// ---------------------------------------------------------------- 注释折行

console.log('[摸鱼模式 · 注释折行]');
ok('短文本单行', () => {
  assert.deepStrictEqual(wrapText('你好世界'), ['你好世界']);
});
ok('长文本按宽度折行且不丢字', () => {
  const text = '这是一段很长很长的小说正文内容'.repeat(8);
  const lines = wrapText(text, 46);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 46));
  assert.strictEqual(lines.join(''), text);
});
ok('空白规范化', () => {
  assert.deepStrictEqual(wrapText('  你好   世界  '), ['你好 世界']);
  assert.deepStrictEqual(wrapText('   '), []);
});

// ---------------------------------------------------------------- 语言表

console.log('[摸鱼模式 · 语言表]');
ok(`支持 ${LANGS.length} 种语言且默认 JavaScript 置顶`, () => {
  assert.ok(LANGS.length >= 14, `实际 ${LANGS.length}`);
  assert.strictEqual(LANGS[0].id, 'javascript');
});
ok('id / ext 无重复', () => {
  assert.strictEqual(new Set(LANGS.map((l) => l.id)).size, LANGS.length);
  assert.strictEqual(new Set(LANGS.map((l) => l.ext)).size, LANGS.length);
});
ok('getLang 未知 id 回退 JavaScript', () => {
  assert.strictEqual(getLang('nope').id, 'javascript');
  assert.strictEqual(getLang(undefined).id, 'javascript');
});

// ---------------------------------------------------------------- 代码生成

console.log('[摸鱼模式 · 伪代码生成]');
const src = { chapterTitle: '第274章 雨澜城', paragraphs: ['雨澜城的清晨，薄雾还未散尽。', '罗峰站在城主府的了望塔上远眺。'] };

ok('默认 JS: 每个段落以行注释出现', () => {
  const code = buildFakeCode(src, 'javascript', 42);
  const commentLines = code.split('\n').filter((l) => l.startsWith('// '));
  assert.ok(commentLines.length >= 2);
  for (const p of src.paragraphs) {
    const head = p.slice(0, 8);
    assert.ok(commentLines.some((l) => l.includes(head)), `缺少段落注释: ${head}`);
  }
});
ok('伪代码包含真实感片段(函数/配置)', () => {
  const code = buildFakeCode(src, 'javascript', 42);
  assert.ok(/function |const |=>/.test(code), '缺少 JS 代码特征');
});
ok('章节标题以批次注释出现', () => {
  const code = buildFakeCode(src, 'javascript', 42);
  assert.ok(code.includes('[batch 1]'), '缺少批次注释');
  assert.ok(code.includes('第274章 雨澜城'), '缺少章节标题');
});
ok('种子稳定: 同参数输出一致, 异种子不同', () => {
  const a = buildFakeCode(src, 'javascript', 123456);
  const b = buildFakeCode(src, 'javascript', 123456);
  const c = buildFakeCode(src, 'javascript', 654321);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});
ok('全部语言可生成且段落注释前缀正确', () => {
  for (const lang of LANGS) {
    const code = buildFakeCode(src, lang.id, 7);
    assert.ok(code.trim().length > 50, `${lang.id} 输出过短`);
    const head = src.paragraphs[0].slice(0, 6);
    const lines = code.split('\n');
    const hit = lines.find((l) => l.includes(head));
    assert.ok(hit, `${lang.id} 缺少段落注释`);
    const prefixes = { javascript: '//', typescript: '//', python: '#', java: '//', go: '//', csharp: '//', cpp: '//', rust: '//', php: '//', ruby: '#', sql: '--', html: '<!--', css: '/*', shellscript: '#' };
    assert.ok(hit.trimStart().startsWith(prefixes[lang.id]), `${lang.id} 注释前缀错误: ${hit}`);
  }
});
ok('块注释语言转义闭合符(段落含 */ 或 -->)', () => {
  const paras = ['这段里有闭合符号 */ 和 --> 必须被转义'];
  const css = buildFakeCode({ chapterTitle: 't', paragraphs: paras }, 'css', 3);
  const cline = css.split('\n').find((l) => l.includes('这段里有闭合符号'));
  assert.ok(cline.startsWith('/* ') && cline.endsWith(' */'), `css 注释行格式异常: ${cline}`);
  assert.ok(!cline.slice(3, -3).includes('*/'), `css 注释未转义 */: ${cline}`);
  const html = buildFakeCode({ chapterTitle: 't', paragraphs: paras }, 'html', 3);
  const hline = html.split('\n').find((l) => l.includes('这段里有闭合符号'));
  assert.ok(hline.startsWith('<!-- ') && hline.endsWith(' -->'), `html 注释行格式异常: ${hline}`);
  assert.ok(!hline.slice(5, -4).includes('-->'), `html 注释未转义 -->: ${hline}`);
});
ok('空段落被过滤', () => {
  const code = buildFakeCode({ chapterTitle: 'x', paragraphs: ['', '   ', '有内容的一段'] }, 'javascript', 5);
  assert.ok(code.includes('有内容的一段'));
});

// ---------------------------------------------------------------- URI

console.log('[摸鱼模式 · 虚拟文档 URI]');
ok('URI 往返: scheme/扩展名/query 可解析', () => {
  const lang = getLang('python');
  const uri = slackerUri(NOVEL, 1, lang);
  assert.strictEqual(uri.scheme, SLACKER_SCHEME);
  assert.ok(uri.path.endsWith('.py'), `扩展名错误: ${uri.path}`);
  const q = new URLSearchParams(uri.query);
  assert.strictEqual(q.get('book'), NOVEL.filePath);
  assert.strictEqual(q.get('idx'), '1');
  assert.strictEqual(q.get('lang'), 'python');
});
ok('章节名特殊字符被清洗', () => {
  const n = { ...NOVEL, chapters: [{ index: 0, title: '第1章: 起源/试炼?', content: 'x', wordCount: 1 }] };
  const uri = slackerUri(n, 0, getLang('javascript'));
  assert.ok(!/[/?]/.test(decodeURIComponent(uri.path.slice(1))), `路径含非法字符: ${uri.path}`);
});

// ---------------------------------------------------------------- Controller

console.log('[摸鱼模式 · 会话控制]');

function makeController(novel, tabState) {
  const progress = [];
  const langCfg = { value: 'javascript' };
  statusBarItems.length = 0;
  activeEditorWatchers = [];
  vscodeStub.window.tabGroups.tabChangeWatchers.length = 0;
  vscodeStub.workspace.closeWatchers.length = 0;
  const shelfState = { progressIndex: 0 };
  const stateChanges = [];
  const ctrl = new SlackerController({
    getNovel: async () => novel,
    getLanguage: () => langCfg.value,
    setLanguage: (id) => { langCfg.value = id; return Promise.resolve(); },
    onProgress: (fp, idx) => progress.push([fp, idx]),
    onStateChange: (active) => stateChanges.push(active),
    listBooks: () => [
      { filePath: novel.filePath, title: novel.bookTitle, author: novel.author || '',
        chapterIndex: shelfState.progressIndex, totalChapters: novel.chapters.length, current: true },
      { filePath: 'D:/books/另一本.txt', title: '另一本书', author: '作者乙',
        chapterIndex: 4, totalChapters: 30, current: false },
    ],
    switchBook: async () => null, // 默认不切书, 具体 case 覆盖
    getProgress: () => shelfState.progressIndex,
  });
  ctrl.register();
  return { ctrl, progress, langCfg, setShelfProgress: (v) => { shelfState.progressIndex = v; }, stateChanges };
}

(async () => {
  await ok('open: 打开当前进度章节并写回书架', async () => {
    statusMsgs.length = 0;
    const { ctrl, progress } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    assert.deepStrictEqual(progress, [[NOVEL.filePath, 0]]);
  });
  await ok('provideTextDocumentContent: 生成并缓存, 二次取同内容', async () => {
    const { ctrl } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0); // 写入 novels/contents 缓存
    const uri = slackerUri(NOVEL, 0, getLang('javascript'));
    const first = ctrl.provideTextDocumentContent(uri);
    assert.ok(first.includes('// '));
    assert.ok(first.includes('罗峰站在'));
    assert.strictEqual(ctrl.provideTextDocumentContent(uri), first, '缓存不一致');
  });
  await ok('step: 下一章/上一章, 越界停在原章并提示', async () => {
    statusMsgs.length = 0;
    const { ctrl, progress } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    await ctrl.step(1);
    assert.deepStrictEqual(progress.at(-1), [NOVEL.filePath, 1]);
    await ctrl.step(1); // 越界
    assert.ok(statusMsgs.some((m) => m.includes('最后一章')), `缺少越界提示: ${statusMsgs}`);
    assert.strictEqual(progress.at(-1)[1], 1);
    await ctrl.step(-1);
    assert.strictEqual(progress.at(-1)[1], 0);
    await ctrl.step(-1); // 越界
    assert.ok(statusMsgs.some((m) => m.includes('第一章')));
    assert.strictEqual(progress.at(-1)[1], 0);
  });
  await ok('boss: 关闭全部 novelfish 标签页, 忽略其它文档', async () => {
    const fishTab = { input: { uri: slackerUri(NOVEL, 0, getLang('javascript')) } };
    const fileTab = { input: { uri: FakeUri.file('D:/work/index.js') } };
    const closed = [];
    const tg = vscodeStub.window.tabGroups;
    tg.all = [{ tabs: [fishTab, fileTab] }, { tabs: [fishTab] }];
    const origClose = tg.close;
    tg.close = async (tabs) => { closed.push(...tabs); };
    const { ctrl, stateChanges } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    assert.strictEqual(ctrl.isActive, true, '会话中 isActive 应为 true');
    assert.strictEqual(stateChanges.at(-1), true, '开启应回调 true');
    await ctrl.boss();
    assert.strictEqual(ctrl.isActive, false, '老板键后 isActive 应为 false');
    assert.strictEqual(stateChanges.at(-1), false, '关闭应回调 false');
    assert.strictEqual(closed.length, 2, `应关闭 2 个摸鱼标签, 实际 ${closed.length}`);
    assert.ok(closed.every((t) => t.input.uri.scheme === SLACKER_SCHEME));
    tg.all = [];
    tg.close = origClose;
  });
  await ok('pickLanguage: 取消选择不动作', async () => {
    const { ctrl, langCfg } = makeController(NOVEL);
    await ctrl.pickLanguage(); // QuickPick 返回 undefined
    assert.strictEqual(langCfg.value, 'javascript');
  });

  // ---------------------------------------------------------------- 状态栏控制条

  console.log('[摸鱼模式 · 状态栏控制条]');
  await ok('register: 创建 上一章/下一章/跳章/目录/书架 五个左对齐状态栏项(紧邻「小说阅读」)', () => {
    const { ctrl } = makeController(NOVEL);
    void ctrl;
    assert.strictEqual(statusBarItems.length, 5, `实际 ${statusBarItems.length}`);
    const cmds = statusBarItems.map((i) => i.command);
    for (const c of ['slackerPrev', 'slackerNext', 'slackerJump', 'slackerCatalog', 'slackerShelf']) {
      assert.ok(cmds.some((x) => x === `novelReader.${c}`), `缺少 ${c}`);
    }
    // 左下角: 与「小说阅读」入口(prio 100)同侧, priority 99~95 紧随其右
    assert.ok(statusBarItems.every((i) => i.alignment === 1 /* Left */), '应左对齐');
    assert.deepStrictEqual(statusBarItems.map((i) => i.priority), [99, 98, 97, 96, 95]);
  });
  await ok('refreshBar: 摸鱼文档激活显示, 切走/关闭隐藏', async () => {
    const { ctrl } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    ctrl.refreshBar();
    assert.ok(statusBarItems.every((i) => !i.shown), '非摸鱼编辑器不应显示');
    activeEditor = { document: { uri: slackerUri(NOVEL, 0, getLang('javascript')) } };
    ctrl.refreshBar();
    assert.ok(statusBarItems.every((i) => i.shown), '摸鱼文档激活时应全部显示');
    activeEditor = { document: { uri: FakeUri.file('D:/work/a.js') } };
    ctrl.refreshBar();
    assert.ok(statusBarItems.every((i) => !i.shown), '切到普通文件应隐藏');
    activeEditor = undefined;
  });
  await ok('watcher: 活动编辑器变化自动刷新显隐', async () => {
    const { ctrl } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    activeEditor = { document: { uri: slackerUri(NOVEL, 0, getLang('javascript')) } };
    activeEditorWatchers.forEach((fn) => fn());
    assert.ok(statusBarItems.every((i) => i.shown));
    activeEditor = undefined;
    activeEditorWatchers.forEach((fn) => fn());
    assert.ok(statusBarItems.every((i) => !i.shown));
  });
  await ok('手动关闭摸鱼标签: 会话结束并回调 false(高亮熄灭)', async () => {
    const { ctrl, stateChanges } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    assert.strictEqual(stateChanges.at(-1), true);
    // 模拟用户点 X 关掉唯一的摸鱼标签: tabGroups 清空 + 触发 onDidChangeTabs(真实主通道)
    const tg2 = vscodeStub.window.tabGroups;
    tg2.all = [];
    const closedTab = { input: { uri: slackerUri(NOVEL, 0, getLang('javascript')) } };
    tg2.tabChangeWatchers.forEach((fn) =>
      fn({ closed: [closedTab], opened: [], changed: [] }));
    assert.strictEqual(ctrl.isActive, false, '关闭标签后会话应结束');
    assert.strictEqual(stateChanges.at(-1), false, '应回调 false 熄灭高亮');
    // 兜底通道: onDidCloseTextDocument 先到(标签已无 novelfish)也不应报错/重复结束
    vscodeStub.workspace.closeWatchers.forEach((fn) =>
      fn({ uri: slackerUri(NOVEL, 0, getLang('javascript')) }));
    assert.strictEqual(ctrl.isActive, false, '兜底通道不应误报异常');
    // 翻章替换文档: closed(旧)+opened(新) 同批, 仍有摸鱼标签在, 不应误判结束
    await ctrl.open(NOVEL, 1);
    assert.strictEqual(stateChanges.at(-1), true);
    const newFish = { input: { uri: slackerUri(NOVEL, 1, getLang('javascript')) } };
    const oldFish = { input: { uri: slackerUri(NOVEL, 0, getLang('javascript')) } };
    vscodeStub.window.tabGroups.all = [{ tabs: [newFish] }];
    vscodeStub.window.tabGroups.tabChangeWatchers.forEach((fn) =>
      fn({ closed: [oldFish], opened: [newFish], changed: [] }));
    assert.strictEqual(ctrl.isActive, true, '翻章关旧标签不应误判结束');
    assert.strictEqual(stateChanges.at(-1), true);
    // 文档关闭兜底在翻章时同样不应误判
    vscodeStub.workspace.closeWatchers.forEach((fn) => fn({ uri: slackerUri(NOVEL, 0, getLang('javascript')) }));
    assert.strictEqual(ctrl.isActive, true, '翻章时兜底通道不应误判结束');
    // 再真正关掉: 无标签 -> 结束
    vscodeStub.window.tabGroups.all = [];
    vscodeStub.window.tabGroups.tabChangeWatchers.forEach((fn) =>
      fn({ closed: [newFish], opened: [], changed: [] }));
    assert.strictEqual(ctrl.isActive, false, '再次关闭应结束会话');
  });
  await ok('双向同步: 阅读页切章后(书架进度变), 切回摸鱼文档自动跟随', async () => {
    const { ctrl, progress, setShelfProgress } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0); // 摸鱼在第 1 章
    setShelfProgress(1); // 用户在阅读页切到第 2 章(书架进度=1)
    activeEditor = { document: { uri: slackerUri(NOVEL, 0, getLang('javascript')) } };
    ctrl.refreshBar(); // 切回摸鱼文档 -> 应跟随书架进度
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(progress.at(-1)[1], 1, '摸鱼应跟随书架进度到第 2 章');
    // 进度一致: 不动作
    const before = progress.length;
    ctrl.refreshBar();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(progress.length, before, '进度一致不动作');
    // 无有效进度(-1): 不动作
    setShelfProgress(-1);
    ctrl.refreshBar();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(progress.length, before, '无有效进度不动作');
    activeEditor = undefined;
  });
  await ok('catalog: QuickPick 选择章节后跳转(同章/取消不动作)', async () => {
    const picks = [];
    const origQP = vscodeStub.window.showQuickPick;
    vscodeStub.window.showQuickPick = async (items) => { picks.push(items); return items[1]; };
    const { ctrl, progress } = makeController(NOVEL);
    await ctrl.open(NOVEL, 0);
    await ctrl.catalog();
    assert.deepStrictEqual(progress.at(-1), [NOVEL.filePath, 1], '应跳到第 2 章');
    assert.ok(picks[0].some((it) => it.picked), '当前章应有 picked 标记');
    await ctrl.catalog(); // 再选第 2 章(已在) -> 不动作
    assert.strictEqual(progress.length, 2);
    vscodeStub.window.showQuickPick = async () => undefined;
    await ctrl.catalog();
    assert.strictEqual(progress.length, 2, '取消应不动作');
    vscodeStub.window.showQuickPick = origQP;
  });
  await ok('jump: 输入目标章号直接跳转, 越界 clamp 到边界, 取消/非法不动作', async () => {
    // mock 书 10 章
    const big = { ...NOVEL, chapters: Array.from({ length: 10 }, (_, i) => ({ index: i, title: `第${i + 1}章`, content: 'x', wordCount: 1 })) };
    const origIB = vscodeStub.window.showInputBox;
    const { ctrl, progress } = makeController(big);
    await ctrl.open(big, 0);
    vscodeStub.window.showInputBox = async () => '8';
    await ctrl.jump();
    assert.strictEqual(progress.at(-1)[1], 7, '输入 8 应跳到第 8 章(index 7)');
    vscodeStub.window.showInputBox = async () => '3';
    await ctrl.jump();
    assert.strictEqual(progress.at(-1)[1], 2, '输入 3 应跳到第 3 章');
    statusMsgs.length = 0;
    vscodeStub.window.showInputBox = async () => '999';
    await ctrl.jump();
    assert.strictEqual(progress.at(-1)[1], 9, '超出总数应按最后一章处理');
    vscodeStub.window.showInputBox = async () => '0';
    await ctrl.jump();
    assert.strictEqual(progress.at(-1)[1], 0, '小于 1 应按第 1 章处理');
    // 已在目标章: 提示且不重复跳转
    statusMsgs.length = 0;
    const beforeLen = progress.length;
    vscodeStub.window.showInputBox = async () => '1';
    await ctrl.jump();
    assert.strictEqual(progress.length, beforeLen, '同章不重复跳转');
    assert.ok(statusMsgs.some((m) => m.includes('已在第 1 章')), '同章应提示');
    vscodeStub.window.showInputBox = async () => undefined;
    await ctrl.jump();
    assert.strictEqual(progress.at(-1)[1], 0, '取消不动作');
    vscodeStub.window.showInputBox = async () => 'abc';
    await ctrl.jump();
    assert.strictEqual(progress.at(-1)[1], 0, '非法输入应被拦截');
    vscodeStub.window.showInputBox = origIB;
  });
  await   ok('shelf: QuickPick 切书后从该书进度章节打开', async () => {
    // mock 书需要 >= 5 章, 否则进度章节 4 会被 open() clamp
    const otherNovel = {
      ...NOVEL,
      filePath: 'D:/books/另一本.txt',
      bookTitle: '另一本书',
      chapters: [0, 1, 2, 3, 4].map((i) => ({ index: i, title: `第${i + 1}章`, content: '正文', wordCount: 2 })),
    };
    const origQP = vscodeStub.window.showQuickPick;
    const { ctrl, progress } = makeController(NOVEL);
    // 覆盖 switchBook: 返回另一本书
    Object.assign(ctrl, {});
    const ctrlDeps = { switchBook: async () => otherNovel };
    // SlackerController 把 deps 存在构造参数里, 这里直接重建一个带定制 switchBook 的实例
    const ctrl2 = new SlackerController({
      getNovel: async () => NOVEL,
      getLanguage: () => 'javascript',
      setLanguage: () => Promise.resolve(),
      onProgress: (fp, idx) => progress.push([fp, idx]),
      listBooks: () => [
        { filePath: NOVEL.filePath, title: '吞噬星空2', author: '', chapterIndex: 0, totalChapters: 2, current: true },
        { filePath: 'D:/books/另一本.txt', title: '另一本书', author: '作者乙', chapterIndex: 4, totalChapters: 30, current: false },
      ],
      switchBook: async () => otherNovel,
    });
    ctrl2.register();
    void ctrlDeps;
    await ctrl2.open(NOVEL, 0);
    vscodeStub.window.showQuickPick = async (items) => items.find((it) => it.filePath === 'D:/books/另一本.txt');
    await ctrl2.shelf();
    assert.deepStrictEqual(progress.at(-1), [otherNovel.filePath, 4], '应从进度章节打开');
    // 取消: 不动作
    const before = progress.length;
    vscodeStub.window.showQuickPick = async () => undefined;
    await ctrl2.shelf();
    assert.strictEqual(progress.length, before);
    vscodeStub.window.showQuickPick = origQP;
  });

  // ---------------------------------------------------------------- 清单断言

  console.log('[摸鱼模式 · 命令与快捷键清单]');
  const fs = require('fs');
  const path = require('path');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const cmds = new Set(pkg.contributes.commands.map((c) => c.command));
  await ok('commands: 8 个摸鱼命令齐备', () => {
    for (const c of ['slackerStart', 'slackerNext', 'slackerPrev', 'slackerLanguage', 'slackerCatalog', 'slackerShelf', 'slackerJump', 'slackerBoss']) {
      assert.ok(cmds.has(`novelReader.${c}`), `缺少命令 novelReader.${c}`);
    }
  });
  await ok('keybindings: 启动 ctrl+alt+s, 老板键 alt+b, 翻章 ctrl+alt+←/→', () => {
    const kb = pkg.contributes.keybindings || [];
    const byCmd = Object.fromEntries(kb.map((k) => [k.command, k]));
    assert.strictEqual(byCmd['novelReader.slackerStart'].key, 'ctrl+alt+s');
    assert.strictEqual(byCmd['novelReader.slackerBoss'].key, 'alt+b');
    assert.strictEqual(byCmd['novelReader.slackerNext'].key, 'ctrl+alt+arrowright');
    assert.strictEqual(byCmd['novelReader.slackerPrev'].key, 'ctrl+alt+arrowleft');
    // 启动键: 有书即可按; 老板键与翻章: 仅摸鱼文档激活时响应, 不占用全局按键
    assert.ok(
      byCmd['novelReader.slackerStart'].when.includes('novelReader.hasNovel'),
      '启动键缺少 hasNovel 条件'
    );
    for (const c of ['slackerBoss', 'slackerNext', 'slackerPrev']) {
      assert.ok(
        (byCmd[`novelReader.${c}`].when || '').includes('activeEditorScheme == novelfish'),
        `novelReader.${c} 缺少 novelfish 限定`
      );
    }
  });
  await ok('configuration: slackerLanguage 默认 javascript 且枚举与语言表一致', () => {
    const prop = pkg.contributes.configuration.properties['novelReader.slackerLanguage'];
    assert.strictEqual(prop.default, 'javascript');
    assert.deepStrictEqual(
      new Set(prop.enum),
      new Set(LANGS.map((l) => l.id)),
      '枚举与 LANGS 不一致'
    );
  });
  await ok('extension.ts: 摸鱼命令全部接线', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    for (const c of ['slackerStart', 'slackerNext', 'slackerPrev', 'slackerLanguage', 'slackerCatalog', 'slackerShelf', 'slackerJump', 'slackerBoss']) {
      assert.ok(src.includes(`'novelReader.${c}'`), `extension.ts 未注册 ${c}`);
    }
    assert.ok(src.includes('new SlackerController'), '缺少控制器实例化');
    // 先摸鱼后开阅读器: 面板 init 时要补发会话状态(高亮不丢)
    assert.ok(src.includes('ReaderPanel.slackerStateProvider = () => slacker.isActive'),
      'extension.ts 未注入摸鱼状态实时查询');
    const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'readerPanel.ts'), 'utf8');
    assert.ok(panel.includes("'slackerStart'"), '阅读面板未转发摸鱼入口消息');
    assert.ok(panel.includes('slackerStateProvider'), '阅读面板缺少摸鱼状态查询钩子');
    const postInit = panel.slice(panel.indexOf('private _postInit'));
    assert.ok(/slackerActive/.test(postInit), '_postInit 未向新 webview 补发 slackerActive');
  });

  if (process.exitCode !== 1) {
    console.log(`\n摸鱼模式测试全部通过 ✔ (${passed} 项)`);
  }
})().catch(() => {});
