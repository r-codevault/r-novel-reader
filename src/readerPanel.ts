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
import { isOnlinePath, type OnlineRef } from './onlinePath';
import * as crypto from 'crypto';
import { Novel, parseNovel } from './novelParser';
import { decodeBuffer } from './encoding';
import { readWebviewAsset } from './webviewAssets';

import { ReadingSettings, SettingsStore, THEMES, fontStackById, themeById } from './settings';
import { uiFontVars } from './uiFont';
import type { NoteDraft, NoteItem } from './notes';
import type { BookSourceView, ImportResult } from './bookSource';
import type { HistoryPayload } from './history';
import type { SearchBookItem } from './online/ruleApply';
import type { SearchBatch, SearchProgress, SourceSearchError } from './online/searchService';
import { SearchControl } from './online/searchService';
import {
    PROTOCOL_VERSION,
    type ChapterCachedPayload,
    type ChapterErrorPayload,
    type ChapterLoadingPayload,
    type ChapterPayload,
    type DownloadDonePayload,
    type DownloadProgressPayload,
    type DownloadTaskView,
    type DownloadTasksPayload,
    type OpKind,
    type OpResultPayload,
    type ShelfRefreshPlan,
    type ShelfRefreshResult,
} from './protocol';

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
    /** 在线书元信息(本地书为空) */
    online?: { sourceName: string; bookUrl: string; preview?: boolean };
    /** 本书的离线下载状态(没有下载过则为空) */
    offline?: OfflineStatusView;
    /**
     * 协议版本号。webview 据此决定归属校验是"严格"还是"宽松":
     * 只有宿主显式声明 >= PROTOCOL_VERSION 时才要求每条回包都带 filePath。
     */
    protocolVersion?: number;
    /** 全局下载任务表快照(webview 任务表, 按 filePath 键) */
    downloadTasks?: DownloadTaskView[];
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
    | { type: 'removeBook'; filePath: string; opId?: string }
    // 批量操作(书架多选移除 / 历史多选删除、清空)
    | { type: 'removeBooks'; filePaths: string[]; opId?: string }
    | { type: 'removeHistory'; filePaths: string[]; opId?: string }
    | { type: 'clearHistory'; kind: 'local' | 'online'; opId?: string }
    | { type: 'pickLibrary' }
    | { type: 'clearLibrary' }
    | { type: 'openLibraryFolder' }
    | { type: 'refreshLibrary'; opId?: string }
    // 刷新书架: 预演 -> 确认 -> 执行(两阶段, planId 校验)
    | { type: 'refreshLibraryPreview'; opId?: string }
    | { type: 'refreshLibraryApply'; planId: number; opId?: string }
    // 阅读笔记
    | { type: 'addNote'; chapterTitle: string; chapterIndex: number; paragraphIndex: number; quote: string; text: string }
    | { type: 'updateNote'; id: string; text: string }
    | { type: 'removeNote'; id: string }
    | { type: 'removeNotes'; ids: string[]; opId?: string }
    | { type: 'removeNoteGroup'; bookPath: string; chapterTitle?: string; opId?: string }
    | { type: 'requestNotes' }
    // 网络书源
    | { type: 'requestSources' }
    | { type: 'requestHistory' }
    | { type: 'sourceSearch'; key: string; sourceIds?: string[]; token: number }
    | { type: 'sourceSearchPause'; token: number; paused: boolean }
    | { type: 'sourceSearchCancel'; token: number }
    /** 单源重试: 独立消息, 避免整体替换其它源的结果(D15) */
    | { type: 'sourceRetry'; reqId: number; sourceId: string; key: string }
    | { type: 'addOnlineBook'; item: SearchBookItem }
    | { type: 'previewOnlineBook'; item: SearchBookItem }
    | { type: 'previewAddToShelf' }
    | { type: 'retryChapter'; index: number }
    | { type: 'sourceImport'; mode: 'url' | 'clipboard' | 'file' }
    | { type: 'sourceToggle'; id: string; enabled: boolean }
    | { type: 'sourceRemove'; id: string }
    | { type: 'sourceRemoveMany'; ids: string[] }
    | { type: 'sourceUpdate'; id: string; name?: string; searchUrl?: string }
    | { type: 'sourceExport' }
    | { type: 'sourceCheck'; id?: string; scope?: 'active' | 'dead' | 'all'; runId?: number }
    | { type: 'sourceCheckPause'; scope: 'active' | 'dead'; paused: boolean; runId?: number }
    | { type: 'sourceCheckCancel'; scope: 'active' | 'dead'; runId?: number }
    | { type: 'sourceRevive'; id: string }
    | { type: 'sourceReviveMany'; ids?: string[] }
    | { type: 'sourceClearDead' }
    | { type: 'sourceSetEnabled'; patches: { id: string; enabled: boolean }[] }
    // 离线下载 / 缓存
    | { type: 'offlineStatus' }
    | { type: 'downloadStart'; start?: number; end?: number; filePath?: string }
    | { type: 'downloadPause'; filePath?: string }
    | { type: 'downloadResume'; filePath?: string }
    | { type: 'downloadCancel'; filePath?: string }
    | { type: 'offlineExportTxt'; opId?: string }
    | { type: 'offlineClearCurrent'; opId?: string }
    | { type: 'offlineClearAll'; opId?: string };

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
    /** 是否在线书 */
    online?: boolean;
    /** 在线书来源名 */
    sourceName?: string;
    /**
     * 在线书的原始 bookUrl。
     * 用于搜索结果行判断"是否已加入书架"以及反查书架记录做移出——
     * 书架快照里只有 filePath(online://伪路径), 不能直接和 bookUrl 对上。
     */
    onlineBookUrl?: string;
    /** 最后阅读章节序号, -1 表示未开始 */
    chapterIndex: number;
    totalChapters: number;
    /** 是否为当前打开的书 */
    current: boolean;
    /** 这本书的离线下载进度(有下载内容时才有) */
    offline?: { done: number; total: number };
}

/** 离线下载状态(目录面板/存储面板渲染用) */
export interface OfflineStatusView {
    filePath: string;
    /** 目录总章数 */
    total: number;
    /** 已下载章数 */
    done: number;
    /** 上次下载失败的章数(续传会自动重试) */
    failed: number;
    running: boolean;
    paused: boolean;
    /** 已下载章号(升序), 目录里点亮圆点用 */
    downloaded: number[];
    /** 本书离线占用字节 */
    bytes: number;
    /** 全部离线缓存合计字节 */
    totalBytes: number;
    /** 全部离线缓存书目数 */
    bookCount: number;
}

/**
 * 目录里每章的可用性/阅读标记(只在在线书上使用)。
 * 用来一眼看出「哪些章没网也能读」:
 *  - cached  临时读缓存(读过就自动存), 删书架/清缓存后会没
 *  - 主动下载的章走 OfflineStatusView.downloaded(永久, 删书架可选保留)
 */
export interface ChapterMarksView {
    /** 临时读缓存里已有的章号(升序) */
    cached: number[];
    /** 读过并留有章内位置记忆的章号(升序) */
    read: number[];
    /** 读到的最大章号; -1 = 还没开始(与状态栏「读至第 N 章」同一口径) */
    readUpTo: number;
}

/** 离线下载能力接口(插件入口注入) */
export interface OfflineApi {
    /** 全部离线缓存汇总 */
    stats(): { bytes: number; books: number };
    /** 同步读内存快照(首帧/请求状态时用) */
    status(): OfflineStatusView | undefined;
    /**
     * 开始下载。
     * `filePath` 为显式目标书（= 在线书 `online://` 键）；缺省表示"当前这本书"。
     * 显式传 key 是为了让"书架里对 A 发起下载，随后切到 B"仍然下的是 A。
     */
    start(range?: { start?: number; end?: number }, filePath?: string): Promise<{ ok: boolean; message?: string }>;
    /** 暂停/继续/取消：**必须按 key**，不能依赖"当前书" */
    pause(key?: string): boolean;
    resume(key?: string): boolean;
    cancel(key?: string): void;
    exportTxt(): Promise<{ ok: boolean; message?: string; filePath?: string; chapters?: number; missing?: number }>;
    clearCurrent(key?: string): Promise<void>;
    clearAll(): Promise<void>;
    /** 全部下载任务快照(webview 任务表; 与"当前书"无关) */
    tasks(): DownloadTaskView[];
}

/** 左抽屉页签 */
export type DrawerTab = 'shelf' | 'catalog' | 'notes' | 'storage' | 'source';

/** 书源能力接口(插件入口注入 BookSourceStore + SearchService) */
export interface BookSourceApi {
    list(): BookSourceView[];
    /** 导入文本; 弹窗交互(URL/剪贴板/文件)由扩展命令完成, 这里只处理内容 */
    importText(text: string): Promise<ImportResult>;
    remove(id: string): Promise<void>;
    /** 批量删除; 返回实际删除数 */
    removeMany?(ids: string[]): Promise<number>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    update(id: string, patch: { name?: string; searchUrl?: string }): Promise<BookSourceView | undefined>;
    exportText(): string;
    /** 恢复失效源(清标记, 不检查) */
    revive(id: string): Promise<boolean>;
    /** 批量恢复; 省略 ids = 全部 */
    reviveMany?(ids?: string[]): Promise<number>;
    /** 清除全部失效源(删除数据), 返回删除条数 */
    clearDead(): Promise<number>;
    /** 失效源数量(清除前确认用) */
    deadCount(): number;
    /** 批量启停(全选/反选/全部停用) */
    setEnabledMany(patches: { id: string; enabled: boolean }[]): Promise<number>;
    /** 暂停/继续批量检查(runId 用于忽略过期请求) */
    pauseCheck?(scope: 'active' | 'dead', paused: boolean, runId?: number): void;
    /** 取消批量检查(runId 用于忽略过期请求) */
    cancelCheck?(scope: 'active' | 'dead', runId?: number): void;
    /** 把搜索结果加入在线书架 */
    addOnlineBook?(item: SearchBookItem): Promise<{ ok: boolean; message?: string }>;
    /** 临时预览搜索结果(不加入书架) */
    previewOnlineBook?(item: SearchBookItem): Promise<{ ok: boolean; message?: string }>;
    /** 把当前预览的书加入书架 */
    savePreview?(): Promise<{ ok: boolean; message?: string }>;
    /** 搜索; token 原样回传, 供 webview 丢弃过期结果 */
    search(key: string, sourceIds: string[] | undefined, hooks?: {
        control?: SearchControl;
        onProgress?: (p: SearchProgress) => void;
        onBatch?: (b: SearchBatch) => void;
    }): Promise<{
        items: SearchBookItem[];
        errors: SourceSearchError[];
        skippedSources: number;
        deadAdded: string[];
    }>;
    /** 触发导入交互(url/clipboard/file), 由扩展实现弹窗与下载 */
    importInteractive?: (mode: 'url' | 'clipboard' | 'file') => Promise<void>;
}

/** 笔记存储接口(插件入口注入 NotesStore) */
export interface NotesApi {
    list(): NoteItem[];
    add(draft: NoteDraft, book: { bookPath: string; bookTitle: string }): Promise<NoteItem>;
    update(id: string, text: string): Promise<NoteItem | undefined>;
    remove(id: string): Promise<boolean>;
    /** 批量删除(笔记「管理」多选) */
    removeMany(ids: string[]): Promise<number>;
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
    /**
     * 打开一本书(含同书重开 / 窗口恢复)后的钩子, 由插件入口注入。
     * 用途: "打开即记阅读历史" —— 所有打开路径(本地/在线/预览/恢复/状态栏/抽屉)
     * 都收敛到 createOrShow 与 restore 两个点, 不必在每个命令里各写一遍。
     */
    public static onOpen?: (novel: Novel, chapterIndex: number) => void;
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
    /** 阅读历史提供者(插件入口注入) */
    public static historyProvider?: () => HistoryPayload;
    /** 章节位置记忆查询(书架 chapterRatios): 返回 undefined = 该章没有记忆, 从顶部读 */
    public static getChapterRatio?: (filePath: string, chapterIndex: number) => number | undefined;
    /** 笔记存储(插件入口注入): init 时下发全量, 增删改后回推增量 */
    public static notes?: NotesApi;
    /** 书源存储与搜索(插件入口注入) */
    public static bookSources?: BookSourceApi;
    /** 面板关闭时取消正在跑的批量检查 */
    public static cancelSourceCheck?: () => void;
    /** 在线章节按需加载(由插件入口注入) */
    public static onlineChapterLoader?: (novel: Novel, index: number) => Promise<string[]>;
    /** 窗口恢复时重建在线书(由插件入口注入) */
    public static onlineRestore?: (filePath: string) => Promise<Novel | null>;
    /** 离线下载/缓存(由插件入口注入) */
    public static offline?: OfflineApi;
    /** 同步快照(init 首帧用; 由插件入口接内存索引) */
    public static offlineView?: (filePath: string) => OfflineStatusView | undefined;
    /**
     * 目录的每章标记提供者(由插件入口注入)。
     * init 是同步的, 读盘要走这里异步补一帧, 避免挡住首屏渲染。
     */
    public static chapterMarks?: (novel: Novel) => Promise<ChapterMarksView | null>;
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
    /** webview 未就绪时暂存的预览成功/失败回包 */
    private _pendingPreviewReady: string | null = null;
    private _pendingPreviewError: { message: string; bookUrl?: string } | null = null;
    private _lastPreviewReady = '';
    /**
     * 书代号: 每次"换书"递增。用于判断一份异步回包是否还属于当前这本书。
     * 单独用 `_novel.filePath` 比较是不够的 —— 同一本书打开两次(A → B → A)时
     * filePath 相同, 但 A 的第一轮迟到回包不应该覆盖第三轮的正文。
     */
    private _bookGen = 1;
    /** 面板级单调请求号: 章节/预览的每一轮请求都有唯一编号 */
    private _reqSeq = 0;
    /** 唯一活请求: 只有 reqId 与它一致的章节回包才允许投递 (I2) */
    private _liveChapter: { reqId: number; gen: number; index: number } | null = null;
    /** 在途请求(reqId -> 任务), 便于诊断与保证 finally 只清理自己的条目 */
    private readonly _inflight = new Map<number, { gen: number; index: number }>();
    /**
     * 加载锁: `${gen}:${index}` -> reqId。
     * 值存 reqId 而不是 boolean, 这样"重试产生的第二轮"不会被第一轮的 finally 解锁 (I3)。
     */
    private readonly _chapterLocks = new Map<string, number>();
    /** 当前运行中的搜索(暂停/取消用) */
    private _activeSearch: { token: number; control: SearchControl } | undefined;
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
            if (!sameFile) {
                // 兜底: 换书前把旧书当前章/位置落盘(webview 已 flush, 这里防其它入口漏掉)
                ReaderPanel.onProgress?.(cur._novel.filePath, cur._chapterIndex, cur._scrollRatio);
                cur._ratios.clear();
                // 换书 = 新代号: 旧书所有在途回包从此不再属于本面板
                cur._bookGen += 1;
                cur._liveChapter = null;
                cur._inflight.clear();
                cur._chapterLocks.clear();
            }
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
            ReaderPanel.onOpen?.(novel, cur._chapterIndex);
            return;
        }

        const panel = vscode.window.createWebviewPanel(ReaderPanel.viewType, `${novel.bookTitle} - 小说阅读`, column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [],
        });
        ReaderPanel.current = new ReaderPanel(panel, novel, chapterIndex, scrollRatio, store);
        ReaderPanel.current._openSettingsOnLoad = openSettings;
        ReaderPanel.onOpen?.(novel, ReaderPanel.current.chapterIndex);
    }

    /** 供 serializer 使用: 仅当传入的是当前面板时返回恢复信息 */
    static serializeFor(panel: vscode.WebviewPanel): ReaderPanelState | undefined {
        return ReaderPanel.current && ReaderPanel.current._panel === panel
            ? ReaderPanel.current._serialize()
            : undefined;
    }

    /** 窗口重开时保存给 VS Code 的恢复信息 */
    _serialize(): ReaderPanelState | undefined {
        // 空态占位书(filePath 为空)不参与窗口恢复, 否则重开窗口会拿不到真书
        if (!this._novel || !this._novel.filePath) {
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
            let novel: Novel;
            if (isOnlinePath(state.filePath)) {
                const loaded = await ReaderPanel.onlineRestore?.(state.filePath);
                if (!loaded || loaded.chapters.length === 0) {
                    panel.dispose();
                    return false;
                }
                novel = loaded;
            } else {
                const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(state.filePath)));
                // 必须走编码识别: 站点下载的 txt 常为 GB18030, 硬解UTF-8 会乱码
                const { text, encoding } = decodeBuffer(raw);
                novel = parseNovel(text, state.filePath, encoding);
            }
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
            ReaderPanel.onOpen?.(novel, idx);
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

    /** 预览失败: 通知 webview 关闭加载态并显示原因(可带 bookUrl 过滤过期回包) */
    public postPreviewError(message: string, bookUrl?: string): void {
        if (!this._ready) {
            this._pendingPreviewError = { message, bookUrl };
            return;
        }
        void this._panel.webview.postMessage({ type: 'previewError', message, bookUrl });
    }

    /**
     * 当前读的书被移出书架: 退回"预览态", 让正文里的「+ 加入书架」重新出现。
     *
     * @param filePath 被移出的书(online:// 伪路径)
     * @param ref      移出前从书架记录里抓到的书源信息 —— 窗口恢复出来的 Novel
     *                 可能没带完整 online 字段, 用它补全
     * @returns 是否真的复位了(不是当前在读的书就返回 false)
     */
    static resetToPreview(filePath: string, ref?: OnlineRef): boolean {
        const cur = ReaderPanel.current;
        if (!cur || !cur._novel || cur._novel.filePath !== filePath) { return false; }
        if (cur._novel.online) {
            cur._novel.online.preview = true;
        } else if (ref) {
            cur._novel.online = {
                sourceId: ref.sourceId,
                sourceName: ref.sourceName,
                bookUrl: ref.bookUrl,
                tocUrl: ref.tocUrl,
                preview: true,
            };
        } else {
            return false;
        }
        cur.postPreviewReset(filePath);
        return true;
    }

    /** 通知 webview: 这本书回到预览态(previewSaved 的反向) */
    public postPreviewReset(filePath: string): void {
        // 未就绪时不发: ready 之后的 _postInit 会把 online.preview 一起带下去
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'previewReset', filePath });
    }

    /** 预览成功: webview 收到后才关闭搜索弹窗 */
    public postPreviewReady(bookUrl: string): void {
        if (!this._ready) {
            this._pendingPreviewReady = bookUrl;
            return;
        }
        if (!bookUrl || this._lastPreviewReady === bookUrl) { return; }
        this._lastPreviewReady = bookUrl;
        void this._panel.webview.postMessage({ type: 'previewReady', bookUrl });
    }

    dispose(): void {
        // 关闭前尽力保存当前进度(在线预览书不在书架时会 no-op)
        if (this._novel) {
            ReaderPanel.onProgress?.(this._novel.filePath, this._chapterIndex, this._scrollRatio);
        }
        ReaderPanel.current = undefined;
        // 面板关闭: 停掉还在跑(或暂停中)的搜索与批量检查, 避免后台挂着
        this._activeSearch?.control.cancel();
        this._activeSearch = undefined;
        ReaderPanel.cancelSourceCheck?.();
        // 离线下载**不**随面板关闭而取消: 用户关掉阅读页继续下载是合理预期,
        // 下载队列挂在插件入口(extension 级), 这里只是不再有面板可推送进度。
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
                if (this._pendingPreviewReady) {
                    const url = this._pendingPreviewReady;
                    this._pendingPreviewReady = null;
                    this.postPreviewReady(url);
                }
                if (this._pendingPreviewError) {
                    const err = this._pendingPreviewError;
                    this._pendingPreviewError = null;
                    this.postPreviewError(err.message, err.bookUrl);
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
                // 空态占位书(filePath 为空)跳过, 避免往书架/阅读历史里塞空记录
                if (this._novel && this._novel.filePath) {
                    const ratio = Math.min(1, Math.max(0, msg.scrollRatio || 0));
                    // 如实记录当前位置(含顶部 0): 滚回顶部后离开也应回到顶部;
                    // 切章瞬间的旧位置上报已由 webview 侧抑制, 不会污染新章
                    this._ratios.set(msg.chapterIndex, ratio);
                    // 只接受当前章的进度: 迟到的旧章回包不能覆盖当前位置
                    if (msg.chapterIndex === this._chapterIndex) {
                        this._scrollRatio = ratio;
                    }
                    ReaderPanel.onProgress?.(
                        this._novel.filePath,
                        msg.chapterIndex,
                        ratio
                    );
                }
                break;
            case 'addOnlineBook': {
                const api = ReaderPanel.bookSources;
                if (!api?.addOnlineBook) {
                    void this._panel.webview.postMessage({
                        type: 'onlineBookAdded',
                        bookUrl: msg.item.bookUrl,
                        ok: false,
                        message: '书源功能不可用',
                    });
                    break;
                }
                void api.addOnlineBook(msg.item).then((res) => {
                    if (!res.ok) {
                        void vscode.window.showErrorMessage('加入书架失败: ' + (res.message || '未知原因'));
                    }
                    void this._panel.webview.postMessage({
                        type: 'onlineBookAdded',
                        bookUrl: msg.item.bookUrl,
                        ok: !!res.ok,
                        message: res.message || '',
                    });
                }, (err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    void vscode.window.showErrorMessage('加入书架失败: ' + message);
                    void this._panel.webview.postMessage({
                        type: 'onlineBookAdded',
                        bookUrl: msg.item.bookUrl,
                        ok: false,
                        message,
                    });
                });
                break;
            }
            case 'previewOnlineBook': {
                const api = ReaderPanel.bookSources;
                if (!api?.previewOnlineBook) {
                    this.postPreviewError('书源功能不可用', msg.item.bookUrl);
                    break;
                }
                void api.previewOnlineBook(msg.item).then((res) => {
                    const panel = ReaderPanel.current || this;
                    if (res && res.ok) { panel.postPreviewReady(msg.item.bookUrl); }
                    else { panel.postPreviewError((res && res.message) || '预览失败', msg.item.bookUrl); }
                }, (err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    const panel = ReaderPanel.current || this;
                    panel.postPreviewError(message, msg.item.bookUrl);
                });
                break;
            }
            case 'previewAddToShelf': {
                const api = ReaderPanel.bookSources;
                if (!api?.savePreview) { break; }
                void api.savePreview().then((res) => {
                    if (!res.ok) {
                        void vscode.window.showErrorMessage('加入书架失败: ' + (res.message || '未知原因'));
                        // 回包给前端, 否则按钮会一直卡在「加入中…」
                        void this._panel.webview.postMessage({
                            type: 'previewAddFailed',
                            message: res.message || '未知原因',
                        });
                        return;
                    }
                    if (this._novel.online) { this._novel.online.preview = false; }
                    // 预览期间的阅读位置在加入书架时补写(之前没有书架记录)
                    ReaderPanel.onProgress?.(this._novel.filePath, this._chapterIndex, this._scrollRatio);
                    void this._panel.webview.postMessage({ type: 'previewSaved' });
                });
                break;
            }
            case 'retryChapter':
                this._retryChapter(msg.index);
                break;
            // ---- 离线下载 / 缓存: 具体编排在插件入口, 这里只转发 ----
            case 'offlineStatus':
                this.postOfflineStatus(ReaderPanel.offlineView?.(this._novel.filePath));
                this.postOfflineStats(ReaderPanel.offline?.stats() ?? { bytes: 0, books: 0 });
                this.postDownloadTasks();
                break;
            case 'downloadStart': {
                // 下载目标由消息显式给出(缺省 = 当前书), 不依赖"此刻谁是当前书"
                const key = msg.filePath || this._novel.filePath;
                void ReaderPanel.offline
                    ?.start({ start: msg.start, end: msg.end }, key)
                    .then((res) => {
                        if (!res.ok) {
                            this.postDownloadDone({
                                ok: false, cancelled: false, done: 0, total: 0, failed: 0,
                                message: res.message, filePath: key,
                            });
                        }
                        // 无论成败都给一次任务表快照: 按钮状态靠它收敛
                        this.postDownloadTasks();
                    });
                break;
            }
            case 'downloadPause':
                ReaderPanel.offline?.pause(msg.filePath);
                this.postDownloadTasks();
                break;
            case 'downloadResume':
                ReaderPanel.offline?.resume(msg.filePath);
                this.postDownloadTasks();
                break;
            case 'downloadCancel':
                // 取消不 await: 中断在途请求是异步的, 避免 webview 等回包卡住
                ReaderPanel.offline?.cancel(msg.filePath);
                break;
            case 'offlineExportTxt':
                void ReaderPanel.offline?.exportTxt().then((res) => {
                    void this._panel.webview.postMessage({ type: 'offlineExported', payload: res });
                    this._replyOp(msg.opId, 'offline:export', !!res.ok, res.ok ? undefined : res.message);
                }, (err: unknown) => {
                    this._replyOp(msg.opId, 'offline:export', false, err instanceof Error ? err.message : String(err));
                });
                break;
            case 'offlineClearCurrent': {
                const key = this._novel.filePath;
                void Promise.resolve(ReaderPanel.offline?.clearCurrent(key))
                    .then(() => {
                        this.postDownloadTasks();
                        this._replyOp(msg.opId, 'offline:clearCurrent', true);
                    }, (err: unknown) => {
                        this._replyOp(msg.opId, 'offline:clearCurrent', false,
                            err instanceof Error ? err.message : String(err));
                    });
                break;
            }
            case 'offlineClearAll':
                void Promise.resolve(ReaderPanel.offline?.clearAll())
                    .then(() => {
                        this.postDownloadTasks();
                        this._replyOp(msg.opId, 'offline:clearAll', true);
                    }, (err: unknown) => {
                        this._replyOp(msg.opId, 'offline:clearAll', false,
                            err instanceof Error ? err.message : String(err));
                    });
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
                // skipConfirm: webview 侧已经用 ConfirmDialog 确认过, 这里不再弹宿主模态框
                this._runOp(msg.opId, 'books:remove', () =>
                    vscode.commands.executeCommand('novelReader.removeFromShelf', {
                        filePaths: [msg.filePath],
                        skipConfirm: true,
                        opId: msg.opId,
                    })
                );
                break;
            // ---- 批量操作: 书架多选移除 / 历史多选删除、清空 ----
            case 'removeBooks':
                this._runOp(msg.opId, 'books:removeMany', () =>
                    vscode.commands.executeCommand('novelReader.removeBooksFromShelf', {
                        filePaths: msg.filePaths,
                        skipConfirm: true,
                        opId: msg.opId,
                    })
                );
                break;
            case 'removeHistory':
                this._runOp(msg.opId, 'history:remove', () =>
                    vscode.commands.executeCommand('novelReader.removeHistory', {
                        filePaths: msg.filePaths,
                        skipConfirm: true,
                        opId: msg.opId,
                    })
                );
                break;
            case 'clearHistory':
                this._runOp(msg.opId, 'history:clear', () =>
                    vscode.commands.executeCommand('novelReader.clearHistory', {
                        kind: msg.kind,
                        skipConfirm: true,
                        opId: msg.opId,
                    })
                );
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
                // 旧入口(直接执行): 保留, 命令面板与老 webview 仍走这里
                this._runOp(msg.opId, 'shelf:refresh', () =>
                    vscode.commands.executeCommand('novelReader.refreshShelfFromLibrary')
                );
                break;
            case 'refreshLibraryPreview':
                // 预演: 只算不写, 回 shelfRefreshPlan 供确认框展示
                this._runOp(msg.opId, 'shelf:refresh', () =>
                    vscode.commands.executeCommand('novelReader.refreshShelfPlan')
                );
                break;
            case 'refreshLibraryApply':
                this._runOp(msg.opId, 'shelf:refresh', () =>
                    vscode.commands.executeCommand('novelReader.refreshShelfApply', msg.planId)
                );
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
            case 'removeNotes':
                // 笔记「管理」多选删除: 一次写盘, 完成后回发全量笔记
                if (!ReaderPanel.notes) {
                    this._replyOp(msg.opId, 'notes:remove', false, '笔记功能不可用');
                    break;
                }
                void ReaderPanel.notes.removeMany(msg.ids).then((removed) => {
                    if (removed > 0) { this.postNotes(); }
                    this._replyOp(msg.opId, 'notes:remove', true, undefined, { removed });
                }, (err: unknown) => {
                    this._replyOp(msg.opId, 'notes:remove', false,
                        err instanceof Error ? err.message : String(err));
                });
                break;
            case 'removeNoteGroup':
                // 批量删除: 按书(整本)或按书+章; 完成后回发全量笔记刷新列表
                if (!ReaderPanel.notes) {
                    this._replyOp(msg.opId, 'notes:removeGroup', false, '笔记功能不可用');
                    break;
                }
                void (msg.chapterTitle !== undefined
                    ? ReaderPanel.notes.removeByChapter(msg.bookPath, msg.chapterTitle)
                    : ReaderPanel.notes.removeByBook(msg.bookPath)
                ).then((removed) => {
                    if (removed > 0) { this.postNotes(); }
                    this._replyOp(msg.opId, 'notes:removeGroup', true, undefined, { removed });
                }, (err: unknown) => {
                    this._replyOp(msg.opId, 'notes:removeGroup', false,
                        err instanceof Error ? err.message : String(err));
                });
                break;
            case 'requestNotes':
                this.postNotes();
                break;
            case 'requestSources':
                this.postSources();
                break;
            case 'requestHistory':
                this.postHistory();
                break;
            case 'sourceSearch': {
                const api = ReaderPanel.bookSources;
                if (!api) { break; }
                // 新搜索开始: 取消上一轮(避免暂停中的旧任务一直挂着)
                this._activeSearch?.control.cancel();
                const control = new SearchControl();
                this._activeSearch = { token: msg.token, control };
                void api.search(msg.key, msg.sourceIds, {
                    control,
                    onProgress: (p) => {
                        void this._panel.webview.postMessage({
                            type: 'searchProgress',
                            token: msg.token,
                            done: p.done,
                            total: p.total,
                            sourceName: p.sourceName,
                            ok: p.ok,
                            failed: p.failed,
                        });
                    },
                    onBatch: (b) => {
                        void this._panel.webview.postMessage({
                            type: 'searchBatch',
                            token: msg.token,
                            items: b.items,
                            errors: b.errors,
                        });
                    },
                }).then((out) => {
                    void this._panel.webview.postMessage({
                        type: 'searchResults',
                        token: msg.token,
                        items: out.items,
                        errors: out.errors,
                        skippedSources: out.skippedSources,
                        deadAdded: out.deadAdded,
                        done: true,
                    });
                    if (this._activeSearch?.token === msg.token) { this._activeSearch = undefined; }
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
            case 'sourceSearchCancel': {
                const active = this._activeSearch;
                if (!active || (msg.token !== undefined && active.token !== msg.token)) { break; }
                active.control.cancel();
                this._activeSearch = undefined;
                break;
            }
            case 'sourceSearchPause': {
                const active = this._activeSearch;
                if (!active || active.token !== msg.token) { break; }
                if (msg.paused) { active.control.pause(); } else { active.control.resume(); }
                break;
            }
            case 'sourceRetry': {
                // 单源重试走独立消息: 复用 sourceSearch 会整体替换 state.searchResults,
                // 把其它源已经拿到的命中一起丢掉(D15)。
                const api = ReaderPanel.bookSources;
                if (!api) { break; }
                const sourceName = (api.list().find((s) => s.id === msg.sourceId) || { name: msg.sourceId }).name;
                void api.search(msg.key, [msg.sourceId], { control: new SearchControl() }).then((out) => {
                    const err = out.errors && out.errors[0];
                    void this._panel.webview.postMessage({
                        type: 'sourceRetryResult',
                        payload: {
                            reqId: msg.reqId,
                            sourceId: msg.sourceId,
                            sourceName,
                            ok: !err,
                            message: err ? err.message : undefined,
                            items: (!err ? out.items : []) as never,
                        },
                    });
                }, (e: unknown) => {
                    void this._panel.webview.postMessage({
                        type: 'sourceRetryResult',
                        payload: {
                            reqId: msg.reqId,
                            sourceId: msg.sourceId,
                            sourceName,
                            ok: false,
                            message: e instanceof Error ? e.message : String(e),
                        },
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
            case 'sourceRemoveMany':
                void this._removeSourcesMany(msg.ids);
                break;
            case 'sourceUpdate':
                void ReaderPanel.bookSources
                    ?.update(msg.id, { name: msg.name, searchUrl: msg.searchUrl })
                    .then(() => this.postSources());
                break;
            case 'sourceExport':
                void vscode.commands.executeCommand('novelReader.exportSources');
                break;
            case 'sourceCheckPause':
                ReaderPanel.bookSources?.pauseCheck?.(msg.scope || 'active', msg.paused, msg.runId);
                break;
            case 'sourceCheckCancel':
                ReaderPanel.bookSources?.cancelCheck?.(msg.scope || 'active', msg.runId);
                break;
            case 'sourceCheck':
                // 兼容旧调用: 只传 id 时按单源检查
                void vscode.commands.executeCommand('novelReader.checkSources',
                    msg.scope || msg.runId ? { id: msg.id, scope: msg.scope, runId: msg.runId } : msg.id);
                break;
            case 'sourceRevive':
                void ReaderPanel.bookSources?.revive(msg.id).then(() => this.postSources());
                break;
            case 'sourceReviveMany':
                void this._reviveDeadSources(msg.ids);
                break;
            case 'sourceClearDead':
                void this._clearDeadSources();
                break;
            case 'sourceSetEnabled':
                void ReaderPanel.bookSources
                    ?.setEnabledMany(msg.patches || [])
                    .then(() => this.postSources());
                break;
        }
    }

    /** 批量删除书源: 二次确认后一次写盘 */
    private async _removeSourcesMany(ids: string[]): Promise<void> {
        const api = ReaderPanel.bookSources;
        if (!api?.removeMany || !ids.length) { return; }
        const pick = await vscode.window.showWarningMessage(
            '确定删除选中的 ' + ids.length + ' 个书源吗？删除后需要重新导入才能恢复。',
            { modal: true },
            '删除'
        );
        if (pick !== '删除') { return; }
        const n = await api.removeMany(ids);
        this.postSources();
        void vscode.window.showInformationMessage('已删除 ' + n + ' 个书源');
    }

    /** 批量恢复失效书源: 全部恢复需二次确认; 恢复只清标记, 不改启用状态 */
    private async _reviveDeadSources(ids?: string[]): Promise<void> {
        const api = ReaderPanel.bookSources;
        if (!api?.reviveMany) { return; }
        const all = !ids || ids.length === 0;
        const total = all ? api.deadCount() : ids.length;
        if (total <= 0) { return; }
        if (all) {
            const pick = await vscode.window.showWarningMessage(
                '确定恢复全部 ' + total + ' 个失效书源吗？恢复后它们会重新参与搜索，下次检查仍可能再次失效。',
                { modal: true },
                '全部恢复'
            );
            if (pick !== '全部恢复') { return; }
        }
        const count = await api.reviveMany(all ? undefined : ids);
        this.postSources();
        void vscode.window.showInformationMessage('已恢复 ' + count + ' 个书源');
    }

    /** 清除全部失效书源: 模态确认后删除 */
    private async _clearDeadSources(): Promise<void> {
        const api = ReaderPanel.bookSources;
        if (!api) { return; }
        const total = api.deadCount();
        if (total <= 0) { return; }
        const pick = await vscode.window.showWarningMessage(
            '确定清除 ' + total + ' 个失效书源吗？清除后需要重新导入才能恢复。',
            { modal: true },
            '删除'
        );
        if (pick !== '删除') { return; }
        const removed = await api.clearDead();
        this.postSources();
        void vscode.window.showInformationMessage('已清除 ' + removed + ' 个失效书源');
    }

    /** 批量检查进度(书源 Tab / 失效 Tab 的暂停按钮与进度行) */
    public postSourceCheckProgress(p: {
        scope: 'active' | 'dead' | 'all' | 'single';
        done: number;
        total: number;
        sourceName: string;
        paused: boolean;
        runId?: number;
    }): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'sourceCheckProgress', ...p });
    }

    /** 批量检查结束(scope + runId 供 webview 丢弃上一轮迟到的结束消息) */
    public postSourceCheckDone(scope: 'active' | 'dead' | 'single' | 'all', runId?: number): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'sourceCheckDone', scope, runId });
    }

    /** 推送书源列表(精简视图) */
    public postSources(): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({
            type: 'sources',
            items: ReaderPanel.bookSources ? ReaderPanel.bookSources.list() : [],
        });
    }

    /** 推送阅读历史(打开面板/批量删除后) */
    public postHistory(): void {
        if (!this._ready) { return; }
        const payload = ReaderPanel.historyProvider?.() || { local: [], online: [] };
        void this._panel.webview.postMessage({ type: 'history', payload });
    }

    /** 把全量笔记推给 webview(init 后/路径迁移后调用) */
    public postNotes(): void {
        if (!this._ready) { return; }
        const items = ReaderPanel.notes ? ReaderPanel.notes.list() : [];
        void this._panel.webview.postMessage({ type: 'notes', items });
    }

    // ---------------------------------------------------------- 离线下载推送

    /** 推送当前书的离线状态快照(请求状态 / 清缓存后) */
    public postOfflineStatus(view: OfflineStatusView | undefined): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({
            type: 'offlineStatus',
            // I5: 归属字段。webview 只对"当前书"应用 offline, 其余仅更新任务表
            filePath: view ? view.filePath : this._novel.filePath,
            payload: view ?? null,
        });
    }

    /** 下载任务表快照(与"当前书"无关的全局视图) */
    private _downloadTasks(): DownloadTaskView[] {
        const api = ReaderPanel.offline;
        return api ? api.tasks() : [];
    }

    /** 推送刷新书架的预演计划(webview 据此弹确认框) */
    public postShelfRefreshPlan(plan: ShelfRefreshPlan): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'shelfRefreshPlan', payload: plan });
    }

    /** 推送刷新书房的执行结果(各分类计数 + 差异说明) */
    public postShelfRefreshResult(result: ShelfRefreshResult): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'shelfRefreshResult', payload: result });
    }

    /** 推送下载任务表全量快照(init / 控制回包后 / 下载结束) */
    public postDownloadTasks(): void {
        if (!this._ready) { return; }
        const payload: DownloadTasksPayload = { tasks: this._downloadTasks() };
        void this._panel.webview.postMessage({ type: 'downloadTasks', payload });
    }

    /** 推送写操作终态(opId 原样回传, webview 据此收敛 UI 并解除按钮禁用) */
    public postOpResult(result: OpResultPayload): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'opResult', payload: result });
    }

    /**
     * 回写操作终态。
     * **缺少 opId 的旧调用一律不回** —— 老 webview 没有对应的 pending 表，
     * 多发一条无法匹配的消息只会变成噪音。
     */
    private _replyOp(
        opId: string | undefined,
        op: OpKind,
        ok: boolean,
        message?: string,
        detail?: Record<string, number>
    ): void {
        if (!opId) { return; }
        this.postOpResult({ opId, op, ok, message, detail });
    }

    /**
     * 执行一个"命令型"写操作并回终态。
     *
     * 失败有两种表达方式，都支持：
     *  - 命令 reject（异常）；
     *  - 命令 resolve 出 `{ ok: false, message }`（用户取消 / 业务失败时更自然，
     *    不会在命令面板调用路径上多弹一个"命令执行失败"）。
     * 失败时**不改动 webview 的选择态与草稿**，由 UI 层保留上下文。
     */
    private _runOp(opId: string | undefined, op: OpKind, run: () => PromiseLike<unknown>): void {
        void Promise.resolve(run()).then(
            (res: unknown) => {
                const r = res as { ok?: boolean; message?: string } | null | undefined;
                if (r && typeof r === 'object' && r.ok === false) {
                    this._replyOp(opId, op, false, r.message || '操作未完成');
                    return;
                }
                this._replyOp(opId, op, true);
            },
            (err: unknown) => {
                this._replyOp(opId, op, false, err instanceof Error ? err.message : String(err));
            }
        );
    }

    /** 推送下载进度(宿主侧已节流, 这里不再判断频率) */
    public postDownloadProgress(p: {
        done: number; total: number; failed: number;
        running: boolean; paused: boolean;
        index?: number; title?: string; added?: number[];
        filePath?: string;
        bookTitle?: string;
    }): void {
        if (!this._ready) { return; }
        const payload: DownloadProgressPayload = {
            done: p.done,
            total: p.total,
            failed: p.failed,
            running: p.running,
            paused: p.paused,
            index: p.index,
            title: p.title,
            added: p.added,
            bookTitle: p.bookTitle,
            // 缺省回退到当前书: 旧调用点不传 key 时行为不变
            filePath: p.filePath || this._novel.filePath,
        };
        void this._panel.webview.postMessage({ type: 'downloadProgress', payload });
    }

    /** 推送下载结束(成功/取消/有失败) */
    public postDownloadDone(r: {
        ok: boolean; cancelled: boolean; done: number; total: number; failed: number;
        message?: string; filePath?: string;
    }): void {
        if (!this._ready) { return; }
        const payload: DownloadDonePayload = {
            ok: r.ok,
            cancelled: r.cancelled,
            done: r.done,
            total: r.total,
            failed: r.failed,
            message: r.message,
            filePath: r.filePath || this._novel.filePath,
        };
        void this._panel.webview.postMessage({ type: 'downloadDone', payload });
    }

    /** 推送全站离线缓存汇总(存储面板) */
    public postOfflineStats(stats: { bytes: number; books: number }): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({ type: 'offlineStats', payload: stats });
    }

    /** 推送目录的每章标记(临时缓存 / 已读) */
    public postChapterMarks(marks: ChapterMarksView, filePath?: string): void {
        if (!this._ready) { return; }
        void this._panel.webview.postMessage({
            type: 'chapterMarks',
            filePath: filePath || this._novel.filePath,
            payload: marks,
        });
    }

    /** 异步取一次每章标记并推给 webview(本地书跳过) */
    private _postChapterMarks(): void {
        const provider = ReaderPanel.chapterMarks;
        if (!provider || !this._novel.online) { return; }
        const novel = this._novel;
        void provider(novel)
            .then((marks) => {
                // 期间可能已换书/关面板: 丢弃过期结果
                if (!marks || ReaderPanel.current !== this || this._novel !== novel) { return; }
                this.postChapterMarks(marks, novel.filePath);
            })
            .catch(() => { /* 读盘失败不影响阅读 */ });
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

    /**
     * 组章节载荷。
     *
     * I1(捕获即冻结) 的落地: 所有读取都基于传入的 novel/index/ratio 快照,
     * 不在方法体内二次读 `this._novel` / `this._chapterIndex` —— 否则
     * "await 期间用户换了书"就会把 A 的正文配上 B 的章节号。
     */
    private _chapterPayload(
        novel: Novel,
        index: number,
        scrollRatio: number,
        reqId: number
    ): ChapterPayload {
        const ch = novel.chapters[index];
        return {
            index,
            title: ch ? ch.title : '',
            paragraphs: ch ? ch.content.split('\n') : [],
            totalChapters: novel.chapters.length,
            chapterWords: ch ? ch.wordCount : 0,
            scrollRatio,
            // I5 归属必填: 每条异步回包都要能自证"属于哪本书 / 哪一轮"
            filePath: novel.filePath,
            reqId,
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
            online: this._novel.online
                ? {
                    sourceName: this._novel.online.sourceName,
                    bookUrl: this._novel.online.bookUrl,
                    preview: !!this._novel.online.preview,
                }
                : undefined,
            offline: ReaderPanel.offlineView?.(this._novel.filePath),
            // 协议版本协商: 老 webview 忽略这两个字段, 新 webview 据此开严格模式
            protocolVersion: PROTOCOL_VERSION,
            downloadTasks: this._downloadTasks(),
        };
        this._openSettingsOnLoad = false;
        this._panel.webview.postMessage({ type: 'init', payload });
        // 目录的「已缓存 / 已读」标记要读盘, 异步补一帧(不阻塞首屏)
        this._postChapterMarks();
        // 在线书首章若尚未取到正文(预取失败), 打开后立刻走一次懒加载/错误提示
        if (this._novel.online && !this._novel.chapters[this._chapterIndex]?.content) {
            this._postChapter();
        }
        // 摸鱼会话状态补发: webview 是新实例(state.slackerActive 初始 false),
        // 若会话早已开启(先摸鱼后开阅读器), 不补发会导致侧边栏高亮丢失
        this._panel.webview.postMessage({
            type: 'slackerActive',
            payload: ReaderPanel._currentSlackerActive(),
        });
    }

    /**
     * 投递当前章。
     *
     * 不变量:
     *  I2 唯一活请求 —— `_liveChapter` 只保留最新一轮, 回包按 reqId 精确比对;
     *  I3 锁按请求实例释放 —— 锁值存 reqId, 避免"第一轮结束把第二轮锁解掉";
     *  I4 缓存写入与投递分离 —— 见 `_loadOnlineChapter`。
     *
     * @param force true = 允许同章再开一轮(重试用), 旧轮靠 I2 丢弃
     */
    private _postChapter(force = false): void {
        if (!this._ready) {
            return;
        }
        // I1: 入口处一次捕获, 之后不再读任何 this._xxx 状态字段
        const novel = this._novel;
        const gen = this._bookGen;
        const index = this._chapterIndex;
        const chapter = novel.chapters[index];
        const needLoad = !!novel.online && !!chapter && !chapter.content && !!ReaderPanel.onlineChapterLoader;
        if (!needLoad) {
            this._postChapterPayload();
            return;
        }
        const key = gen + ':' + index;
        if (!force && this._chapterLocks.has(key)) {
            return;
        }
        const reqId = ++this._reqSeq;
        this._chapterLocks.set(key, reqId);
        this._liveChapter = { reqId, gen, index };
        this._inflight.set(reqId, { gen, index });
        const payload: ChapterLoadingPayload = { index, title: chapter.title, filePath: novel.filePath, reqId };
        void this._panel.webview.postMessage({ type: 'chapterLoading', payload });
        void this._loadOnlineChapter({ novel, gen, index, reqId });
    }

    /**
     * 该回包是否允许投递给 webview。
     *
     * 三个条件缺一不可: 本面板仍是当前面板 / 书代号没变 / 仍是最新一轮。
     * 只比 filePath 不够(A → B → A 会误判), 只比 reqId 也不够(切书后编号继续增大)。
     */
    private _deliverable(task: { gen: number; reqId: number }): boolean {
        return ReaderPanel.current === this
            && task.gen === this._bookGen
            && !!this._liveChapter
            && this._liveChapter.reqId === task.reqId;
    }

    /** 在线章: 加载正文(缓存优先由 loader 处理) */
    private async _loadOnlineChapter(
        task: { novel: Novel; gen: number; index: number; reqId: number }
    ): Promise<void> {
        const loader = ReaderPanel.onlineChapterLoader;
        if (!loader) {
            return;
        }
        try {
            const paragraphs = await loader(task.novel, task.index);
            // I4: 正文写进**捕获到的** novel 对象。迟到的 A 正文仍进 A 的临时缓存
            // (对 A 后续打开是有益的), 但下面的投递必须过归属校验。
            const chapter = task.novel.chapters[task.index];
            if (chapter) {
                chapter.content = paragraphs.join('\n');
                chapter.wordCount = chapter.content.length;
                if (this._deliverable(task)) {
                    const payload: ChapterCachedPayload = {
                        index: task.index,
                        filePath: task.novel.filePath,
                        reqId: task.reqId,
                    };
                    void this._panel.webview.postMessage({ type: 'chapterCached', payload });
                }
            }
            if (this._deliverable(task) && this._chapterIndex === task.index) {
                this._postChapterPayload(task.reqId);
            }
        } catch (err) {
            if (this._deliverable(task) && this._chapterIndex === task.index) {
                const payload: ChapterErrorPayload = {
                    index: task.index,
                    message: err instanceof Error ? err.message : String(err),
                    filePath: task.novel.filePath,
                    reqId: task.reqId,
                };
                void this._panel.webview.postMessage({ type: 'chapterError', payload });
            }
        } finally {
            // I3: 只在"锁仍属于自己这一轮"时释放
            const key = task.gen + ':' + task.index;
            if (this._chapterLocks.get(key) === task.reqId) {
                this._chapterLocks.delete(key);
            }
            this._inflight.delete(task.reqId);
        }
    }

    /** 重试当前章: 显式释放锁并开新一轮(旧轮靠 I2 丢弃, 不会被误当成新一轮的回包) */
    private _retryChapter(index: number): void {
        if (index !== this._chapterIndex) { return; }
        this._chapterLocks.delete(this._bookGen + ':' + index);
        this._liveChapter = null;
        this._postChapter(true);
    }

    private _postChapterPayload(reqId?: number): void {
        const novel = this._novel;
        const index = this._chapterIndex;
        // 没有指定轮次(本地书 / 命中缓存)时也要占一个新编号,
        // 保证 webview 侧 `reqId < chapterReqSeq` 的兜底判断始终有效
        const rid = typeof reqId === 'number' ? reqId : ++this._reqSeq;
        void this._panel.webview.postMessage({
            type: 'chapter',
            payload: this._chapterPayload(novel, index, this._scrollRatio, rid),
        });
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
        // 界面字号首帧值(与 webview 侧 applyThemeVars 同源): 必须排在 ${this._webviewCss}
        // 之后 —— 同一 <style> 内同特异性"后者胜", 写在前面会被 reader.css 的
        // :root 静态兜底(14/12/15) 盖掉, 大字号用户就会先闪一帧 14px。
        const ui = uiFontVars(settings.uiFontSize);

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
    /* 危险/成功状态色: 与 webview 侧 applyThemeVars 同源, 否则首帧危险按钮文字是白色, 切主题后才变 */
    --danger-fg: ${t.dangerFg};
    --success: ${t.success};
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
  /* 界面字号: 必须排在 reader.css 之后(同特异性后者胜), 否则会被上面的静态兜底盖掉 */
  :root {
    --ui-font: ${ui.main};
    --ui-font-sub: ${ui.sub};
    --ui-font-title: ${ui.title};
  }
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
