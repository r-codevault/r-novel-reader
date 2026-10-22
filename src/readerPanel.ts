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
import { Novel, parseNovel } from './novelParser';
import { decodeBuffer } from './encoding';
import { readWebviewAsset } from './webviewAssets';

import { ReadingSettings, SettingsStore, THEMES, fontStackById, themeById } from './settings';
import type { NoteDraft, NoteItem } from './notes';
import type { BookSourceView, ImportResult } from './bookSource';
import type { SearchBookItem } from './online/ruleApply';
import type { SourceSearchError } from './online/searchService';

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
    /** 全部阅读笔记(按书分组在 webview 完成, 一次带全避免打开浮层再请求) */
    notes: NoteItem[];
    /** 书源列表(精简视图) */
    sources: BookSourceView[];
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
    | { type: 'getChapter'; index: number; dir?: 'prev' | 'next' | 'jump'; /** 发消息时的章内滚动位置(用于记住当前章) */ curRatio?: number; /** 精确恢复位置(笔记跳转返回用), 优先级最高 */ exactRatio?: number }
    | { type: 'updateSettings'; patch: Partial<ReadingSettings> }
    | { type: 'resetSettings' }
    | { type: 'saveProgress'; chapterIndex: number; scrollRatio: number }
    | { type: 'openFile' }
    | { type: 'slackerStart' }
    // 左抽屉(书架/目录/存储)动作
    | { type: 'openBook'; filePath: string }
    | { type: 'removeBook'; filePath: string }
    | { type: 'pickLibrary' }
    | { type: 'clearLibrary' }
    | { type: 'openLibraryFolder' }
    | { type: 'refreshLibrary' }
    // 阅读笔记
    | { type: 'addNote'; chapterTitle: string; chapterIndex: number; paragraphIndex: number; quote: string; text: string }
    | { type: 'updateNote'; id: string; text: string }
    | { type: 'removeNote'; id: string }
    | { type: 'removeNoteGroup'; bookPath: string; chapterTitle?: string }
    | { type: 'requestNotes' }
    // 网络书源
    | { type: 'requestSources' }
    | { type: 'sourceSearch'; key: string; sourceIds?: string[]; token: number }
    | { type: 'sourceImport'; mode: 'url' | 'clipboard' | 'file' }
    | { type: 'sourceToggle'; id: string; enabled: boolean }
    | { type: 'sourceRemove'; id: string }
    | { type: 'sourceUpdate'; id: string; name?: string; searchUrl?: string }
    | { type: 'sourceExport' }
    | { type: 'sourceCheck'; id?: string };

/** 窗口重开时的恢复信息(VS Code 持久化 webview 状态用) */
export interface ReaderPanelState {
    filePath: string;
    title: string;
    chapterIndex: number;
    scrollRatio: number;
}

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
export type DrawerTab = 'shelf' | 'catalog' | 'notes' | 'storage' | 'source';

/** 书源能力接口(插件入口注入 BookSourceStore + SearchService) */
export interface BookSourceApi {
    list(): BookSourceView[];
    /** 导入文本; 弹窗交互(URL/剪贴板/文件)由扩展命令完成, 这里只处理内容 */
    importText(text: string): Promise<ImportResult>;
    remove(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    update(id: string, patch: { name?: string; searchUrl?: string }): Promise<BookSourceView | undefined>;
    exportText(): string;
    /** 搜索; token 原样回传, 供 webview 丢弃过期结果 */
    search(key: string, sourceIds: string[] | undefined): Promise<{ items: SearchBookItem[]; errors: SourceSearchError[] }>;
    /** 触发导入交互(url/clipboard/file), 由扩展实现弹窗与下载 */
    importInteractive?: (mode: 'url' | 'clipboard' | 'file') => Promise<void>;
}

/** 笔记存储接口(插件入口注入 NotesStore) */
export interface NotesApi {
    list(): NoteItem[];
    add(draft: NoteDraft, book: { bookPath: string; bookTitle: string }): Promise<NoteItem>;
    update(id: string, text: string): Promise<NoteItem | undefined>;
    remove(id: string): Promise<boolean>;
    removeByBook(bookPath: string): Promise<number>;
    removeByChapter(bookPath: string, chapterTitle: string): Promise<number>;
}

export class ReaderPanel {
    public static readonly viewType = 'novelReader.reader';
    public static current: ReaderPanel | undefined;
    /** 章节变化回调(供侧边栏「当前阅读」条与目录同步) */
    public static onDidChangeChapter?: (index: number) => void;
    /** 设置变化(面板内改设置/重置后); 扩展用它把主题同步给侧边栏 */
    public static onDidChangeSettings?: (settings: ReadingSettings) => void;
    /** 阅读进度回调(由插件入口写入书架) */
    /**
 * 进度上报回调。**必须携带 filePath** —— 面板可能来自窗口恢复路径
 * (未经过 loadNovel, 扩展侧的 currentNovel 未必是同一本书),
 * 只靠章节号无法判断该写进哪本书的记录。
 */
public static onProgress?: (filePath: string, chapterIndex: number, scrollRatio: number) => void;
    /** 书架数据提供者(插件入口注入): init 时随载荷下发 */
    public static getShelf?: () => ShelfItemView[];
    /** 书库目录提供者(插件入口注入) */
    public static getLibrary?: () => string;
    /** 章节位置记忆查询(书架 chapterRatios): 返回 undefined = 该章没有记忆, 从顶部读 */
    public static getChapterRatio?: (filePath: string, chapterIndex: number) => number | undefined;
    /** 笔记存储(插件入口注入): init 时下发全量, 增删改后回推增量 */
    public static notes?: NotesApi;
    /** 书源存储与搜索(插件入口注入) */
    public static bookSources?: BookSourceApi;
    /** 视图就绪前的抽屉打开请求 */
    private static _pendingDrawer: DrawerTab | null = null;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _store: SettingsStore;
    private _novel: Novel;
    private _chapterIndex: number;
    private _settings: ReadingSettings;
    private _scrollRatio = 0;
    /** 本会话内的章节位置记忆(章节序号 -> 0~1), 切走再切回时恢复原位置 */
    private readonly _ratios = new Map<number, number>();
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

    /** 供 serializer 使用: 仅当传入的是当前面板时返回恢复信息 */
    static serializeFor(panel: vscode.WebviewPanel): ReaderPanelState | undefined {
        return ReaderPanel.current && ReaderPanel.current._panel === panel
            ? ReaderPanel.current._serialize()
            : undefined;
    }

    /** 窗口重开时保存给 VS Code 的恢复信息 */
    _serialize(): ReaderPanelState | undefined {
        if (!this._novel) {
            return undefined;
        }
        return {
            filePath: this._novel.filePath,
            title: this._novel.bookTitle,
            chapterIndex: this._chapterIndex,
            scrollRatio: this._scrollRatio,
        };
    }

/**
 * VS Code 重开窗口时反序列化阅读页。
 *
     *
 * 触发前提: 上次退出时这个面板**确实开着**(VS Code 只恢复已存在的 Tab),
 * 因此默认行为是"原样恢复"—— 上次看到哪一章、章内滚到哪, 重开后都一样。
     *
 * 进度来源: **书架记录(扩展侧 Memento)优先, webview state 兜底**。
     * - 书架记录由主进程在收到 saveProgress 时写入, 与 webview 生命周期解耦,
     *   杀进程/崩溃时最后一条已落盘的进度仍可恢复 —— 它是可靠真相源。
     * - webview 的 setState 必须在 webview 正常卸载时才可靠, 进程被杀常丢或残留旧值,
     *   因此只作兜底, **绝不与书架记录取较大值**(那会用旧快照覆盖新进度)。
     *
     * - 开关被用户显式关闭 / 状态无效 / 源文件已不在: 丢弃这个恢复出来的 Tab
     * - 注意: 全新开 VS Code(上次没开过阅读页)时 VS Code 根本没有 Tab 要恢复,
     *   压根不会调用这里 —— 所以"启动时自动弹窗"与本方法无关,
     *   那由 activate 里不开面板保证(见 extension.ts 启动段)。
     */
    static async restore(
        panel: vscode.WebviewPanel,
        state: ReaderPanelState | undefined,
        store: SettingsStore,
        restoreOnStartup: boolean,
        /** 书架进度查询(可选): 有则作为唯一真相源 */
        shelfProgress?: (filePath: string) => { chapterIndex: number; scrollRatio: number } | undefined
    ): Promise<boolean> {
        if (!restoreOnStartup || !state || !state.filePath) {
            panel.dispose();
            return false;
        }
        try {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(state.filePath)));
            // 必须走编码识别: 站点下载的 txt 常为 GB18030, 硬解UTF-8 会乱码
            const { text, encoding } = decodeBuffer(raw);
            const novel = parseNovel(text, state.filePath, encoding);
            if (novel.chapters.length === 0) {
                panel.dispose();
                return false;
            }
            const last = Math.max(0, novel.chapters.length - 1);
            // 书架有有效进度 -> 无条件采用(它一定比webview state 更新);
            // 否则退回 webview state(该书可能还没被登记过进度)
            const shelved = shelfProgress?.(state.filePath);
            const hasShelf = !!shelved && shelved.chapterIndex >= 0;
            const rawIndex = hasShelf ? shelved.chapterIndex : state.chapterIndex || 0;
            const idx = Math.min(Math.max(0, rawIndex), last);
            // scrollRatio 同理: 章节不匹配时该值无意义, 归零避免套用到别的章节
            const sameChapter = hasShelf ? idx === state.chapterIndex : true;
            const rawRatio = hasShelf ? shelved.scrollRatio : state.scrollRatio || 0;
            const scrollRatio = sameChapter && isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 0;
            ReaderPanel.current = new ReaderPanel(panel, novel, idx, scrollRatio, store);
            return true;
        } catch {
            // 源文件被移动/删除: 不静默留一个坏面板
            panel.dispose();
            return false;
        }
    }

/**
 * 切换章节。
 *
 * 落点规则(与阅读习惯一致, 不是随意定的):
 *  - **下一章 / 目录跳转 / 快捷键**: 回到新章**顶部** —— 换章后需要从头读起,
 *    继承上一章的滚动距离会让人误以为漏读了内容。
 *  - **上一章**: 停在**底部** —— 你原本就在当前章末尾, 回到上一章末尾等于
 *    "接着往下读但少了一章", 视觉连续, 不需要再翻回顶部。
 *  - **同章**(目录点当前章): 不动。
 */
static showChapter(index: number, dir: 'next' | 'prev' | 'jump' = 'jump'): void {
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
        // 切章统一恢复该章的阅读记录位置(上一章不再强制落底部); 没有记录则回顶部
        cur._scrollRatio = cur._rememberedRatio(next);
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

    /** 推送书架列表(抽屉「书架」页实时刷新) */
    static setShelf(items: ShelfItemView[]): void {
        void ReaderPanel.current?._panel.webview.postMessage({ type: 'shelf', items });
    }

    /** 推送书库目录(抽屉「存储」页) */
    static setLibrary(path: string): void {
        void ReaderPanel.current?._panel.webview.postMessage({ type: 'library', path });
    }

    /** 摸鱼会话当前状态: 扩展侧注入的实时查询(优先), 兜底用最近一次推送值 */
    static slackerStateProvider: (() => boolean) | undefined;
    private static _slackerActiveState = false;

    /** 推送摸鱼会话状态(侧边栏「摸鱼模式」高亮); 同时记住, 供新开面板 init 补发 */
    static setSlackerActive(active: boolean): void {
        ReaderPanel._slackerActiveState = active;
        void ReaderPanel.current?._panel.webview.postMessage({
            type: 'slackerActive',
            payload: active,
        });
    }

    /** 当前摸鱼会话是否开启(静态查询, 供 _postInit 把状态带给新 webview) */
    private static _currentSlackerActive(): boolean {
        return ReaderPanel.slackerStateProvider
            ? ReaderPanel.slackerStateProvider()
            : ReaderPanel._slackerActiveState;
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

    /** 书籍标题(窗口恢复后补登记书架时用) */
    get bookTitle(): string {
        return this._novel ? this._novel.bookTitle : '';
    }

    /** 作者 */
    get author(): string {
        return this._novel ? this._novel.author : '';
    }

    /** 总章节数(窗口恢复后补登记书架时用) */
    get chapterCount(): number {
        return this._novel ? this._novel.chapters.length : 0;
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
                    // 记住离开的这一章读到哪了(以消息携带的实时比例为准, 最可靠)
                    if (typeof msg.curRatio === 'number') {
                        this._ratios.set(this._chapterIndex, Math.min(1, Math.max(0, msg.curRatio)));
                    }
                    this._chapterIndex = index;
                    // 精确恢复(笔记返回)优先; 其余一律恢复该章阅读记录位置, 没有记录回顶部
                    this._scrollRatio = typeof msg.exactRatio === 'number'
                        ? Math.min(1, Math.max(0, msg.exactRatio))
                        : this._rememberedRatio(index);
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
                    this._panel.webview.postMessage({ type: 'settings', payload: next });
                    ReaderPanel.onDidChangeSettings?.(next);
                });
                break;
            case 'resetSettings':
                void this._store.reset().then((next) => {
                    this._settings = next;
                    this._panel.webview.postMessage({ type: 'settings', payload: next });
                    ReaderPanel.onDidChangeSettings?.(next);
                });
                break;
            case 'saveProgress':
                // 进度交给插件入口写入书架(不再维护单独的 session);
                // 连同 filePath 一起传, 窗口恢复出来的面板也能写到正确的书
                if (this._novel) {
                    const ratio = Math.min(1, Math.max(0, msg.scrollRatio || 0));
                    // 如实记录当前位置(含顶部 0): 滚回顶部后离开也应回到顶部;
                    // 切章瞬间的旧位置上报已由 webview 侧抑制, 不会污染新章
                    this._ratios.set(msg.chapterIndex, ratio);
                    ReaderPanel.onProgress?.(
                        this._novel.filePath,
                        msg.chapterIndex,
                        ratio
                    );
                }
                break;
            case 'openFile':
                void vscode.commands.executeCommand('novelReader.openFile');
                break;
            // 侧边菜单「摸鱼模式」入口: 转发到摸鱼命令(伪装代码文档阅读)
            case 'slackerStart':
                void vscode.commands.executeCommand('novelReader.slackerStart');
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
            // ---- 阅读笔记: 增删改走 NotesStore, 成功后回推增量(失败回 noteError 保留草稿) ----
            case 'addNote':
                if (!ReaderPanel.notes) { break; }
                void ReaderPanel.notes
                    .add(
                        {
                            chapterTitle: msg.chapterTitle,
                            chapterIndex: msg.chapterIndex,
                            paragraphIndex: msg.paragraphIndex,
                            quote: msg.quote,
                            text: msg.text,
                        },
                        { bookPath: this._novel.filePath, bookTitle: this._novel.bookTitle }
                    )
                    .then((item) => {
                        void this._panel.webview.postMessage({ type: 'noteUpserted', item });
                    }, (err: unknown) => {
                        void this._panel.webview.postMessage({
                            type: 'noteError', op: 'add',
                            message: err instanceof Error ? err.message : String(err),
                        });
                    });
                break;
            case 'updateNote':
                if (!ReaderPanel.notes) { break; }
                void ReaderPanel.notes.update(msg.id, msg.text).then((item) => {
                    if (item) {
                        void this._panel.webview.postMessage({ type: 'noteUpserted', item });
                    } else {
                        void this._panel.webview.postMessage({ type: 'noteRemoved', id: msg.id });
                    }
                }, (err: unknown) => {
                    void this._panel.webview.postMessage({
                        type: 'noteError', op: 'update', id: msg.id,
                        message: err instanceof Error ? err.message : String(err),
                    });
                });
                break;
            case 'removeNote':
                if (!ReaderPanel.notes) { break; }
                void ReaderPanel.notes.remove(msg.id).then((ok) => {
                    if (ok) {
                        void this._panel.webview.postMessage({ type: 'noteRemoved', id: msg.id });
                    }
                });
                break;
            case 'removeNoteGroup':
                // 批量删除: 按书(整本)或按书+章; 完成后回发全量笔记刷新列表
                if (!ReaderPanel.notes) { break; }
                void (msg.chapterTitle !== undefined
                    ? ReaderPanel.notes.removeByChapter(msg.bookPath, msg.chapterTitle)
                    : ReaderPanel.notes.removeByBook(msg.bookPath)
                ).then((removed) => {
                    if (removed > 0) { this.postNotes(); }
                });
                break;
            case 'requestNotes':
                this.postNotes();
                break;
            case 'requestSources':
                this.postSources();
                break;
            case 'sourceSearch': {
                const api = ReaderPanel.bookSources;
                if (!api) { break; }
                void api.search(msg.key, msg.sourceIds).then((out) => {
                    void this._panel.webview.postMessage({
                        type: 'searchResults',
                        token: msg.token,
                        items: out.items,
                        errors: out.errors,
                        done: true,
                    });
                }, (err: unknown) => {
                    void this._panel.webview.postMessage({
                        type: 'searchResults',
                        token: msg.token,
                        items: [],
                        errors: [{ sourceId: '', sourceName: '', kind: 'fatal', message: err instanceof Error ? err.message : String(err) }],
                        done: true,
                    });
                });
                break;
            }
            case 'sourceImport':
                void ReaderPanel.bookSources?.importInteractive?.(msg.mode);
                break;
            case 'sourceToggle':
                void ReaderPanel.bookSources?.setEnabled(msg.id, msg.enabled).then(() => this.postSources());
                break;
            case 'sourceRemove':
                void ReaderPanel.bookSources?.remove(msg.id).then(() => this.postSources());
                break;
            case 'sourceUpdate':
                void ReaderPanel.bookSources
                    ?.update(msg.id, { name: msg.name, searchUrl: msg.searchUrl })
                    .then(() => this.postSources());
                break;
            case 'sourceExport':
                void vscode.commands.executeCommand('novelReader.exportSources');
                break;
            case 'sourceCheck':
                void vscode.commands.executeCommand('novelReader.checkSources', msg.id);
                break;
        }
    }

    /** 推送书源列表(精简视图) */
    public postSources(): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({
            type: 'sources',
            items: ReaderPanel.bookSources ? ReaderPanel.bookSources.list() : [],
        });
    }

    /** 把全量笔记推给 webview(init 后/路径迁移后调用) */
    public postNotes(): void {
        if (!this._ready) { return; }
        const items = ReaderPanel.notes ? ReaderPanel.notes.list() : [];
        void this._panel.webview.postMessage({ type: 'notes', items });
    }

    /** 某章的恢复位置: 优先本会话记忆, 其次书架 chapterRatios(跨会话), 都没有则回顶部 */
    private _rememberedRatio(index: number): number {
        // 本会话记录优先(含 0=顶部, 滚回顶部后离开应回到顶部)
        const local = this._ratios.get(index);
        if (typeof local === 'number') {
            return Math.min(1, Math.max(0, local));
        }
        const shelved = ReaderPanel.getChapterRatio?.(this._novel.filePath, index);
        return typeof shelved === 'number' ? Math.min(1, Math.max(0, shelved)) : 0;
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
            notes: ReaderPanel.notes ? ReaderPanel.notes.list() : [],
            sources: ReaderPanel.bookSources ? ReaderPanel.bookSources.list() : [],
        };
        this._openSettingsOnLoad = false;
        this._panel.webview.postMessage({ type: 'init', payload });
        // 摸鱼会话状态补发: webview 是新实例(state.slackerActive 初始 false),
        // 若会话早已开启(先摸鱼后开阅读器), 不补发会导致侧边栏高亮丢失
        this._panel.webview.postMessage({
            type: 'slackerActive',
            payload: ReaderPanel._currentSlackerActive(),
        });
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
        // 首帧主题: 与 webview 侧 applyThemeVars 取同一套值(四参, 含节日),
        // 否则切到节日/地域/节气主题后首次打开会闪一帧默认色。只算一次, 避免重复调用。
        const t = themeById(settings.theme, settings.province, settings.term, settings.festival);

                // webview 外壳: Vue 产物(dist-webview)内联 + 静态主题变量初值(防首帧闪白)
        // UI 全部由 webview/reader/ 的 Vue 3 源码构建而来(npm run build:webview)
        return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${settings.theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<title>小说阅读</title>
<style>
  :root {
    --bg: ${t.bg};
    --fg: ${t.fg};
    --page-bg: ${t.pageBg};
    --chrome-bg: ${t.chromeBg};
    --chrome-fg: ${t.fg};
    --chrome-border: ${t.chromeBorder};
    --border-strong: ${t.borderStrong};
    --accent: ${t.accent};
    --accent-fg: ${t.accentFg};
    --fg-muted: ${t.muted};
    --danger: ${t.danger};
    --shadow-color: ${t.shadow};
    /* 章节导航按钮(原悬浮球): 面板同色底 + 主题色图标/描边 */
    --nav-btn-bg: ${t.chromeBg};
    --nav-btn-fg: ${t.accent};
    --nav-btn-border: ${t.borderStrong};
    --input-bg: ${t.bg};
    --input-fg: ${t.fg};
    --input-border: ${t.borderStrong};
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
