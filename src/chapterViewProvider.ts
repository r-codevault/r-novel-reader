/**
 * chapterViewProvider.ts — 侧边栏「章节目录」(WebviewView)
 *
 * 相比原生 TreeView 的差异(为满足交互需求):
 *  - "继续阅读" 条目悬浮固定在顶部(position: sticky), 下方带分割线
 *  - 点击"继续阅读"后, 当前章节滚动定位到列表垂直中间(scrollIntoView block:center)
 *  - "在读" 章节使用醒目的播放图标(accent 绿色), 与普通章节的书本图标区分
 *  - 侧边栏收起时不会因章节切换被强行展开(不使用任何 reveal)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Novel } from './novelParser';

/** 普通章节: 摊开的书本 */
const ICON_BOOK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.45 3.35C6.35 2.65 4.65 2.35 2.65 2.35a.6.6 0 0 0-.6.6v8.1c0 .35.3.62.65.6 1.75-.07 3.3.28 4.15 1.03.3.25.7-.03.7-.42V3.85c0-.2-.05-.36-.1-.5z"/><path d="M8.55 3.35c1.1-.7 2.8-1 4.8-1 .33 0 .6.27.6.6v8.1c0 .35-.3.62-.65.6-1.75-.07-3.3.28-4.15 1.03-.3.25-.7-.03-.7-.42V3.85c0-.2.05-.36.1-.5z"/></svg>`;

/** 在读章节: 播放圆标(醒目, 用 accent 色) */
const ICON_PLAY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.1"/><path d="M6.7 5.7l3.8 2.3-3.8 2.3z" fill="currentColor" stroke="none"/></svg>`;

interface ViewState {
    hasNovel: boolean;
    bookTitle: string;
    author: string;
    chapters: { index: number; title: string }[];
    currentIndex: number;
    /** 有阅读进度时的"继续阅读"目标 */
    continueTarget: { index: number; title: string } | null;
}

const EMPTY_STATE: ViewState = {
    hasNovel: false,
    bookTitle: '',
    author: '',
    chapters: [],
    currentIndex: -1,
    continueTarget: null,
};

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'openChapter'; index: number }
    | { type: 'continueReading' }
    | { type: 'openFile' };

export class ChapterViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'novelReaderChapters';

    private _view?: vscode.WebviewView;
    private _state: ViewState = { ...EMPTY_STATE };
    private _rendered = false;
    /** 视图创建前收到的居中请求, 待 ready 后补发 */
    private _pendingCenter: number | null = null;

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._getHtml();
        this._rendered = false;

        view.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    this._postState();
                    break;
                case 'openChapter':
                    void vscode.commands.executeCommand('novelReader.openChapter', msg.index);
                    break;
                case 'continueReading':
                    void vscode.commands.executeCommand('novelReader.continueReading');
                    break;
                case 'openFile':
                    void vscode.commands.executeCommand('novelReader.openFile');
                    break;
            }
        });

        // 重新可见时补一次完整状态(隐藏期间可能已换书)
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this._postState();
            }
        });
    }

    /** 加载/切换小说 */
    setNovel(novel: Novel | null, continueTarget: { index: number; title: string } | null): void {
        if (!novel) {
            this._state = { ...EMPTY_STATE, continueTarget };
        } else {
            this._state = {
                hasNovel: true,
                bookTitle: novel.bookTitle,
                author: novel.author,
                chapters: novel.chapters.map((c) => ({ index: c.index, title: c.title })),
                currentIndex: this._state.hasNovel && this._state.bookTitle === novel.bookTitle ? this._state.currentIndex : -1,
                continueTarget,
            };
        }
        this._postState();
    }

    /** 当前章节变化; center=true 时把该章节滚动定位到列表中间 */
    setCurrent(index: number, center = false): void {
        this._state.currentIndex = index;
        if (!this._view) {
            if (center) {
                this._pendingCenter = index;
            }
            return;
        }
        this._post({ type: 'current', index, center });
    }

    private _postState(): void {
        if (!this._view) {
            return;
        }
        this._post({
            type: 'state',
            payload: this._state,
            center: this._pendingCenter,
        });
        this._pendingCenter = null;
        this._rendered = true;
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

  /* ---------- 悬浮的"继续阅读"条 ---------- */
  #continueWrap {
    display: none;
    position: sticky; top: 0; z-index: 3; flex: none;
    padding: 6px 8px 7px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  }
  #continueWrap.visible { display: block; }
  #continueBtn {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px;
    border-radius: 6px; cursor: pointer;
    background: var(--vscode-input-background, rgba(127, 127, 127, 0.12));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
    white-space: nowrap; overflow: hidden;
  }
  #continueBtn:hover { background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.18)); }
  #continueBtn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #continueBtn .k { opacity: .7; font-size: 12px; flex: none; }
  #continueBtn .t { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
  .ico-reading { color: var(--vscode-charts-green, #2ea043); }

  /* ---------- 章节列表 ---------- */
  #list { flex: 1 1 auto; overflow-y: auto; margin: 0; padding: 3px 0 12px; }
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

  /* ---------- 空状态 ---------- */
  #empty { display: none; padding: 18px 14px; flex-direction: column; gap: 8px; }
  #empty.visible { display: flex; }
  #empty p { margin: 0 0 2px; opacity: .8; font-size: 12px; }
  #empty button {
    text-align: left;
    color: var(--vscode-textLink-foreground, #3794ff);
    background: none; border: none; padding: 2px 0; cursor: pointer;
    font-family: inherit; font-size: inherit;
  }
  #empty button:hover { text-decoration: underline; }
</style>
</head>
<body>
<div id="continueWrap">
  <div id="continueBtn" role="button" tabindex="0" title="回到上次阅读位置">
    <span class="ico ico-reading">${ICON_PLAY}</span>
    <span class="k">继续阅读:</span>
    <span class="t" id="continueTitle"></span>
  </div>
</div>

<div id="empty">
  <p>尚未打开小说。</p>
  <button id="btnOpen">打开小说文件</button>
  <button id="btnContinue" style="display:none">继续阅读上次进度</button>
</div>

<div id="list" role="listbox" aria-label="章节目录"></div>

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var ICON_BOOK = ${JSON.stringify(ICON_BOOK)};
  var ICON_PLAY = ${JSON.stringify(ICON_PLAY)};

  var elWrap = document.getElementById('continueWrap');
  var elContinueBtn = document.getElementById('continueBtn');
  var elContinueTitle = document.getElementById('continueTitle');
  var elList = document.getElementById('list');
  var elEmpty = document.getElementById('empty');
  var elBtnOpen = document.getElementById('btnOpen');
  var elBtnContinue = document.getElementById('btnContinue');

  var items = [];
  var renderedKey = '';
  var currentIndex = -1;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderList(chapters) {
    var html = '';
    for (var i = 0; i < chapters.length; i++) {
      html += '<div class="ch" data-i="' + chapters[i].index + '" title="' + esc(chapters[i].title) + '">' +
        '<span class="ico">' + ICON_BOOK + '</span>' +
        '<span class="tt">' + esc(chapters[i].title) + '</span></div>';
    }
    elList.innerHTML = html;
    items = Array.prototype.slice.call(elList.children);
  }

  function applyState(s, center) {
    var hasChapters = s.hasNovel && s.chapters && s.chapters.length > 0;
    elEmpty.classList.toggle('visible', !hasChapters);
    elList.style.display = hasChapters ? '' : 'none';
    elBtnContinue.style.display = s.continueTarget ? '' : 'none';

    if (!hasChapters) {
      elWrap.classList.remove('visible');
      elList.innerHTML = '';
      items = [];
      renderedKey = '';
      currentIndex = -1;
      return;
    }

    // 换书才重建列表(454 条 DOM 只建一次)
    var key = s.bookTitle + '|' + s.chapters.length;
    if (key !== renderedKey) {
      renderList(s.chapters);
      renderedKey = key;
      currentIndex = -1;
    }

    if (s.continueTarget) {
      elContinueTitle.textContent = s.continueTarget.title;
      elWrap.classList.add('visible');
    } else {
      elWrap.classList.remove('visible');
    }

    setCurrent(typeof center === 'number' ? center : s.currentIndex, center !== null && center !== undefined);
  }

  function setCurrent(index, center) {
    if (currentIndex >= 0 && items[currentIndex]) {
      items[currentIndex].classList.remove('cur');
      items[currentIndex].querySelector('.ico').innerHTML = ICON_BOOK;
    }
    currentIndex = index;
    var el = items[index];
    if (!el) { return; }
    el.classList.add('cur');
    el.querySelector('.ico').innerHTML = ICON_PLAY;
    if (center) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // 点击章节: 立即高亮 + 通知扩展打开阅读面板
  elList.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.ch') : null;
    if (!el) { return; }
    var index = Number(el.dataset.i);
    setCurrent(index, false);
    vscode.postMessage({ type: 'openChapter', index: index });
  });

  function continueReading() {
    vscode.postMessage({ type: 'continueReading' });
  }
  elContinueBtn.addEventListener('click', continueReading);
  elContinueBtn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); continueReading(); }
  });
  elBtnContinue.addEventListener('click', continueReading);
  elBtnOpen.addEventListener('click', function () { vscode.postMessage({ type: 'openFile' }); });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || !m.type) { return; }
    if (m.type === 'state') { applyState(m.payload, m.center); }
    else if (m.type === 'current') { setCurrent(m.index, !!m.center); }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
