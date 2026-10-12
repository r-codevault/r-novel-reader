/**
 * chapterViewProvider.ts — 侧边栏「小说阅读」视图(WebviewView)
 *
 * 两种模式:
 *  - 书架: 已导入的小说列表(书名 / 阅读进度 / 悬浮删除), 点击即打开并延续上次进度
 *  - 目录: 顶部悬浮的「当前阅读」指示条(实时同步章名) + 章节目录列表
 *
 * 交互要点:
 *  - 「当前阅读」条 position: sticky 固定, 下方分割线; 点击可回到当前章节
 *  - 点击「当前阅读」后当前章节滚动定位到列表垂直中间(scrollIntoView block:center)
 *  - 侧边栏收起时切换章节不会把它强行展开(不使用任何 reveal)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Novel } from './novelParser';

export type ViewMode = 'shelf' | 'chapters';

/** 书架条目(供视图渲染) */
export interface ShelfItemView {
    filePath: string;
    title: string;
    author: string;
    /** 最后阅读章节序号, -1 表示未开始 */
    chapterIndex: number;
    totalChapters: number;
    /** 是否为当前打开的书 */
    current: boolean;
}

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'openChapter'; index: number }
    | { type: 'openBook'; filePath: string }
    | { type: 'removeBook'; filePath: string }
    | { type: 'resumeCurrent' }
    | { type: 'openFile' }
    | { type: 'showShelf' }
    | { type: 'showChapters' };

/** 普通章节: 摊开的书本 */
const ICON_BOOK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.45 3.35C6.35 2.65 4.65 2.35 2.65 2.35a.6.6 0 0 0-.6.6v8.1c0 .35.3.62.65.6 1.75-.07 3.3.28 4.15 1.03.3.25.7-.03.7-.42V3.85c0-.2-.05-.36-.1-.5z"/><path d="M8.55 3.35c1.1-.7 2.8-1 4.8-1 .33 0 .6.27.6.6v8.1c0 .35-.3.62-.65.6-1.75-.07-3.3.28-4.15 1.03-.3.25-.7-.03-.7-.42V3.85c0-.2.05-.36.1-.5z"/></svg>`;

/** 在读: 播放圆标(醒目, 用 accent 色) */
const ICON_PLAY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.1"/><path d="M6.7 5.7l3.8 2.3-3.8 2.3z" fill="currentColor" stroke="none"/></svg>`;

/** 书架: 立体书本 */
const ICON_SHELF_BOOK = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1.6" y="2.6" width="3.4" height="10.8" rx=".7"/><rect x="6.1" y="2.6" width="3.4" height="10.8" rx=".7"/><path d="M11.4 3.1l3 10.3" stroke-linecap="round"/></svg>`;

/** 移除 */
const ICON_CLOSE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

export class ChapterViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'novelReaderChapters';

    private _view?: vscode.WebviewView;
    private _mode: ViewMode = 'chapters';
    private _shelf: ShelfItemView[] = [];
    private _hasNovel = false;
    private _bookTitle = '';
    private _chapters: { index: number; title: string }[] = [];
    private _currentIndex = -1;
    /** 视图就绪前的居中请求 */
    private _pendingCenter: number | null = null;

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._getHtml();

        view.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    this._syncAll();
                    break;
                case 'openChapter':
                    void vscode.commands.executeCommand('novelReader.openChapter', msg.index);
                    break;
                case 'openBook':
                    void vscode.commands.executeCommand('novelReader.openBook', msg.filePath);
                    break;
                case 'removeBook':
                    void vscode.commands.executeCommand('novelReader.removeFromShelf', msg.filePath);
                    break;
                case 'resumeCurrent':
                    void vscode.commands.executeCommand('novelReader.resumeCurrent');
                    break;
                case 'openFile':
                    void vscode.commands.executeCommand('novelReader.openFile');
                    break;
                case 'showShelf':
                    void vscode.commands.executeCommand('novelReader.showBookshelf');
                    break;
                case 'showChapters':
                    void vscode.commands.executeCommand('novelReader.showChapters');
                    break;
            }
        });

        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this._syncAll();
            }
        });
    }

    /** 视图可见性(供命令判断) */
    get visible(): boolean {
        return !!this._view?.visible;
    }

    get mode(): ViewMode {
        return this._mode;
    }

    /** 切换 书架 / 目录 模式 */
    setMode(mode: ViewMode): void {
        this._mode = mode;
        this._post({ type: 'mode', mode });
    }

    /** 更新书架列表 */
    setShelf(items: ShelfItemView[]): void {
        this._shelf = items;
        if (this._mode === 'shelf' && items.length === 0 && this._hasNovel) {
            // 书架为空但当前有书, 保持目录视图更合理(由扩展侧决定, 这里只同步)
        }
        this._post({ type: 'shelf', items });
    }

    /** 加载/切换小说 */
    setNovel(novel: Novel | null): void {
        if (!novel) {
            this._hasNovel = false;
            this._bookTitle = '';
            this._chapters = [];
            this._currentIndex = -1;
        } else {
            const sameBook = this._bookTitle === novel.bookTitle;
            this._hasNovel = true;
            this._bookTitle = novel.bookTitle;
            this._chapters = novel.chapters.map((c) => ({ index: c.index, title: c.title }));
            if (!sameBook) {
                this._currentIndex = -1;
            }
        }
        this._post({
            type: 'novel',
            payload: {
                hasNovel: this._hasNovel,
                bookTitle: this._bookTitle,
                chapters: this._chapters,
                currentIndex: this._currentIndex,
            },
        });
    }

    /** 当前阅读章节变化; center=true 时滚动定位到列表中间 */
    setCurrent(index: number, center = false): void {
        this._currentIndex = index;
        if (!this._view) {
            if (center) {
                this._pendingCenter = index;
            }
            return;
        }
        this._post({ type: 'current', index, center });
    }

    private _syncAll(): void {
        this._post({ type: 'mode', mode: this._mode });
        this._post({ type: 'shelf', items: this._shelf });
        this._post({
            type: 'novel',
            payload: {
                hasNovel: this._hasNovel,
                bookTitle: this._bookTitle,
                chapters: this._chapters,
                currentIndex: this._currentIndex,
            },
        });
        if (this._pendingCenter !== null) {
            this._post({ type: 'current', index: this._pendingCenter, center: true });
            this._pendingCenter = null;
        }
    }

    private _post(message: unknown): void {
        void this._view?.webview.postMessage(message);
    }

    // ---------------------------------------------------------------- HTML

    private _getHtml(): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; }
  body {
    margin: 0; padding: 0;
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: transparent;
    overflow: hidden;
  }
  .ico { display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .pane { display: none; flex: 1 1 auto; min-height: 0; flex-direction: column; }
  .pane.active { display: flex; }

  /* ---------- 当前阅读 指示条(悬浮) ---------- */
  #currentWrap {
    display: none;
    position: sticky; top: 0; z-index: 3; flex: none;
    padding: 6px 8px 7px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  }
  #currentWrap.visible { display: block; }
  #currentCard {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 8px;
    border-radius: 6px; cursor: pointer;
    background: var(--vscode-input-background, rgba(127, 127, 127, 0.12));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
    white-space: nowrap; overflow: hidden;
  }
  #currentCard:hover { border-color: var(--vscode-focusBorder, rgba(128, 128, 128, 0.5)); }
  #currentCard:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #currentCard .k { opacity: .65; font-size: 12px; flex: none; }
  #currentCard .t { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
  #currentCard .hint { margin-left: auto; font-size: 11px; opacity: 0; flex: none; transition: opacity .12s; }
  #currentCard:hover .hint { opacity: .6; }
  .ico-reading { color: var(--vscode-charts-green, #2ea043); }

  /* ---------- 章节列表 ---------- */
  .list { flex: 1 1 auto; overflow-y: auto; margin: 0; padding: 3px 0 12px; }
  .ch {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px 3px 6px;
    cursor: pointer; user-select: none;
    white-space: nowrap;
  }
  .ch .ico { opacity: .5; }
  .ch .tt { overflow: hidden; text-overflow: ellipsis; }
  .ch:hover { background: var(--vscode-list-hoverBackground); }
  .ch.cur { background: var(--vscode-list-inactiveSelectionBackground, rgba(127,127,127,.15)); }
  .ch.cur .tt { font-weight: 500; }
  .ch.cur .ico { opacity: 1; }

  /* ---------- 书架 ---------- */
  .bk {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; cursor: pointer; user-select: none;
    border-left: 2px solid transparent;
  }
  .bk:hover { background: var(--vscode-list-hoverBackground); }
  .bk.cur { border-left-color: var(--vscode-charts-green, #2ea043); background: var(--vscode-list-inactiveSelectionBackground, rgba(127,127,127,.12)); }
  .bk .ico { opacity: .55; }
  .bk.cur .ico { opacity: 1; color: var(--vscode-charts-green, #2ea043); }
  .bk-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .bk-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bk.cur .bk-title { font-weight: 500; }
  .bk-sub { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bk-del {
    flex: none; opacity: 0; padding: 3px; border-radius: 4px; color: inherit;
    display: inline-flex; align-items: center; justify-content: center;
    transition: opacity .12s;
  }
  .bk:hover .bk-del { opacity: .55; }
  .bk-del:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.2)); color: var(--vscode-errorForeground, #f14c4c); }
  .shelf-foot {
    flex: none; padding: 7px 10px; font-size: 11px; opacity: .55;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25));
  }

  /* ---------- 空状态 ---------- */
  .empty { padding: 18px 14px; display: flex; flex-direction: column; gap: 8px; }
  .empty p { margin: 0 0 2px; opacity: .75; font-size: 12px; }
  .empty button {
    text-align: left; width: fit-content;
    color: var(--vscode-textLink-foreground, #3794ff);
    background: none; border: none; padding: 2px 0; cursor: pointer;
    font-family: inherit; font-size: inherit;
  }
  .empty button:hover { text-decoration: underline; }
</style>
</head>
<body>

<div id="paneShelf" class="pane">
  <div class="list" id="shelfList"></div>
  <div id="shelfEmpty" class="empty" style="display:none">
    <p>书架空空如也。</p>
    <button id="btnOpenFromShelf">打开小说文件</button>
  </div>
  <div class="shelf-foot" id="shelfFoot" style="display:none"></div>
</div>

<div id="paneChapters" class="pane active">
  <div id="currentWrap">
    <div id="currentCard" role="button" tabindex="0" title="点击回到当前章节">
      <span class="ico ico-reading">${ICON_PLAY}</span>
      <span class="k">当前阅读</span>
      <span class="t" id="currentTitle"></span>
      <span class="hint">回到本章</span>
    </div>
  </div>
  <div class="list" id="chapterList" role="listbox" aria-label="章节目录"></div>
  <div id="chapterEmpty" class="empty" style="display:none">
    <p>尚未打开小说。</p>
    <button id="btnOpenFile">打开小说文件</button>
    <button id="btnGoShelf">查看我的书架</button>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var ICON_BOOK = ${JSON.stringify(ICON_BOOK)};
  var ICON_PLAY = ${JSON.stringify(ICON_PLAY)};
  var ICON_SHELF_BOOK = ${JSON.stringify(ICON_SHELF_BOOK)};
  var ICON_CLOSE = ${JSON.stringify(ICON_CLOSE)};

  var elPaneShelf = document.getElementById('paneShelf');
  var elPaneChapters = document.getElementById('paneChapters');
  var elShelfList = document.getElementById('shelfList');
  var elShelfEmpty = document.getElementById('shelfEmpty');
  var elShelfFoot = document.getElementById('shelfFoot');
  var elChapterList = document.getElementById('chapterList');
  var elChapterEmpty = document.getElementById('chapterEmpty');
  var elCurrentWrap = document.getElementById('currentWrap');
  var elCurrentCard = document.getElementById('currentCard');
  var elCurrentTitle = document.getElementById('currentTitle');

  var chapters = [];
  var chapterEls = [];
  var currentIndex = -1;
  var renderedKey = '';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 模式 ---------------- */
  function setMode(mode) {
    elPaneShelf.classList.toggle('active', mode === 'shelf');
    elPaneChapters.classList.toggle('active', mode !== 'shelf');
  }

  /* ---------------- 书架 ---------------- */
  function renderShelf(items) {
    var has = items && items.length > 0;
    elShelfEmpty.style.display = has ? 'none' : 'flex';
    elShelfFoot.style.display = has ? '' : 'none';
    if (!has) {
      elShelfList.innerHTML = '';
      elShelfFoot.textContent = '';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var b = items[i];
      var progress = b.chapterIndex >= 0
        ? ('读至 第 ' + (b.chapterIndex + 1) + ' 章' + (b.totalChapters ? ' / 共 ' + b.totalChapters + ' 章' : ''))
        : (b.totalChapters ? ('共 ' + b.totalChapters + ' 章 · 未开始') : '未开始阅读');
      html += '<div class="bk' + (b.current ? ' cur' : '') + '" data-p="' + esc(b.filePath) + '" title="' + esc(b.title) + '">' +
        '<span class="ico">' + (b.current ? ICON_PLAY : ICON_SHELF_BOOK) + '</span>' +
        '<span class="bk-main">' +
          '<span class="bk-title">' + esc(b.title) + '</span>' +
          '<span class="bk-sub">' + esc(progress) + (b.author ? ' · ' + esc(b.author) : '') + '</span>' +
        '</span>' +
        '<span class="bk-del" data-del="' + esc(b.filePath) + '" title="从书架移除">' + ICON_CLOSE + '</span>' +
      '</div>';
    }
    elShelfList.innerHTML = html;
    elShelfFoot.textContent = '共 ' + items.length + ' 本 · 阅读进度自动记录';
  }

  elShelfList.addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('.bk-del') : null;
    if (del) {
      e.stopPropagation();
      vscode.postMessage({ type: 'removeBook', filePath: del.dataset.del });
      return;
    }
    var row = e.target.closest ? e.target.closest('.bk') : null;
    if (row) {
      vscode.postMessage({ type: 'openBook', filePath: row.dataset.p });
    }
  });
  document.getElementById('btnOpenFromShelf').addEventListener('click', function () {
    vscode.postMessage({ type: 'openFile' });
  });
  document.getElementById('btnGoShelf').addEventListener('click', function () {
    vscode.postMessage({ type: 'showShelf' });
  });

  /* ---------------- 章节目录 ---------------- */
  function renderChapters(list) {
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<div class="ch" data-i="' + list[i].index + '" title="' + esc(list[i].title) + '">' +
        '<span class="ico">' + ICON_BOOK + '</span>' +
        '<span class="tt">' + esc(list[i].title) + '</span></div>';
    }
    elChapterList.innerHTML = html;
    chapterEls = Array.prototype.slice.call(elChapterList.children);
  }

  function applyNovel(payload) {
    var has = payload.hasNovel && payload.chapters && payload.chapters.length > 0;
    elChapterEmpty.style.display = has ? 'none' : 'flex';
    elChapterList.style.display = has ? '' : 'none';

    if (!has) {
      elCurrentWrap.classList.remove('visible');
      elChapterList.innerHTML = '';
      chapterEls = [];
      chapters = [];
      renderedKey = '';
      currentIndex = -1;
      return;
    }

    var key = payload.bookTitle + '|' + payload.chapters.length;
    if (key !== renderedKey) {
      chapters = payload.chapters;
      renderChapters(chapters);
      renderedKey = key;
      currentIndex = -1;
    }
    elCurrentWrap.classList.add('visible');
    setCurrent(typeof payload.currentIndex === 'number' ? payload.currentIndex : -1, false);
  }

  function setCurrent(index, center) {
    if (currentIndex >= 0 && chapterEls[currentIndex]) {
      chapterEls[currentIndex].classList.remove('cur');
      chapterEls[currentIndex].querySelector('.ico').innerHTML = ICON_BOOK;
    }
    currentIndex = index;
    var el = chapterEls[index];
    if (el) {
      el.classList.add('cur');
      el.querySelector('.ico').innerHTML = ICON_PLAY;
      if (center) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    // 「当前阅读」条同步章名
    var ch = chapters[index];
    elCurrentTitle.textContent = ch ? ch.title : '尚未选择章节';
  }

  elChapterList.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.ch') : null;
    if (!el) { return; }
    var index = Number(el.dataset.i);
    setCurrent(index, false);
    vscode.postMessage({ type: 'openChapter', index: index });
  });

  function resumeCurrent() {
    vscode.postMessage({ type: 'resumeCurrent' });
  }
  elCurrentCard.addEventListener('click', resumeCurrent);
  elCurrentCard.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resumeCurrent(); }
  });
  document.getElementById('btnOpenFile').addEventListener('click', function () {
    vscode.postMessage({ type: 'openFile' });
  });

  /* ---------------- 消息 ---------------- */
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || !m.type) { return; }
    switch (m.type) {
      case 'mode': setMode(m.mode); break;
      case 'shelf': renderShelf(m.items); break;
      case 'novel': applyNovel(m.payload); break;
      case 'current': setCurrent(m.index, !!m.center); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
