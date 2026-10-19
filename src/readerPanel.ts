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
import { readWebviewAsset } from './webviewAssets';
import { fetchDailyColor } from './dailyColor';
import { ReadingSettings, SettingsStore, THEMES, beijingDateKey, fontStackById, localDailyColor, themeById } from './settings';

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
    /** 恢复章内滚动位置(0~1) */
    scrollRatio: number;
    /** 当前章字数 */
    chapterWords: number;
    settings: ReadingSettings;
    /** 打开时自动展开设置面板 */
    openSettings?: boolean;
    /** 书架列表(抽屉「书架」页) */
    shelf: ShelfItemView[];
    /** 书库目录(抽屉「存储」页) */
    libraryPath: string;
    /** 每日一色的推导色板(theme=daily 时 webview 直接使用) */
    dailyTheme?: import('./settings').ThemeDef;
    /** 今日色原始信息(色名/原始色值, 界面展示用) */
    dailyInfo?: { name: string; hex: string };
}

interface ChapterPayload {
    index: number;
    title: string;
    paragraphs: string[];
    totalChapters: number;
    /** 本章字数 */
    chapterWords: number;
    scrollRatio: number;
}

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'getChapter'; index: number }
    | { type: 'updateSettings'; patch: Partial<ReadingSettings> }
    | { type: 'resetSettings' }
    | { type: 'saveProgress'; chapterIndex: number; scrollRatio: number }
    | { type: 'openFile' }
    // 左抽屉(书架/目录/存储)动作
    | { type: 'openBook'; filePath: string }
    | { type: 'removeBook'; filePath: string }
    | { type: 'pickLibrary' }
    | { type: 'clearLibrary' }
    | { type: 'openLibraryFolder' }
    | { type: 'refreshLibrary' }
    // 每日一色
    | { type: 'applyDaily' }
    | { type: 'setDailySource'; source: 'local' | 'remote' };

/** 书架条目(抽屉「书架」页渲染用) */
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

/** 左抽屉页签 */
export type DrawerTab = 'shelf' | 'catalog' | 'storage';

export class ReaderPanel {
    public static readonly viewType = 'novelReader.reader';
    public static current: ReaderPanel | undefined;
    /** 章节变化回调(供侧边栏「当前阅读」条与目录同步) */
    public static onDidChangeChapter?: (index: number) => void;
    /** 设置变化(面板内改设置/重置后); 扩展用它把主题同步给侧边栏 */
    public static onDidChangeSettings?: (settings: ReadingSettings) => void;
    /** 阅读进度回调(由插件入口写入书架) */
    public static onProgress?: (chapterIndex: number, scrollRatio: number) => void;
    /** 书架数据提供者(插件入口注入): init 时随载荷下发 */
    public static getShelf?: () => ShelfItemView[];
    /** 书库目录提供者(插件入口注入) */
    public static getLibrary?: () => string;
    /** 视图就绪前的抽屉打开请求 */
    private static _pendingDrawer: DrawerTab | null = null;

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
            if (!sameFile) {
                // 换书: 同步更新编辑器标签标题
                cur._panel.title = `${novel.bookTitle} - 小说阅读`;
            }
            if (sameFile && cur._ready) {
                const sameChapter = cur._chapterIndex === chapterIndex;
                if (openSettings && sameChapter) {
                    // 只是要打开设置面板: 不重发章节, 避免正文重新渲染并跳回章首
                    cur._openSettingsOnLoad = false;
                    void cur._panel.webview.postMessage({ type: 'openSettings' });
                } else {
                    cur._postChapter();
                    // 同书重开时章节照发, 但"打开阅读设置"必须额外显式通知 webview,
                    // 否则侧边栏的"打开阅读设置"按钮点了没有任何反应
                    if (openSettings) {
                        cur._openSettingsOnLoad = false;
                        void cur._panel.webview.postMessage({ type: 'openSettings' });
                    }
                }
            } else {
                // 同书重开或换书: 重新下发 init 整体重建阅读页
                // (若 webview 尚未就绪, _postInit 会跳过, 由 ready 回调兜底重发)
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
        const inst = ReaderPanel.current;
        if (inst) {
            inst._postSettings(settings);
        }
    }

    /** 推送书架列表(抽屉「书架」页实时刷新) */
    static setShelf(items: ShelfItemView[]): void {
        void ReaderPanel.current?._panel.webview.postMessage({ type: 'shelf', items });
    }

    /** 推送书库目录(抽屉「存储」页) */
    static setLibrary(path: string): void {
        void ReaderPanel.current?._panel.webview.postMessage({ type: 'library', path });
    }

    /**
     * 打开左抽屉并切到指定页签。
     * 面板未打开(或 webview 未就绪)时先记下, 等 ready/init 后补发。
     */
    static openDrawer(tab: DrawerTab): void {
        const cur = ReaderPanel.current;
        if (cur && cur._ready) {
            void cur._panel.webview.postMessage({ type: 'openDrawer', tab });
            return;
        }
        ReaderPanel._pendingDrawer = tab;
    }

    get novel(): Novel {
        return this._novel;
    }

    /** 当前阅读章节序号 */
    get chapterIndex(): number {
        return this._chapterIndex;
    }

    /** 当前章内滚动位置(0~1), 供"打开阅读设置""回到当前章"等复用当前位置 */
    get scrollRatio(): number {
        return this._scrollRatio;
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
                // 正在用「每日一色」时, 打开阅读页顺带检查是否跨天(跨天自动换色)
                if (this._settings.theme === 'daily') {
                    void this._ensureDaily();
                }
                // 补发视图就绪前的抽屉打开请求
                if (ReaderPanel._pendingDrawer) {
                    const tab = ReaderPanel._pendingDrawer;
                    ReaderPanel._pendingDrawer = null;
                    void this._panel.webview.postMessage({ type: 'openDrawer', tab });
                }
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
                // 乐观同步: 先用合并后的设置通知外部(侧边栏主题等), 不等磁盘写入完成,
                // 否则切主题时侧边栏会有可见延迟
                ReaderPanel.onDidChangeSettings?.({
                    ...this._settings,
                    ...msg.patch,
                });
                void this._store.update(msg.patch).then((next) => {
                    this._settings = next;
                    this._postSettings(next);
                    ReaderPanel.onDidChangeSettings?.(next);
                });
                break;
            case 'resetSettings':
                void this._store.reset().then((next) => {
                    this._settings = next;
                    this._postSettings(next);
                    ReaderPanel.onDidChangeSettings?.(next);
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
            // 抽屉(书架/存储)动作: 转发到既有命令, 逻辑与旧侧边栏一致
            case 'openBook':
                void vscode.commands.executeCommand('novelReader.openBook', msg.filePath);
                break;
            case 'removeBook':
                // 失败要显式报错(命令未注册/存储异常时不再静默失败)
                void vscode.commands
                    .executeCommand('novelReader.removeFromShelf', msg.filePath)
                    .then(undefined, (err: unknown) => {
                        void vscode.window.showErrorMessage(
                            `移除书籍失败: ${err instanceof Error ? err.message : String(err)}`
                        );
                    });
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
            case 'refreshLibrary':
                // 按书库目录重新扫描书架(新增缺失 txt / 清理失效记录)
                void vscode.commands
                    .executeCommand('novelReader.refreshShelfFromLibrary')
                    .then(undefined, (err: unknown) => {
                        void vscode.window.showErrorMessage(
                            `刷新书架失败: ${err instanceof Error ? err.message : String(err)}`
                        );
                    });
                break;
            case 'applyDaily':
                // 应用每日一色: 先确保今日色是当天的, 再切主题
                void this._ensureDaily().then(async () => {
                    const next = await this._store.update({ theme: 'daily' });
                    this._postSettings(next);
                    ReaderPanel.onDidChangeSettings?.(next);
                });
                break;
            case 'setDailySource':
                void this._store
                    .update({ dailySource: msg.source === 'remote' ? 'remote' : 'local', dailyDate: '' })
                    .then((next) => {
                        this._settings = next;
                        // 切来源后立即重取今日色(remote 会去抓官网)
                        return this._ensureDaily();
                    });
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
            chapterWords: ch ? ch.wordCount : 0,
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
            scrollRatio: Math.min(1, Math.max(0, this._scrollRatio)),
            chapterWords: this._novel.chapters[this._chapterIndex]?.wordCount ?? 0,
            settings: this._settings,
            openSettings: this._openSettingsOnLoad,
            shelf: ReaderPanel.getShelf ? ReaderPanel.getShelf() : [],
            libraryPath: ReaderPanel.getLibrary ? ReaderPanel.getLibrary() : '',
            dailyTheme: themeById('daily', undefined, this._settings.dailyName, this._settings.dailyHex),
            dailyInfo: {
                name: this._settings.dailyName || localDailyColor().name,
                hex: this._settings.dailyHex || localDailyColor().hex,
            },
        };
        this._openSettingsOnLoad = false;
        this._panel.webview.postMessage({ type: 'init', payload });
    }

    /** 下发设置(附带每日一色推导好的主题, webview 直接查用) */
    private _postSettings(next: ReadingSettings): void {
        this._settings = next;
        this._panel.webview.postMessage({
            type: 'settings',
            payload: {
                ...next,
                dailyTheme: themeById('daily', undefined, next.dailyName, next.dailyHex),
                dailyInfo: { name: next.dailyName || localDailyColor().name, hex: next.dailyHex || localDailyColor().hex },
            },
        });
    }

    /**
     * 确保"今日色"是最新的:
     *  - 已缓存且日期是今天 -> 直接复用
     *  - 来源 remote -> 抓官网(失败自动回退本地)
     *  - 来源 local  -> 按日期从本地色库轮换
     */
    private async _ensureDaily(): Promise<ReadingSettings> {
        const today = beijingDateKey();
        const cur = this._settings;
        if (cur.dailyDate === today && cur.dailyHex) {
            return cur;
        }
        const local = localDailyColor(today);
        let hit: { name: string; hex: string } | null = null;
        if (cur.dailySource === 'remote') {
            hit = await fetchDailyColor();
        }
        const next = await this._store.update({
            dailyDate: today,
            dailyName: hit ? hit.name : local.name,
            dailyHex: hit ? hit.hex : local.hex,
        });
        if (cur.dailySource === 'remote' && !hit) {
            void vscode.window.setStatusBarMessage('$(warning) 官网取色失败，已使用本地每日色', 4000);
        }
        this._postSettings(next);
        ReaderPanel.onDidChangeSettings?.(next);
        return next;
    }

    private _postChapter(): void {
        if (!this._ready) {
            return;
        }
        this._panel.webview.postMessage({ type: 'chapter', payload: this._chapterPayload() });
    }

    // ---------------------------------------------------------------- HTML

    /** Vue 打包产物: reader.css(相对 dist/ 的 dist-webview/) */
    private get _webviewCss(): string {
        return readWebviewAsset('reader.css');
    }

    /** Vue 打包产物: reader.js(IIFE, 含 Vue 运行时) */
    private get _webviewJs(): string {
        return readWebviewAsset('reader.js');
    }

    private _getHtml(settings: ReadingSettings): string {
        const nonce = crypto.randomBytes(16).toString('hex');

                // webview 外壳: Vue 产物(dist-webview)内联 + 静态主题变量初值(防首帧闪白)
        // UI 全部由 webview/reader/ 的 Vue 3 源码构建而来(npm run build:webview)
        return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${settings.theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>小说阅读</title>
<style>
  :root {
    --bg: ${themeById(settings.theme).bg};
    --fg: ${themeById(settings.theme).fg};
    --page-bg: ${themeById(settings.theme).pageBg};
    --chrome-bg: ${themeById(settings.theme).chromeBg};
    --chrome-fg: ${themeById(settings.theme).fg};
    --chrome-border: ${themeById(settings.theme).chromeBorder};
    --accent: ${themeById(settings.theme).accent};
    --accent-fg: ${themeById(settings.theme).accentFg};
    /* 悬浮球(起点风格): 面板同色底 + 主题色图标/描边(来自 THEMES 变量) */
    --fab-bg: ${themeById(settings.theme).chromeBg};
    --fab-fg: ${themeById(settings.theme).accent};
    --fab-border: ${themeById(settings.theme).chromeBorder};
    --btn-hover: ${themeById(settings.theme).accent};
    --input-bg: ${themeById(settings.theme).bg};
    --input-fg: ${themeById(settings.theme).fg};
    --input-border: ${themeById(settings.theme).chromeBorder};
    /* 排版初值(实际值由 Vue store.applyThemeVars 按当前设置实时维护) */
    --font-size: ${settings.fontSize}px;
    --font-family: ${fontStackById(settings.fontFamily)};
    --line-height: ${settings.lineHeight};
    --para-spacing: ${settings.paragraphSpacing}em;
    --content-width: ${settings.contentWidth}px;
  }
  ${this._webviewCss}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
  ${this._webviewJs}
</script>
</body>
</html>`;
    }
}
