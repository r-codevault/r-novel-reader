/**
 * readerPanel.ts — 阅读界面(WebviewPanel)
 *
 * 功能:
 *  - 章节正文渲染(自动转义, 按段拆分)
 *  - 章节目录下拉跳转 / 上一章 / 下一章(按钮 + Alt+←/→)
 *  - 阅读设置面板: 字体大小、字体族、行距、段距、阅读宽度、主题配色, 实时生效
 *  - 阅读进度(当前章节 + 滚动位置)自动保存
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Novel } from './novelParser';
import { FONTS, ReadingSettings, SettingsStore, THEMES, fontStackById, themeById } from './settings';

interface InitPayload {
    filePath: string;
    bookTitle: string;
    author: string;
    chapters: { index: number; title: string }[];
    chapterIndex: number;
    chapterTitle: string;
    paragraphs: string[];
    totalChapters: number;
    totalWords: number;
    settings: ReadingSettings;
    /** 打开时自动展开设置面板 */
    openSettings?: boolean;
}

interface ChapterPayload {
    index: number;
    title: string;
    paragraphs: string[];
    totalChapters: number;
    scrollRatio: number;
}

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'getChapter'; index: number }
    | { type: 'updateSettings'; patch: Partial<ReadingSettings> }
    | { type: 'resetSettings' }
    | { type: 'saveProgress'; chapterIndex: number; scrollRatio: number }
    | { type: 'openFile' };

export class ReaderPanel {
    public static readonly viewType = 'novelReader.reader';
    public static current: ReaderPanel | undefined;
    /** 章节变化回调(供侧边栏「当前阅读」条与目录同步) */
    public static onDidChangeChapter?: (index: number) => void;
    /** 阅读进度回调(由插件入口写入书架) */
    public static onProgress?: (chapterIndex: number, scrollRatio: number) => void;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _store: SettingsStore;
    private _novel: Novel;
    private _chapterIndex: number;
    private _settings: ReadingSettings;
    private _scrollRatio = 0;
    private _ready = false;
    private _openSettingsOnLoad = false;
    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        novel: Novel,
        chapterIndex: number,
        scrollRatio: number,
        store: SettingsStore
    ) {
        this._panel = panel;
        this._novel = novel;
        this._chapterIndex = Math.min(Math.max(0, chapterIndex), Math.max(0, novel.chapters.length - 1));
        this._scrollRatio = scrollRatio;
        this._store = store;
        this._settings = store.get();

        this._panel.webview.html = this._getHtml(this._settings);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this._onMessage(msg),
            null,
            this._disposables
        );
    }

    /** 打开或复读阅读面板 */
    static createOrShow(
        novel: Novel,
        chapterIndex: number,
        scrollRatio: number,
        store: SettingsStore,
        column: vscode.ViewColumn = vscode.ViewColumn.One,
        openSettings = false
    ): void {
        if (ReaderPanel.current) {
            const cur = ReaderPanel.current;
            const sameFile = cur._novel.filePath === novel.filePath;
            cur._novel = novel;
            cur._chapterIndex = Math.min(Math.max(0, chapterIndex), Math.max(0, novel.chapters.length - 1));
            cur._scrollRatio = scrollRatio;
            cur._openSettingsOnLoad = openSettings;
            if (sameFile && cur._ready) {
                cur._postChapter();
            } else {
                cur._ready = false;
                cur._postInit();
            }
            cur._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(ReaderPanel.viewType, `${novel.bookTitle} - 小说阅读`, column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [],
        });
        ReaderPanel.current = new ReaderPanel(panel, novel, chapterIndex, scrollRatio, store);
        ReaderPanel.current._openSettingsOnLoad = openSettings;
    }

    /** 侧边栏点击章节 / 上一章 / 下一章 */
    static showChapter(index: number): void {
        const cur = ReaderPanel.current;
        if (!cur) {
            return;
        }
        const max = Math.max(0, cur._novel.chapters.length - 1);
        const next = Math.min(Math.max(0, index), max);
        // 面板不可见(已关闭或压在后台)时才拉到前台, 且不抢焦点;
        // 正在阅读时切换章节不做任何 reveal, 避免焦点/视图被打断
        if (!cur._panel.visible) {
            cur._panel.reveal(vscode.ViewColumn.One, true);
        }
        if (next === cur._chapterIndex) {
            return;
        }
        cur._chapterIndex = next;
        cur._scrollRatio = 0;
        cur._postChapter();
        ReaderPanel.onDidChangeChapter?.(next);
    }

    static showSettings(): void {
        const cur = ReaderPanel.current;
        if (!cur) {
            return;
        }
        cur._openSettingsOnLoad = true;
        cur._panel.reveal(vscode.ViewColumn.One);
        cur._panel.webview.postMessage({ type: 'openSettings' });
    }

    static updateSettings(settings: ReadingSettings): void {
        ReaderPanel.current?._panel.webview.postMessage({ type: 'settings', payload: settings });
    }

    get novel(): Novel {
        return this._novel;
    }

    /** 当前阅读章节序号 */
    get chapterIndex(): number {
        return this._chapterIndex;
    }

    dispose(): void {
        ReaderPanel.current = undefined;
        this._panel.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
    }

    // ---------------------------------------------------------------- 消息处理

    private _onMessage(msg: WebviewMessage): void {
        switch (msg.type) {
            case 'ready':
                this._ready = true;
                this._postInit();
                break;
            case 'getChapter': {
                const max = Math.max(0, this._novel.chapters.length - 1);
                const index = Math.min(Math.max(0, msg.index | 0), max);
                if (index !== this._chapterIndex) {
                    this._chapterIndex = index;
                    this._scrollRatio = 0;
                    this._postChapter();
                    ReaderPanel.onDidChangeChapter?.(index);
                }
                break;
            }
            case 'updateSettings':
                void this._store.update(msg.patch).then((next) => {
                    this._settings = next;
                    this._panel.webview.postMessage({ type: 'settings', payload: next });
                });
                break;
            case 'resetSettings':
                void this._store.reset().then((next) => {
                    this._settings = next;
                    this._panel.webview.postMessage({ type: 'settings', payload: next });
                });
                break;
            case 'saveProgress':
                // 进度交给插件入口写入书架(不再维护单独的 session)
                ReaderPanel.onProgress?.(
                    msg.chapterIndex,
                    Math.min(1, Math.max(0, msg.scrollRatio || 0))
                );
                break;
            case 'openFile':
                void vscode.commands.executeCommand('novelReader.openFile');
                break;
        }
    }

    private _chapterPayload(): ChapterPayload {
        const ch = this._novel.chapters[this._chapterIndex];
        return {
            index: this._chapterIndex,
            title: ch ? ch.title : '',
            paragraphs: ch ? ch.content.split('\n') : [],
            totalChapters: this._novel.chapters.length,
            scrollRatio: this._scrollRatio,
        };
    }

    private _postInit(): void {
        if (!this._ready) {
            return;
        }
        const payload: InitPayload = {
            filePath: this._novel.filePath,
            bookTitle: this._novel.bookTitle,
            author: this._novel.author,
            chapters: this._novel.chapters.map((c) => ({ index: c.index, title: c.title })),
            chapterIndex: this._chapterIndex,
            chapterTitle: this._novel.chapters[this._chapterIndex]?.title ?? '',
            paragraphs: this._novel.chapters[this._chapterIndex]?.content.split('\n') ?? [],
            totalChapters: this._novel.chapters.length,
            totalWords: this._novel.totalWords,
            settings: this._settings,
            openSettings: this._openSettingsOnLoad,
        };
        this._openSettingsOnLoad = false;
        this._panel.webview.postMessage({ type: 'init', payload });
    }

    private _postChapter(): void {
        if (!this._ready) {
            return;
        }
        this._panel.webview.postMessage({ type: 'chapter', payload: this._chapterPayload() });
    }

    // ---------------------------------------------------------------- HTML

    private _getHtml(settings: ReadingSettings): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const fontStacks = JSON.stringify(
            Object.fromEntries(FONTS.map((f) => [f.id, f.stack]))
        );
        const themes = JSON.stringify(THEMES);
        const defaults = JSON.stringify(settings);

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>小说阅读</title>
<style>
  :root {
    --bg: ${themeById(settings.theme).bg};
    --fg: ${themeById(settings.theme).fg};
    --font-size: ${settings.fontSize}px;
    --font-family: ${fontStackById(settings.fontFamily)};
    --line-height: ${settings.lineHeight};
    --para-spacing: ${settings.paragraphSpacing}em;
    --content-width: ${settings.contentWidth}px;
    --chrome-bg: var(--vscode-editorWidget-background, #f8f8f8);
    --chrome-fg: var(--vscode-editorWidget-foreground, #333333);
    --chrome-border: var(--vscode-widget-border, #d4d4d4);
    --accent: var(--vscode-focusBorder, #0060c0);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --input-bg: var(--vscode-input-background, #ffffff);
    --input-fg: var(--vscode-input-foreground, #333333);
    --input-border: var(--vscode-input-border, #c4c4c4);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-family);
    background: var(--chrome-bg);
    color: var(--chrome-fg);
  }

  /* ---------- 工具栏 ---------- */
  .toolbar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    background: var(--chrome-bg);
    border-bottom: 1px solid var(--chrome-border);
    font-size: 13px;
  }
  .toolbar .spacer { flex: 1; }
  .tbtn {
    border: 1px solid var(--input-border);
    background: var(--input-bg); color: var(--chrome-fg);
    border-radius: 4px; padding: 3px 10px; cursor: pointer;
    font-size: 13px; line-height: 1.4; white-space: nowrap;
  }
  .tbtn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .tbtn:disabled { opacity: .45; cursor: default; }
  .tbtn.primary { background: var(--btn-bg); color: var(--btn-fg); border-color: transparent; }
  .tbtn.primary:hover:not(:disabled) { background: var(--btn-hover); color: var(--btn-fg); }
  #chapterSelect {
    max-width: 46vw; min-width: 180px;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 3px 6px; font-size: 13px;
  }
  #progressText { font-variant-numeric: tabular-nums; opacity: .85; white-space: nowrap; }

  .progress-track { height: 3px; background: var(--chrome-border); position: sticky; top: 37px; z-index: 19; }
  .progress-fill { height: 100%; width: 0; background: var(--accent); transition: width .2s ease; }

  /* ---------- 设置面板 ---------- */
  #settingsPanel {
    display: none;
    border-bottom: 1px solid var(--chrome-border);
    background: var(--chrome-bg);
    padding: 14px 18px 16px;
  }
  #settingsPanel.open { display: block; }
  #settingsPanel h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
  .settings-grid {
    display: grid; grid-template-columns: 72px 1fr; gap: 10px 14px; align-items: center;
    max-width: 720px;
  }
  .settings-grid > label { font-size: 12px; opacity: .85; text-align: right; }
  .ctl-row { display: flex; align-items: center; gap: 8px; }
  .ctl-row output { font-size: 12px; min-width: 52px; font-variant-numeric: tabular-nums; opacity: .85; }
  .ctl-row input[type="range"] { flex: 1; accent-color: var(--accent); }
  .ctl-row select {
    flex: 1; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px; padding: 4px 6px; font-size: 12px;
  }
  .swatches { display: flex; gap: 8px; flex-wrap: wrap; }
  .swatch {
    width: 44px; height: 30px; border-radius: 4px; cursor: pointer;
    border: 2px solid var(--chrome-border);
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 600;
  }
  .swatch.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  #resetSettings { justify-self: start; grid-column: 2; }

  /* ---------- 阅读区 ---------- */
  #reader {
    background: var(--bg); color: var(--fg);
    min-height: calc(100vh - 80px);
    padding: 28px 20px 60px;
  }
  #content {
    max-width: var(--content-width);
    margin: 0 auto;
    font-size: var(--font-size);
    font-family: var(--font-family);
    line-height: var(--line-height);
    letter-spacing: .02em;
  }
  #content p { margin: 0 0 var(--para-spacing); text-indent: 2em; }
  #content .chapter-title {
    text-indent: 0; text-align: center;
    font-size: 1.35em; font-weight: 600;
    margin: .4em 0 1.2em; letter-spacing: .05em;
  }
  .empty-tip { text-align: center; padding: 60px 0; opacity: .7; }

  /* ---------- 底部状态栏 ---------- */
  .statusbar {
    position: fixed; left: 0; right: 0; bottom: 0;
    display: flex; gap: 16px; align-items: center;
    padding: 4px 14px; font-size: 12px;
    background: var(--chrome-bg); color: var(--chrome-fg);
    border-top: 1px solid var(--chrome-border);
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>
<header class="toolbar">
  <button id="prevBtn" class="tbtn" title="上一章 (Alt+←)">‹ 上一章</button>
  <select id="chapterSelect" title="章节目录"></select>
  <button id="nextBtn" class="tbtn" title="下一章 (Alt+→)">下一章 ›</button>
  <span class="spacer"></span>
  <span id="progressText"></span>
  <button id="fontMinus" class="tbtn" title="减小字号">A-</button>
  <button id="fontPlus" class="tbtn" title="增大字号">A+</button>
  <button id="settingsBtn" class="tbtn primary" title="阅读设置">Aa 设置</button>
</header>
<div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>

<section id="settingsPanel">
  <h3>阅读设置</h3>
  <div class="settings-grid">
    <label>字体大小</label>
    <div class="ctl-row">
      <input type="range" id="fontSize" min="12" max="32" step="1">
      <output id="fontSizeVal"></output>
    </div>
    <label>字体</label>
    <div class="ctl-row">
      <select id="fontFamily"></select>
    </div>
    <label>行距</label>
    <div class="ctl-row">
      <input type="range" id="lineHeight" min="1.2" max="2.8" step="0.1">
      <output id="lineHeightVal"></output>
    </div>
    <label>段距</label>
    <div class="ctl-row">
      <input type="range" id="paraSpacing" min="0" max="2" step="0.1">
      <output id="paraSpacingVal"></output>
    </div>
    <label>阅读宽度</label>
    <div class="ctl-row">
      <input type="range" id="contentWidth" min="480" max="1200" step="20">
      <output id="contentWidthVal"></output>
    </div>
    <label>主题配色</label>
    <div class="swatches" id="themeSwatches"></div>
    <label></label>
    <button id="resetSettings" class="tbtn">恢复默认设置</button>
  </div>
</section>

<main id="reader">
  <article id="content"><p class="empty-tip">加载中…</p></article>
</main>

<footer class="statusbar">
  <span id="bookInfo"></span>
  <span class="spacer" style="flex:1"></span>
  <span id="chapterInfo"></span>
</footer>

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var FONT_STACKS = ${fontStacks};
  var THEMES = ${themes};
  var DEFAULT_SETTINGS = ${defaults};

  var state = { novel: null, settings: DEFAULT_SETTINGS, chapterIndex: 0 };

  function $(id) { return document.getElementById(id); }
  var els = {
    prev: $('prevBtn'), next: $('nextBtn'), select: $('chapterSelect'),
    progressText: $('progressText'), progressFill: $('progressFill'),
    settingsBtn: $('settingsBtn'), settingsPanel: $('settingsPanel'),
    fontMinus: $('fontMinus'), fontPlus: $('fontPlus'),
    fontSize: $('fontSize'), fontSizeVal: $('fontSizeVal'),
    fontFamily: $('fontFamily'),
    lineHeight: $('lineHeight'), lineHeightVal: $('lineHeightVal'),
    paraSpacing: $('paraSpacing'), paraSpacingVal: $('paraSpacingVal'),
    contentWidth: $('contentWidth'), contentWidthVal: $('contentWidthVal'),
    themeSwatches: $('themeSwatches'), reset: $('resetSettings'),
    content: $('content'), bookInfo: $('bookInfo'), chapterInfo: $('chapterInfo')
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function themeOf(id) {
    for (var i = 0; i < THEMES.length; i++) { if (THEMES[i].id === id) { return THEMES[i]; } }
    return THEMES[0];
  }

  /* ---------------- 设置渲染 ---------------- */
  function applySettings(s) {
    state.settings = s;
    var t = themeOf(s.theme);
    var root = document.documentElement;
    root.style.setProperty('--bg', t.bg);
    root.style.setProperty('--fg', t.fg);
    root.style.setProperty('--font-size', s.fontSize + 'px');
    root.style.setProperty('--font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.system);
    root.style.setProperty('--line-height', String(s.lineHeight));
    root.style.setProperty('--para-spacing', s.paragraphSpacing + 'em');
    root.style.setProperty('--content-width', s.contentWidth + 'px');
    syncControls(s);
  }

  function syncControls(s) {
    els.fontSize.value = s.fontSize;
    els.fontSizeVal.textContent = s.fontSize + 'px';
    els.fontFamily.value = s.fontFamily;
    els.lineHeight.value = s.lineHeight;
    els.lineHeightVal.textContent = s.lineHeight.toFixed(1);
    els.paraSpacing.value = s.paragraphSpacing;
    els.paraSpacingVal.textContent = s.paragraphSpacing.toFixed(1);
    els.contentWidth.value = s.contentWidth;
    els.contentWidthVal.textContent = s.contentWidth + 'px';
    var swatches = els.themeSwatches.children;
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].classList.toggle('active', swatches[i].dataset.theme === s.theme);
    }
  }

  function buildSettingsControls() {
    var html = '';
    for (var i = 0; i < THEMES.length; i++) {
      var t = THEMES[i];
      html += '<button class="swatch" data-theme="' + t.id + '" title="' + t.name +
        '" style="background:' + t.bg + ';color:' + t.fg + '">字</button>';
    }
    els.themeSwatches.innerHTML = html;

    var fonts = '';
    for (var j = 0; j < Object.keys(FONT_STACKS).length; j++) {
      var id = Object.keys(FONT_STACKS)[j];
      var name = { system: '系统默认', songti: '宋体', heiti: '黑体', kaiti: '楷体', fangsong: '仿宋', yahei: '微软雅黑' }[id] || id;
      fonts += '<option value="' + id + '">' + name + '</option>';
    }
    els.fontFamily.innerHTML = fonts;
  }

  /* ---------------- 章节渲染 ---------------- */
  function renderChapter(payload) {
    state.chapterIndex = payload.index;
    var html = '<h2 class="chapter-title">' + escapeHtml(payload.title) + '</h2>';
    var paras = payload.paragraphs || [];
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i].trim();
      if (p) { html += '<p>' + escapeHtml(p) + '</p>'; }
    }
    els.content.innerHTML = html || '<p class="empty-tip">(本章无内容)</p>';
    els.select.value = String(payload.index);
    els.prev.disabled = payload.index <= 0;
    els.next.disabled = payload.index >= payload.totalChapters - 1;
    updateProgress();
    requestAnimationFrame(function () {
      var max = document.body.scrollHeight - window.innerHeight;
      window.scrollTo(0, max > 0 ? payload.scrollRatio * max : 0);
    });
    sendProgress(true);
  }

  function updateProgress() {
    var total = state.novel ? state.novel.totalChapters : 0;
    var idx = state.chapterIndex + 1;
    els.progressText.textContent = idx + ' / ' + total;
    els.progressFill.style.width = (total > 0 ? (idx / total) * 100 : 0) + '%';
    els.chapterInfo.textContent = state.novel
      ? ('第 ' + idx + ' 章 / 共 ' + total + ' 章')
      : '';
  }

  function buildChapterSelect(chapters) {
    var html = '';
    for (var i = 0; i < chapters.length; i++) {
      html += '<option value="' + chapters[i].index + '">' + escapeHtml(chapters[i].title) + '</option>';
    }
    els.select.innerHTML = html;
  }

  /* ---------------- 进度保存(节流) ---------------- */
  var progressTimer = null;
  function sendProgress(immediate) {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    var send = function () {
      var max = document.body.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      vscode.postMessage({ type: 'saveProgress', chapterIndex: state.chapterIndex, scrollRatio: ratio });
    };
    if (immediate) { send(); } else { progressTimer = setTimeout(send, 600); }
  }
  window.addEventListener('scroll', function () { sendProgress(false); }, { passive: true });

  /* ---------------- 设置变更(防抖保存) ---------------- */
  var saveTimer = null;
  function persistSettings(patch) {
    applySettings(Object.assign({}, state.settings, patch));
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(function () {
      vscode.postMessage({ type: 'updateSettings', patch: patch });
    }, 250);
  }

  els.fontSize.addEventListener('input', function () { persistSettings({ fontSize: Number(this.value) }); });
  els.fontFamily.addEventListener('change', function () { persistSettings({ fontFamily: this.value }); });
  els.lineHeight.addEventListener('input', function () { persistSettings({ lineHeight: Number(this.value) }); });
  els.paraSpacing.addEventListener('input', function () { persistSettings({ paragraphSpacing: Number(this.value) }); });
  els.contentWidth.addEventListener('input', function () { persistSettings({ contentWidth: Number(this.value) }); });
  els.fontMinus.addEventListener('click', function () {
    persistSettings({ fontSize: Math.max(12, state.settings.fontSize - 1) });
  });
  els.fontPlus.addEventListener('click', function () {
    persistSettings({ fontSize: Math.min(32, state.settings.fontSize + 1) });
  });
  els.themeSwatches.addEventListener('click', function (e) {
    var btn = e.target.closest('.swatch');
    if (btn) { persistSettings({ theme: btn.dataset.theme }); }
  });
  els.reset.addEventListener('click', function () {
    vscode.postMessage({ type: 'resetSettings' });
  });

  /* ---------------- 导航 ---------------- */
  function gotoChapter(index) {
    vscode.postMessage({ type: 'getChapter', index: index });
  }
  els.prev.addEventListener('click', function () { gotoChapter(state.chapterIndex - 1); });
  els.next.addEventListener('click', function () { gotoChapter(state.chapterIndex + 1); });
  els.select.addEventListener('change', function () { gotoChapter(Number(this.value)); });
  els.settingsBtn.addEventListener('click', function () {
    els.settingsPanel.classList.toggle('open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); gotoChapter(state.chapterIndex - 1); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); gotoChapter(state.chapterIndex + 1); }
  });

  /* ---------------- 消息 ---------------- */
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || !msg.type) { return; }
    switch (msg.type) {
      case 'init': {
        var p = msg.payload;
        state.novel = {
          totalChapters: p.totalChapters,
          totalWords: p.totalWords,
          bookTitle: p.bookTitle
        };
        document.title = p.bookTitle + ' - 小说阅读';
        buildChapterSelect(p.chapters);
        applySettings(p.settings);
        renderChapter({
          index: p.chapterIndex, title: p.chapterTitle,
          paragraphs: p.paragraphs, totalChapters: p.totalChapters,
          scrollRatio: 0
        });
        var words = p.totalWords >= 10000
          ? (p.totalWords / 10000).toFixed(1) + ' 万字'
          : p.totalWords + ' 字';
        els.bookInfo.textContent = p.bookTitle + (p.author ? ' · ' + p.author : '') +
          ' · 共 ' + p.totalChapters + ' 章 · 约 ' + words;
        if (p.openSettings) { els.settingsPanel.classList.add('open'); }
        break;
      }
      case 'chapter':
        renderChapter(msg.payload);
        break;
      case 'settings':
        applySettings(msg.payload);
        break;
      case 'openSettings':
        els.settingsPanel.classList.add('open');
        els.settingsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        break;
    }
  });

  buildSettingsControls();
  applySettings(DEFAULT_SETTINGS);
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
