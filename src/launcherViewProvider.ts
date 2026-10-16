/**
 * launcherViewProvider.ts — 活动栏「小说阅读」入口视图
 *
 * 设计说明:
 *  - 活动栏只保留这**一个**入口视图(旧的 书架/目录/设置 三视图互斥方案已废弃, UI 主体在阅读面板左抽屉)
 *  - 这里是个极简启动页: 显示当前在读的书 + 几个直达按钮, 不承载列表/设置等实际 UI
 *  - 页面很小且无状态, 直接内联 HTML(不引 Vue 构建链), 保持入口零依赖
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface LauncherBook {
    title: string;
    chapterIndex: number;
    totalChapters: number;
}

type LauncherMessage =
    | { type: 'ready' }
    | { type: 'continue' }
    | { type: 'bookshelf' }
    | { type: 'catalog' }
    | { type: 'storage' }
    | { type: 'openFile' };

export class LauncherViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'novelReaderHome';

    private readonly _views: vscode.WebviewView[] = [];
    private _book: LauncherBook | null = null;

    resolveWebviewView(view: vscode.WebviewView): void {
        this._views.push(view);
        view.webview.options = { enableScripts: true };
        view.webview.html = this._getHtml();

        view.webview.onDidReceiveMessage((msg: LauncherMessage) => {
            switch (msg.type) {
                case 'ready':
                    this._postTo(view, { type: 'book', book: this._book });
                    break;
                case 'continue':
                    void vscode.commands.executeCommand('novelReader.resumeCurrent');
                    break;
                case 'bookshelf':
                    void vscode.commands.executeCommand('novelReader.showBookshelf');
                    break;
                case 'catalog':
                    void vscode.commands.executeCommand('novelReader.showChapters');
                    break;
                case 'storage':
                    void vscode.commands.executeCommand('novelReader.showSettings');
                    break;
                case 'openFile':
                    void vscode.commands.executeCommand('novelReader.openFile');
                    break;
            }
        });
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this._postTo(view, { type: 'book', book: this._book });
            }
        });
        view.onDidDispose(() => {
            const i = this._views.indexOf(view);
            if (i >= 0) { this._views.splice(i, 1); }
        });
    }

    /** 当前在读的书(列表变化时由扩展推送) */
    setCurrent(book: LauncherBook | null): void {
        this._book = book;
        for (const v of this._views) {
            this._postTo(v, { type: 'book', book });
        }
    }

    private _postTo(view: vscode.WebviewView, message: unknown): void {
        void view.webview.postMessage(message);
    }

    private _getHtml(): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
  }
  .wrap { padding: 10px; display: flex; flex-direction: column; gap: 9px; }
  .card {
    padding: 9px 10px; border-radius: 6px;
    background: var(--vscode-input-background, rgba(127,127,127,.12));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
  }
  .card .k { font-size: 11px; opacity: .65; }
  .card .t { font-weight: 600; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .s { font-size: 11.5px; opacity: .7; margin-top: 2px; }
  .card.empty .t { font-weight: 400; opacity: .75; }
  .primary {
    width: 100%; padding: 5px 8px; cursor: pointer;
    font-family: inherit; font-size: 12.5px;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border: 1px solid transparent; border-radius: 5px;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .btn {
    padding: 5px 8px; cursor: pointer; text-align: left;
    font-family: inherit; font-size: 12px;
    color: var(--vscode-button-secondaryForeground, inherit);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.16));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
    border-radius: 5px;
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.26)); }
  .hint { font-size: 11px; line-height: 1.7; opacity: .6; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card" id="card">
    <div class="k">当前阅读</div>
    <div class="t" id="bookTitle">尚未打开小说</div>
    <div class="s" id="bookSub"></div>
  </div>
  <button class="primary" id="btnContinue">继续阅读</button>
  <div class="grid">
    <button class="btn" id="btnShelf">我的书架</button>
    <button class="btn" id="btnCatalog">章节目录</button>
    <button class="btn" id="btnStorage">存储位置</button>
    <button class="btn" id="btnAdd">添加书籍</button>
  </div>
  <div class="hint">书架 / 章节 / 存储 都在阅读界面左侧抽屉里(点左边缘的「书架」按钮或按 Esc 收起)。</div>
</div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var elCard = document.getElementById('card');
  var elTitle = document.getElementById('bookTitle');
  var elSub = document.getElementById('bookSub');
  var elContinue = document.getElementById('btnContinue');

  function applyBook(book) {
    if (book && book.title) {
      elCard.classList.remove('empty');
      elTitle.textContent = book.title;
      elTitle.title = book.title;
      elSub.textContent = (book.chapterIndex >= 0 ? '读至 第 ' + (book.chapterIndex + 1) + ' 章' : '未开始')
        + (book.totalChapters ? ' / 共 ' + book.totalChapters + ' 章' : '');
      elContinue.disabled = false;
    } else {
      elCard.classList.add('empty');
      elTitle.textContent = '尚未打开小说';
      elSub.textContent = '';
      elContinue.disabled = true;
    }
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.type === 'book') { applyBook(m.book); }
  });

  function on(id, type) {
    document.getElementById(id).addEventListener('click', function () {
      vscode.postMessage({ type: type });
    });
  }
  on('btnContinue', 'continue');
  on('btnShelf', 'bookshelf');
  on('btnCatalog', 'catalog');
  on('btnStorage', 'storage');
  on('btnAdd', 'openFile');

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
