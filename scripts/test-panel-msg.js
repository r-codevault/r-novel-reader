/**
 * test-panel-msg.js — 用 vscode 桩直接驱动 dist/readerPanel.js,
 * 验证 getChapter 消息路径(点击上一章/下一章后扩展是否回 'chapter')
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');

// ---------- vscode 桩 ----------
const posted = []; // panel -> webview 消息
const listeners = []; // webview -> panel 消息监听
let disposed = [];

const fakeWebview = {
    html: '',
    get onDidReceiveMessage() {
        return (fn) => listeners.push(fn);
    },
    postMessage: async (m) => { posted.push(m); return true; },
    asWebviewUri: (u) => u,
    cspSource: 'stub',
};

const fakePanel = {
    webview: fakeWebview,
    title: '',
    visible: true,
    get onDidDispose() { return (fn) => { disposed.push(fn); }; },
    reveal: () => {},
    dispose: () => { disposed.forEach((f) => f()); disposed = []; },
};

const vscodeStub = {
    WebviewPanel: class {},
    ViewColumn: { One: 1 },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    workspace: {
        fs: { readFile: async () => Buffer.from('第一卷 测试\n第一章 a\n内容a\n第二章 b\n内容b\n第三章 c\n内容c\n') },
        getConfiguration: () => ({ get: () => undefined, has: () => false, update: async () => {} }),
    },
    window: {
        createWebviewPanel: () => fakePanel,
        registerWebviewPanelSerializer: () => ({}),
        showErrorMessage: (m) => console.log('[err]', m),
    },
    commands: {
        registerCommand: () => ({}),
        executeCommand: async () => {},
    },
};

// 注入桩: 拦截 'vscode' 模块加载(纯内存, 不在仓库里落临时文件)
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return vscodeStub; }
    return origLoad.call(this, request, parent, isMain);
};

const { ReaderPanel } = require('../dist/readerPanel.js');
const { SettingsStore } = require('../dist/settings.js');

(async function main() {
    const store = new SettingsStore({
        get: () => undefined,
        update: async () => {},
    });
    const { DEFAULT_SETTINGS } = require('../dist/settings.js');
    store.get = () => DEFAULT_SETTINGS;
    ReaderPanel.onDidChangeChapter = (i) => console.log('[onDidChangeChapter]', i);

    const novel = {
        filePath: 'D:/mock/book.txt',
        bookTitle: '测试书',
        chapters: [
            { title: '第一章 a', content: '内容a', start: 0, end: 10 },
            { title: '第二章 b', content: '内容b', start: 10, end: 20 },
            { title: '第三章 c', content: '内容c', start: 20, end: 30 },
        ],
    };
    ReaderPanel.createOrShow(novel, 1, 0, store);

    // webview 就绪
    for (const fn of listeners) { fn({ type: 'ready' }); }
    await new Promise((r) => setTimeout(r, 50));
    console.log('after ready, posted:', posted.map((m) => m.type));

    // 模拟点击「下一章」: webview 发 getChapter index=2
    for (const fn of listeners) { fn({ type: 'getChapter', index: 2 }); }
    await new Promise((r) => setTimeout(r, 50));
    console.log('after next, posted:', posted.map((m) => m.type + ':' + (m.payload ? m.payload.index : '')));
    assert(posted.some((m) => m.type === 'chapter' && m.payload.index === 2), '下一章应回 chapter index=2');

    // 模拟点击「上一章」
    for (const fn of listeners) { fn({ type: 'getChapter', index: 1 }); }
    await new Promise((r) => setTimeout(r, 50));
    assert(posted.some((m) => m.type === 'chapter' && m.payload.index === 1), '上一章应回 chapter index=1');

    // ---------- v1.35.4: 位置记忆 ----------
    const lastChapter = () => posted.filter((m) => m.type === 'chapter').slice(-1)[0];

    // 在第2章读到 70%(模拟滚动上报), 再「上一章」回第1章应落底部
    for (const fn of listeners) { fn({ type: 'getChapter', index: 2 }); }
    await new Promise((r) => setTimeout(r, 30));
    for (const fn of listeners) { fn({ type: 'getChapter', index: 1, dir: 'prev', curRatio: 0.7 }); }
    await new Promise((r) => setTimeout(r, 30));
    assert(lastChapter().payload.scrollRatio === 1, '上一章应落在底部(scrollRatio=1)');

    for (const fn of listeners) { fn({ type: 'saveProgress', chapterIndex: 1, scrollRatio: 0.7 }); }
    // 切到第3章再切回第2章 → 应恢复 70%
    for (const fn of listeners) { fn({ type: 'getChapter', index: 2, dir: 'next', curRatio: 0.7 }); }
    await new Promise((r) => setTimeout(r, 30));
    for (const fn of listeners) { fn({ type: 'getChapter', index: 1, curRatio: 0 }); }
    await new Promise((r) => setTimeout(r, 30));
    assert(
        Math.abs(lastChapter().payload.scrollRatio - 0.7) < 1e-6,
        '切回读过的章节应恢复 70% 位置, 实际 ' + lastChapter().payload.scrollRatio
    );

    // 没读过的章节 → 回顶部
    for (const fn of listeners) { fn({ type: 'getChapter', index: 0 }); }
    await new Promise((r) => setTimeout(r, 30));
    assert(lastChapter().payload.scrollRatio === 0, '没有位置记忆的章节应回顶部');

    console.log('扩展侧 getChapter 消息路径 + 位置记忆(prev落底/切回恢复比例/无记忆回顶): 全部通过 ✔');
    process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
