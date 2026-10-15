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
import { readWebviewAsset } from './webviewAssets';
import { Novel } from './novelParser';

export type ViewMode = 'shelf' | 'chapters' | 'settings';

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
    | { type: 'showChapters' }
    | { type: 'pickLibrary' }
    | { type: 'clearLibrary' }
    | { type: 'openLibraryFolder' };

/** 普通章节: 摊开的书本 */
const ICON_BOOK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.45 3.35C6.35 2.65 4.65 2.35 2.65 2.35a.6.6 0 0 0-.6.6v8.1c0 .35.3.62.65.6 1.75-.07 3.3.28 4.15 1.03.3.25.7-.03.7-.42V3.85c0-.2-.05-.36-.1-.5z"/><path d="M8.55 3.35c1.1-.7 2.8-1 4.8-1 .33 0 .6.27.6.6v8.1c0 .35-.3.62-.65.6-1.75-.07-3.3.28-4.15 1.03-.3.25-.7-.03-.7-.42V3.85c0-.2.05-.36.1-.5z"/></svg>`;

/** 在读: 播放圆标(醒目, 用 accent 色) */
const ICON_PLAY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.1"/><path d="M6.7 5.7l3.8 2.3-3.8 2.3z" fill="currentColor" stroke="none"/></svg>`;

/** 书架: 立体书本 */
const ICON_SHELF_BOOK = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1.6" y="2.6" width="3.4" height="10.8" rx=".7"/><rect x="6.1" y="2.6" width="3.4" height="10.8" rx=".7"/><path d="M11.4 3.1l3 10.3" stroke-linecap="round"/></svg>`;

/** 移除 */
const ICON_CLOSE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

export class ChapterViewProvider implements vscode.WebviewViewProvider {
    /**
     * 三种模式各对应一个视图: VS Code 的视图名(标题栏文字)是静态的,
     * 想要「书架 / 目录 / 设置」随模式变化, 只能用三个 when 互斥的视图。
     */
    public static readonly viewIds: Record<ViewMode, string> = {
        shelf: 'novelReaderShelf',
        chapters: 'novelReaderCatalog',
        settings: 'novelReaderSettings',
    };
    /** 主视图(目录) */
    public static readonly viewType = 'novelReaderCatalog';

    private readonly _views: { view: vscode.WebviewView; mode: ViewMode }[] = [];
    private _mode: ViewMode = 'chapters';
    /** 最近一次非设置模式(设置页「返回」按钮回到这里) */
    private _prevMode: Exclude<ViewMode, 'settings'> = 'chapters';
    private _shelf: ShelfItemView[] = [];
    /** 书库目录(空 = 未设置, 读原路径) */
    private _libraryPath = '';
    private _hasNovel = false;
    private _bookTitle = '';
    private _chapters: { index: number; title: string }[] = [];
    private _currentIndex = -1;
    /** 侧边栏跟随的阅读主题 id(由扩展在启动/设置变化时推送) */
    private _themeId = 'white';
    /** 视图就绪前的居中请求 */
    private _pendingCenter: number | null = null;

    resolveWebviewView(view: vscode.WebviewView): void {
        this.resolveForMode(this._mode, view);
    }

    /** 供各模式视图的注册器调用(VS Code 的 resolveWebviewView 拿不到 viewId) */
    resolveForMode(mode: ViewMode, view: vscode.WebviewView): void {
        const entry = { view, mode };
        this._views.push(entry);
        view.webview.options = { enableScripts: true };
        view.webview.html = this._getHtml();

        view.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    this._syncAll(entry);
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
                case 'pickLibrary':
                    void vscode.commands.executeCommand('novelReader.pickLibraryPath');
                    break;
                case 'clearLibrary':
                    void vscode.commands.executeCommand('novelReader.clearLibraryPath');
                    break;
                case 'openLibraryFolder':
                    void vscode.commands.executeCommand('novelReader.openLibraryFolder');
                    break;
            }
        });

        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this._syncAll(entry);
            }
        });
        view.onDidDispose(() => {
            const i = this._views.indexOf(entry);
            if (i >= 0) {
                this._views.splice(i, 1);
            }
        });
    }

    /** 任一视图可见(供命令判断) */
    get visible(): boolean {
        return this._views.some((e) => e.view.visible);
    }

    get mode(): ViewMode {
        return this._mode;
    }

    /** 进入设置页之前的模式(设置页「返回」按钮用) */
    get previousMode(): Exclude<ViewMode, 'settings'> {
        return this._prevMode;
    }

    /** 切换 书架 / 目录 模式 */
    setMode(mode: ViewMode): void {
        // 记住最近一次非设置模式, 供设置页「返回」按钮回到原处
        if (mode !== 'settings') {
            this._prevMode = mode;
        }
        this._mode = mode;
        this._post({ type: 'mode', mode });
    }

    /** 更新书架列表 */
    setShelf(items: ShelfItemView[]): void {
        this._shelf = items;
        this._post({ type: 'shelf', items });
    }

    /** 更新书库目录设置 */
    setLibrary(libraryPath: string): void {
        this._libraryPath = libraryPath || '';
        this._post({ type: 'library', path: this._libraryPath });
    }

    /** 侧边栏跟随的阅读主题(与阅读面板同步) */
    setTheme(themeId: string): void {
        this._themeId = themeId || 'white';
        this._post({ type: 'theme', themeId: this._themeId });
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
        if (this._views.length === 0) {
            if (center) {
                this._pendingCenter = index;
            }
            return;
        }
        this._post({ type: 'current', index, center });
    }

    /** 同步全量状态; 传入 target 时只发给该视图(新视图首次就绪时) */
    private _syncAll(target?: { view: vscode.WebviewView }): void {
        const send = (message: unknown) => {
            const targets = target ? [target] : this._views;
            for (const t of targets) {
                void t.view.webview.postMessage(message);
            }
        };
        send({ type: 'mode', mode: this._mode });
        send({ type: 'shelf', items: this._shelf });
        send({ type: 'library', path: this._libraryPath });
        send({ type: 'theme', themeId: this._themeId });
        send({
            type: 'novel',
            payload: {
                hasNovel: this._hasNovel,
                bookTitle: this._bookTitle,
                chapters: this._chapters,
                currentIndex: this._currentIndex,
            },
        });
        if (this._pendingCenter !== null) {
            send({ type: 'current', index: this._pendingCenter, center: true });
            this._pendingCenter = null;
        }
    }

    private _post(message: unknown): void {
        for (const e of this._views) {
            void e.view.webview.postMessage(message);
        }
    }

    // ---------------------------------------------------------------- HTML

    private _getHtml(): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        // webview 外壳: Vue 产物(dist-webview)内联(源码见 webview/sidebar/)
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  ${readWebviewAsset('sidebar.css')}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
  ${readWebviewAsset('sidebar.js')}
</script>
</body>
</html>`;
    }
}

/**
 * 把同一个 ChapterViewProvider 挂到指定模式的视图上。
 * (VS Code 的视图名是静态的, 想让标题栏随模式显示 书架/目录/设置 只能用互斥视图)
 */
export class ChapterViewRegistrar implements vscode.WebviewViewProvider {
    constructor(
        private readonly target: ChapterViewProvider,
        private readonly mode: ViewMode
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.target.resolveForMode(this.mode, view);
    }
}
