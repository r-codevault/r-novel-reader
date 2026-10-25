/**
 * test-ownership.js — 归属协议与请求生命周期回归(Node, 直接驱动 dist/readerPanel.js)
 *
 * 覆盖 PRD R2-01 ~ R2-07 里可自动化的部分:
 *  1. 章节/预览回包必须带 `filePath` + `reqId`（I5 归属必填）；
 *  2. A 书的迟到正文**不得**投递给 B 书，但**仍要**写进 A 自己的缓存（I4）；
 *  3. 换书会清掉加载锁，切回 A 后同章可以重新加载；
 *  4. 同章重试产生两轮时：第一轮的回包被丢弃，且第一轮结束**不释放**第二轮的锁（I2/I3）；
 *  5. 下载控制按 `filePath` 生效（B 为当前书时仍能暂停 A）；
 *  6. 静态守卫：`_loadOnlineChapter` 体内不允许出现 `this._novel`（I1）。
 *
 * 运行: node scripts/test-ownership.js（需先 npm run compile）
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ---------- vscode 桩（与 test-panel-msg.js 同型） ----------
const posted = [];
const listeners = [];

const fakeWebview = {
    html: '',
    get onDidReceiveMessage() { return (fn) => listeners.push(fn); },
    postMessage: async (m) => { posted.push(m); return true; },
    asWebviewUri: (u) => u,
    cspSource: 'stub',
};

const fakePanel = {
    webview: fakeWebview,
    title: '',
    visible: true,
    get onDidDispose() { return (fn) => { /* 不需要 */ }; },
    reveal: () => {},
    dispose: () => {},
};

const vscodeStub = {
    WebviewPanel: class {},
    ViewColumn: { One: 1 },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    workspace: {
        fs: { readFile: async () => Buffer.from('') },
        getConfiguration: () => ({ get: () => undefined, has: () => false, update: async () => {} }),
    },
    window: {
        createWebviewPanel: () => fakePanel,
        registerWebviewPanelSerializer: () => ({}),
        showErrorMessage: () => {},
        showWarningMessage: () => {},
        showInformationMessage: () => {},
        setStatusBarMessage: () => {},
    },
    commands: { registerCommand: () => ({}), executeCommand: async () => {} },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return vscodeStub; }
    return origLoad.call(this, request, parent, isMain);
};

const { ReaderPanel } = require('../dist/readerPanel.js');
const { SettingsStore, DEFAULT_SETTINGS } = require('../dist/settings.js');

const tick = () => new Promise((r) => setTimeout(r, 10));
function fire(msg) { for (const fn of listeners) { fn(msg); } }

// ---------- 夹具 ----------
/** 可控章节 loader: 每次调用返回一个由测试决定何时 resolve 的 Promise */
const pending = [];
ReaderPanel.onlineChapterLoader = (novel, index) => new Promise((resolve) => {
    pending.push({ novel, index, resolve });
});

function makeOnlineNovel(filePath, title, chapterCount) {
    const chapters = [];
    for (let i = 0; i < chapterCount; i += 1) {
        chapters.push({ index: i, title: title + ' 第 ' + (i + 1) + ' 章', content: '', url: 'http://x/' + i, wordCount: 0 });
    }
    return {
        filePath,
        bookTitle: title,
        author: '作者',
        chapters,
        preface: '',
        encoding: 'utf-8',
        totalWords: 0,
        online: { sourceId: 's', sourceName: '测试源', bookUrl: 'http://x/' + filePath },
    };
}

function makeLocalNovel(filePath, title) {
    return {
        filePath,
        bookTitle: title,
        author: '作者',
        chapters: [{ index: 0, title: '第 1 章', content: '本地正文', start: 0, end: 4, wordCount: 4 }],
        preface: '',
        encoding: 'utf-8',
        totalWords: 4,
    };
}

const KEY_A = 'online://s/aaa';
const KEY_B = 'online://s/bbb';

(async function main() {
    const store = new SettingsStore({ get: () => undefined, update: async () => {} });
    store.get = () => DEFAULT_SETTINGS;

    const novelA = makeOnlineNovel(KEY_A, 'A 书', 6);
    const novelB = makeLocalNovel(KEY_B, 'B 书');

    // ---------- 1) 首帧: chapterLoading 带归属 ----------
    ReaderPanel.createOrShow(novelA, 4, 0, store);
    fire({ type: 'ready' });
    await tick();

    const initMsg = posted.find((m) => m.type === 'init');
    assert(initMsg, 'ready 之后必须回 init');
    assert.strictEqual(initMsg.payload.protocolVersion, 2, 'init 必须声明 protocolVersion=2');
    assert(Array.isArray(initMsg.payload.downloadTasks), 'init 必须带 downloadTasks 快照');

    const loading1 = posted.find((m) => m.type === 'chapterLoading');
    assert(loading1, '在线书首章正文为空时必须回 chapterLoading');
    assert.strictEqual(loading1.payload.filePath, KEY_A, 'chapterLoading 必须带 filePath');
    assert.strictEqual(typeof loading1.payload.reqId, 'number', 'chapterLoading 必须带 reqId');
    assert.strictEqual(pending.length, 1, '应只有一轮在途请求');
    const reqId1 = loading1.payload.reqId;

    // ---------- 2) A 的迟到正文不得投递给 B ----------
    posted.length = 0;
    ReaderPanel.createOrShow(novelB, 0, 0, store);
    await tick();
    assert(
        posted.some((m) => m.type === 'init' && m.payload.filePath === KEY_B),
        '切换后应立刻投递 B 书的 init'
    );

    posted.length = 0;
    pending[0].resolve(['A 的正文']);
    await tick();
    assert(
        !posted.some((m) => m.type === 'chapter' && m.payload && m.payload.filePath === KEY_A),
        'A 的迟到正文不得投递给 B'
    );
    assert(
        !posted.some((m) => m.type === 'chapterCached' && m.payload && m.payload.filePath === KEY_A),
        'A 的缓存点位不得投给 B'
    );
    // I4: 缓存写入与投递分离 —— 迟到回包仍要落进 A 自己的章节对象
    assert.strictEqual(pending[0].novel.chapters[4].content, 'A 的正文', 'A 的缓存写入仍应生效(I4)');

    // ---------- 3) 换书清锁: 切回 A 后同章可以重新加载 ----------
    posted.length = 0;
    ReaderPanel.createOrShow(novelA, 3, 0, store);
    await tick();
    const loading2 = posted.find((m) => m.type === 'chapterLoading');
    assert(loading2, '换书后同章锁必须已释放, 可再次加载');
    assert.strictEqual(loading2.payload.filePath, KEY_A, 'chapterLoading 归属应为 A');
    // 记下第二轮的 reqId 供后面轮次断言
    const reqId2 = loading2.payload.reqId;
    assert(reqId2 > reqId1, 'reqId 必须单调递增');

    // ---------- 4) 同章重试两轮: 旧轮丢弃, 锁按请求实例释放(I2/I3) ----------
    const beforeRetry = pending.length;
    fire({ type: 'retryChapter', index: 3 });
    await tick();
    const loading3 = posted.filter((m) => m.type === 'chapterLoading').slice(-1)[0];
    assert(pending.length === beforeRetry + 1, '重试应开出新一轮请求');
    const reqId3 = loading3.payload.reqId;
    assert(reqId3 > reqId2, '重试轮的 reqId 必须更大');

    posted.length = 0;
    // 让**第一轮**(reqId2)先回来
    pending[beforeRetry - 1].resolve(['第一轮正文']);
    await tick();
    assert(
        !posted.some((m) => m.type === 'chapter'),
        '第一轮的回包必须被丢弃(reqId 已不是唯一活请求)'
    );
    // I3: 第一轮结束不得释放第二轮持有的锁
    const locks = ReaderPanel.current._chapterLocks;
    assert.strictEqual(locks.size, 1, '第二轮仍应持锁, 实际锁数 ' + locks.size);
    assert.strictEqual(locks.get(Array.from(locks.keys())[0]), reqId3, '锁必须仍属于第二轮 reqId');

    // 第二轮回来才投递
    pending[pending.length - 1].resolve(['第二轮正文']);
    await tick();
    const delivered = posted.filter((m) => m.type === 'chapter').slice(-1)[0];
    assert(delivered, '第二轮回包应投递 chapter');
    assert.strictEqual(delivered.payload.reqId, reqId3, '投递的必须是第二轮 reqId');
    assert.strictEqual(delivered.payload.filePath, KEY_A, 'chapter 必须带 filePath');
    assert.deepStrictEqual(delivered.payload.paragraphs, ['第二轮正文'], '正文应来自第二轮');
    assert.strictEqual(locks.size, 0, '第二轮结束后锁应释放');

    // ---------- 5) 下载归属与按 key 控制 ----------
    const pausedKeys = [];
    ReaderPanel.offline = {
        stats: () => ({ bytes: 0, books: 0 }),
        status: () => undefined,
        start: async () => ({ ok: true }),
        pause: (key) => { pausedKeys.push(key); return true; },
        resume: (key) => { pausedKeys.push('resume:' + key); return true; },
        cancel: (key) => { pausedKeys.push('cancel:' + key); },
        exportTxt: async () => ({ ok: true }),
        clearCurrent: async () => {},
        clearAll: async () => {},
        tasks: () => [{
            filePath: KEY_A, bookTitle: 'A 书',
            done: 3, total: 10, failed: 0, running: true, paused: false, updatedAt: 1,
        }],
    };

    posted.length = 0;
    ReaderPanel.current.postDownloadTasks();
    const tasksMsg = posted.find((m) => m.type === 'downloadTasks');
    assert(tasksMsg, '必须能下发下载任务表全量快照');
    assert.strictEqual(tasksMsg.payload.tasks[0].filePath, KEY_A, '任务表按 filePath 键');

    posted.length = 0;
    ReaderPanel.current.postDownloadProgress({
        done: 4, total: 10, failed: 0, running: true, paused: false, filePath: KEY_A, bookTitle: 'A 书',
    });
    const prog = posted.find((m) => m.type === 'downloadProgress');
    assert(prog, '应下发 downloadProgress');
    assert.strictEqual(prog.payload.filePath, KEY_A, 'downloadProgress 必须带 filePath');
    assert.strictEqual(prog.payload.bookTitle, 'A 书', 'downloadProgress 应带 bookTitle');

    // 当前书是 A, 但暂停请求针对另一个 key（模拟"在 B 的界面里暂停 A"）
    fire({ type: 'downloadPause', filePath: KEY_B });
    fire({ type: 'downloadResume', filePath: KEY_B });
    fire({ type: 'downloadCancel', filePath: KEY_B });
    assert.deepStrictEqual(pausedKeys, [KEY_B, 'resume:' + KEY_B, 'cancel:' + KEY_B],
        '下载控制必须作用于消息里显式给出的 key');

    // ---------- 6) 写操作终态通道 ----------
    posted.length = 0;
    ReaderPanel.current.postOpResult({ opId: 'op1', op: 'notes:remove', ok: false, message: '磁盘写入失败' });
    const opMsg = posted.find((m) => m.type === 'opResult');
    assert(opMsg, '必须能下发 opResult');
    assert.strictEqual(opMsg.payload.opId, 'op1', 'opResult 必须原样回传 opId');
    assert.strictEqual(opMsg.payload.ok, false, 'opResult.ok 应如实反映失败');

    // ---------- 7) 静态守卫: I1 (await 之后不得再读 this._novel) ----------
    const distText = fs.readFileSync(path.join(__dirname, '..', 'dist', 'readerPanel.js'), 'utf8');
    const start = distText.indexOf('_loadOnlineChapter(task)');
    // 用定义处的签名定位结尾：方法体里调用的是 `_retryChapter(msg.index)`,
    // 和定义签名 `_retryChapter(index)` 不同, 不会误命中调用点
    let end = distText.indexOf('_retryChapter(index)', start);
    if (end <= start) { end = Math.min(distText.length, start + 4000); }
    assert(start > 0 && end > start, '应能在 dist/readerPanel.js 里定位 _loadOnlineChapter');
    const body = distText.slice(start, end);
    assert(
        body.indexOf('this._novel') < 0,
        '_loadOnlineChapter 体内不得出现 this._novel(I1 捕获即冻结)'
    );

    console.log('归属协议与请求生命周期(迟到回包/缓存写入/换书清锁/重试两轮/下载按键/opResult/I1): 全部通过 ✔');
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e && e.message ? e.message : e);
    if (e && e.stack) { console.error(e.stack); }
    process.exit(1);
});
