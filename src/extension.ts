/**
 * extension.ts — 插件入口
 *
 * 职责:
 *  - 注册命令 / 阅读面板(内含 书架/目录/存储 左抽屉)
 *  - 打开并解码本地 txt(自动识别 UTF-8 / GB18030 / UTF-16 编码)
 *  - 书架管理: 多本小说的登记、进度同步、移除
 *  - 启动时不自动弹出阅读页(状态栏「小说阅读」/ novelReader.resumeCurrent 进入)
 *  - VS Code 设置页修改阅读偏好时同步到阅读界面
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseNovel, deriveTitleAuthor, createEmptyNovel, Novel } from './novelParser';
import { ReaderPanel, ShelfItemView, DrawerTab, ReaderPanelState, OfflineStatusView, ChapterMarksView } from './readerPanel';
import { ShelfStore } from './shelf';
import { HistoryStore, buildOpenEntry } from './history';
import { NotesStore } from './notes';
import { ensureInLibrary, isInsideDir } from './library';
import { shelfBookKey, planDuplicateRemoval } from './shelfMaintenance';
import { moveToTrash } from './trash';
import { ReadingSettings, SettingsStore } from './settings';
import { decodeBuffer } from './encoding';
import { SlackerController } from './slacker';
import { BookSource, BookSourceStore, LEGACY_BOOK_SOURCES_KEY, parseSourceText, toSourceView } from './bookSource';
import { SearchControl, SearchService } from './online/searchService';
import { buildSearchRequest } from './online/searchUrl';
import { parseSearchPage } from './online/ruleApply';
import { fetchForSource, sandboxHttpFor, SourceHttpPool } from './online/sourceHttp';
import { fetchChapter, fetchToc, OnlineChapter } from './online/onlineBook';
import { OnlineCache } from './onlineCache';
import { isOnlinePath, onlineKey, OnlineRef } from './onlinePath';
import { OfflineStore } from './offline/offlineStore';
import { DownloadService } from './offline/downloadService';
import type { DownloadProgressEvent, DownloadResult } from './offline/downloadService';
import { exportOfflineTxt, safeFileName, uniquePath } from './offline/exportTxt';
import { SingleFlight } from './util/async';
import type { DownloadTaskView, ShelfRefreshPlan, ShelfRefreshResult } from './protocol';
import { planShelfRefresh, applyShelfRefresh, type FsProbe, type PlanInput, type ProbeCode } from './shelfRefresh';

interface LoadOptions {
    chapterIndex?: number;
    scrollRatio?: number;
    openPanel?: boolean;
    openSettings?: boolean;
    silent?: boolean;
    /** 失败时把真实原因回传给调用方(预览用) */
    onError?: (err: unknown) => void;
}

let historyStore: HistoryStore | undefined;
/** 插件卸载时要停掉后台下载(队列挂在 activate 作用域, 这里留一个引用) */
let downloadQueue: DownloadService | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const store = new SettingsStore(context.globalState);
    const shelf = new ShelfStore(context.globalState);
    const history = new HistoryStore(context.globalState);
    history.load();
    historyStore = history;
    ReaderPanel.historyProvider = () => history.list();
    const notes = new NotesStore(context.globalState);
    // 书架/目录/存储 已并入阅读面板左抽屉; 面板未打开时用状态栏按钮或命令面板进入
    ReaderPanel.getShelf = () => shelfItems();
    ReaderPanel.notes = notes;
    ReaderPanel.getLibrary = () => getLibraryPath();
    // 章节位置记忆(书架 chapterRatios): 目录切走再切回时恢复原阅读位置
    ReaderPanel.getChapterRatio = (filePath: string, chapterIndex: number) =>
        shelf.getRatio(filePath, chapterIndex);

    /**
     * 离线下载区与临时读缓存**分目录**:
     * online-cache 只放"读过就缓存"的章, 删书架时一起清掉;
     * offline-cache 是用户主动下载的内容, 删书架时可选择保留。
     * 混在一起的话, "保留离线内容"和"清临时缓存"两种语义会互相踩。
     *
     * 声明放在 shelfItems 之前: 书架列表要读 offlineIndex 打「离线 N」标签。
     */
    const offlineStore = new OfflineStore(path.join(context.globalStorageUri.fsPath, 'offline-cache'));
    /** 阅读侧与下载侧的同一章请求去重 */
    const inflightChapters = new SingleFlight<string, string[]>();
    /** 内存索引: filePath(online://伪路径) → 状态快照 */
    const offlineIndex = new Map<string, OfflineStatusView>();
    let offlineGlobalStats: { bytes: number; books: number } = { bytes: 0, books: 0 };

    /** 离线下载队列(不依赖 vscode, 便于单测; 抓取走阅读侧同一条链路) */
    const downloadService = new DownloadService({
        store: offlineStore,
        fetchChapter: (chapter, ref, signal) => onlineChapterParagraphs(ref, chapter.index, chapter.url, signal),
    });
    downloadQueue = downloadService;

    // ---------------------------------------------------------------- 阅读页窗口恢复
    // VS Code 重开窗口会尝试恢复上次的 webview; 这里接管它:
    // 默认(设置 novelReader.restoreOnStartup = false)直接丢弃, 不让阅读页自动弹出;
    // 需要"重开窗口继续读"的用户可在设置里打开, 届时会重新解析并还原章节/位置。
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(ReaderPanel.viewType, {
            async deserializeWebviewPanel(
                panel: vscode.WebviewPanel,
                state: unknown
            ): Promise<void> {
                const enabled = store.get().restoreOnStartup;
                // 书架进度查询(供restore 用)。返回 undefined = 该书尚未登记进度,
                // 此时 restore 会退回 webview state, 并在下方补登记。
                const shelved = (filePath: string) => {
                    const b = shelf.get(filePath);
                    return b && b.chapterIndex >= 0
                        ? { chapterIndex: b.chapterIndex, scrollRatio: b.scrollRatio }
                        : undefined;
                };
                await ReaderPanel.restore(
                    panel,
                    state as ReaderPanelState | undefined,
                    store,
                    enabled,
                    shelved
                );
                // 恢复后的面板同样要保证在书架里(旧版本或异常路径可能没登记),
                // 并把恢复用的章节号立刻写回书架 —— 否则下一次重启就又丢了
                const fp = (state as ReaderPanelState | undefined)?.filePath;
                const restored = ReaderPanel.current;
                if (fp && restored && !shelf.get(fp)) {
                    void shelf.upsert({
                        filePath: fp,
                        title: restored.bookTitle || path.basename(fp),
                        author: restored.author,
                        totalChapters: restored.chapterCount,
                    }).then(() => shelf.updateProgress(fp, restored.chapterIndex, restored.scrollRatio));
                }
            },
        })
    );

    // 状态栏入口(活动栏侧边栏移除后的常驻入口)
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.text = '$(book) 小说阅读';
    statusItem.tooltip = '打开阅读面板 / 继续上次阅读';
    statusItem.command = 'novelReader.resumeCurrent';
    statusItem.show();
    context.subscriptions.push(statusItem);

    let currentNovel: Novel | null = null;

    // ---------------------------------------------------------------- 视图状态同步

    function shelfItems(): ShelfItemView[] {
        return shelf.list().map((b) => ({
            filePath: b.filePath,
            title: b.title || (b.online ? b.online.sourceName + ' · 在线书' : path.basename(b.filePath)),
            author: b.author,
            chapterIndex: b.chapterIndex,
            totalChapters: b.totalChapters,
            current: !!currentNovel && currentNovel.filePath === b.filePath,
            online: !!b.online,
            sourceName: b.online?.sourceName,
            // 搜索结果行靠它对上书架记录(移出/已加入判定)
            onlineBookUrl: b.online?.bookUrl,
            // 离线下载进度(书架行显示「离线 N」)
            offline: offlineTagOf(b.filePath),
        }));
    }

    /** 书架行的离线标记: 只暴露 done/total, 不带全量章号列表 */
    function offlineTagOf(filePath: string): { done: number; total: number } | undefined {
        const view = offlineIndex.get(filePath);
        if (!view) { return undefined; }
        const status = downloadService.statusOf(filePath);
        const done = status ? Math.max(view.done, status.done) : view.done;
        return done > 0 ? { done, total: view.total } : undefined;
    }

    function refreshShelfView(): void {
        ReaderPanel.setShelf(shelfItems());
        // 顺带同步摸鱼会话状态(面板重载后恢复「摸鱼模式」高亮)
        ReaderPanel.setSlackerActive(slacker.isActive);
    }

    /** 书库目录(空 = 未设置, 直接读取原路径); 由 SettingsStore 统一读写 */
    function getLibraryPath(): string {
        return store.getLibraryPath();
    }

    function syncLibraryToView(): void {
        ReaderPanel.setLibrary(getLibraryPath());
    }

    // ---------------------------------------------------------------- 加载小说

    /**
     * 「打开意图」序号 —— 覆盖**全部**打开入口(本地/在线/预览/启动器/抽屉/续读/恢复)。
     *
     * 为什么需要它: 打开一本书常常要等网络(抓目录、预取首章), 期间用户可能已经
     * 从书架点了另一本。若不在 createOrShow 之前比对序号, "慢的那本"回来时会把
     * 面板切回去(R2-07)。编号必须在**任何 await 之前**取, 否则两个并发请求会拿到
     * 同一个号, 校验形同虚设。
     */
    let openIntentSeq = 0;
    /** 取一个新的打开意图号(同步, 必须在 await 之前调用) */
    function nextOpenIntent(): number {
        openIntentSeq += 1;
        return openIntentSeq;
    }
    /** 本次打开意图是否仍然最新(放到 createOrShow 之前判断) */
    function openIntentAlive(seq: number): boolean {
        return seq === openIntentSeq;
    }

    /** 加载小说: 解析 -> 登记书架 -> 刷新视图 -> (可选)打开阅读面板 */
    /**
     * 记录"打开一本书"的阅读历史。
     *
     * 刻意不查书架: 从书源搜出来、还没加入书架(预览态)的书同样要记 ——
     * 老版本这里有一道 `if (!shelf.get(filePath)) return;` 门禁,
     * 导致"本地书打开后不滚动就没有历史"以及"预览书永远进不了历史"。
     */
    function recordOpenHistory(novel: Novel, chapterIndex: number, totalOverride?: number): void {
        const entry = buildOpenEntry(novel, shelf.get(novel.filePath), chapterIndex, totalOverride);
        if (entry) { history.record(entry); }
    }

    async function loadNovel(filePath: string, opts: LoadOptions = {}): Promise<Novel | undefined> {
        if (isOnlinePath(filePath)) { return loadOnlineNovel(filePath, opts); }
        // 打开意图号: 必须在第一个 await 之前取
        const intentSeq = nextOpenIntent();
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error('文件不存在');
            }
            const buf = fs.readFileSync(filePath);
            const { text, encoding } = decodeBuffer(buf);
            const novel = parseNovel(text, filePath, encoding);

            if (novel.chapters.length === 0) {
                if (!opts.silent) {
                    vscode.window.showWarningMessage(
                        `未能从「${path.basename(filePath)}」解析出章节, 请检查文件是否为小说文本。`
                    );
                }
                return undefined;
            }

            currentNovel = novel;

            // 书库目录: 已设置则导入时复制一份到书库, 之后引用副本(原文件可自行移动/删除)
            const library = getLibraryPath();
            if (library) {
                try {
                    const res = await ensureInLibrary(filePath, library);
                    if (res.path !== filePath) {
                        novel.filePath = res.path;
                    }
                    if (res.copied && !opts.silent) {
                        vscode.window.setStatusBarMessage(
                            `已复制到书库：${path.basename(res.path)}`,
                            4000
                        );
                    }
                } catch (err) {
                    vscode.window.showWarningMessage(
                        `复制到书库失败，将直接读取原文件：${
                            err instanceof Error ? err.message : String(err)
                        }`
                    );
                }
            }

            // 笔记与书架进度都必须落在"实际读取路径"上:
            // 设了书库目录时 novel.filePath 已是副本路径, 而用户选的是原始路径,
            // 若不归一会出现"书架有两条记录 / 笔记分组对不上"的历史问题。
            if (novel.filePath !== filePath && !shelf.get(novel.filePath)) {
                const legacy = shelf.get(filePath);
                if (legacy) {
                    await shelf.relink(filePath, novel.filePath, {
                        title: novel.bookTitle,
                        author: novel.author,
                        totalChapters: novel.chapters.length,
                    });
                }
                await notes.relink(filePath, novel.filePath, novel.bookTitle);
            }
            const entry = await shelf.upsert({
                filePath: novel.filePath,
                title: novel.bookTitle,
                author: novel.author,
                totalChapters: novel.chapters.length,
            });
            refreshShelfView();
            void vscode.commands.executeCommand('setContext', 'novelReader.hasNovel', true);

            // 自动延续上次阅读状态: 该书已读过的章节与章内位置
            const hasProgress = entry.chapterIndex >= 0;
            const chapterIndex =
                opts.chapterIndex ??
                (hasProgress ? Math.min(entry.chapterIndex, novel.chapters.length - 1) : 0);
            const scrollRatio = opts.scrollRatio ?? (hasProgress ? entry.scrollRatio : 0);

            if (opts.openPanel !== false) {
                // 期间用户可能已经打开了别的书: 旧意图不再抢面板
                if (openIntentAlive(intentSeq)) {
                    ReaderPanel.createOrShow(
                        novel,
                        chapterIndex,
                        scrollRatio,
                        store,
                        vscode.ViewColumn.One,
                        opts.openSettings
                    );
                }
            }
            return novel;
        } catch (err) {
            if (!opts.silent) {
                vscode.window.showErrorMessage(
                    `打开小说文件失败: ${err instanceof Error ? err.message : String(err)}`
                );
            }
            return undefined;
        }
    }

    /** 确保已有打开的书(没有则用书架里最近读的那本) */
    async function ensureNovel(): Promise<Novel | null> {
        if (currentNovel) {
            return currentNovel;
        }
        const last = shelf.last();
        if (last && (isOnlinePath(last.filePath) || fs.existsSync(last.filePath))) {
            await loadNovel(last.filePath, { openPanel: false, silent: true });
        }
        return currentNovel;
    }

    // ---------------------------------------------------------------- 在线书

    /** 目录: 缓存优先, 过期/强制时抓取(失败回退旧缓存) */
    async function resolveOnlineToc(
        ref: OnlineRef,
        force = false
    ): Promise<{ chapters: OnlineChapter[]; tocUrl: string; fetchedAt: number }> {
        const key = onlineKey(ref.sourceId, ref.bookUrl);
        const cached = await onlineCache.readToc(key);
        const fresh = cached && Date.now() - cached.fetchedAt < TOC_TTL;
        if (!force && fresh) { return cached; }
        const source = bookSources.get(ref.sourceId);
        if (!source) { throw new Error('书源已被删除, 无法加载在线书'); }
        try {
            const toc = await fetchToc(source, ref.bookUrl, { pool: sourcePool });
            await onlineCache.writeToc(key, {
                v: 1,
                fetchedAt: toc.fetchedAt,
                tocUrl: toc.tocUrl,
                chapters: toc.chapters,
            });
            return toc;
        } catch (err) {
            if (cached) { return cached; }
            throw err;
        }
    }

    /**
     * 正文: 三级优先 —— 离线下载区 → 临时读缓存 → 网络(单飞去重)。
     *
     * 单飞的意义: 用户翻到某章的同时下载队列可能也在抓同一章,
     * 不去重会对同一 URL 发两次请求(浪费流量, 还容易触发站点限流)。
     */
    async function onlineChapterParagraphs(
        ref: OnlineRef,
        index: number,
        url: string,
        signal?: AbortSignal
    ): Promise<string[]> {
        const key = onlineKey(ref.sourceId, ref.bookUrl);

        const offline = await offlineStore.readChapter(key, index);
        if (offline) { return offline; }

        const cached = await onlineCache.readChapter(key, index);
        if (cached) { return cached; }

        return inflightChapters.run(key + '#' + index, async () => {
            const source = bookSources.get(ref.sourceId);
            if (!source) { throw new Error('书源已被删除, 无法加载正文'); }
            const res = await fetchChapter(source, url, {
                pool: sourcePool,
                referer: ref.bookUrl,
                signal,
            });
            await onlineCache.writeChapter(key, index, res.paragraphs);
            return res.paragraphs;
        });
    }

    /** 取一本书对应的在线元信息: 预览书没有书架记录, 用 novel.online 兜底 */
    function refForNovel(novel: Novel): OnlineRef | undefined {
        if (novel.online) {
            return {
                sourceId: novel.online.sourceId,
                sourceName: novel.online.sourceName,
                bookUrl: novel.online.bookUrl,
                tocUrl: novel.online.tocUrl,
            };
        }
        return shelf.get(novel.filePath)?.online;
    }

    // ------------------------------------------------------------ 离线下载

    /** 重建离线索引(下载结束后 / 清缓存后 / 启动时) */
    async function refreshOfflineIndex(): Promise<void> {
        try {
            const [entries, stats] = await Promise.all([
                offlineStore.listAll(),
                offlineStore.totalSize(),
            ]);
            offlineGlobalStats = stats;
            offlineIndex.clear();
            for (const entry of entries) {
                const m = entry.manifest;
                offlineIndex.set(entry.key, {
                    filePath: entry.key,
                    total: m.totalChapters || m.chapters.length,
                    done: entry.done.length,
                    failed: m.failed ? Object.keys(m.failed).length : 0,
                    running: downloadService.isRunning(entry.key),
                    paused: downloadService.statusOf(entry.key)?.paused ?? false,
                    downloaded: entry.done,
                    bytes: entry.bytes,
                    totalBytes: stats.bytes,
                    bookCount: stats.books,
                });
            }
        } catch { /* 读盘失败不影响阅读 */ }
    }

    /** 同步快照(OnlineApi.status / init 首帧) */
    function offlineViewOf(filePath: string): OfflineStatusView | undefined {
        const cached = offlineIndex.get(filePath);
        if (cached) {
            const status = downloadService.statusOf(filePath);
            return {
                ...cached,
                running: downloadService.isRunning(filePath),
                paused: status?.paused ?? false,
                done: status ? Math.max(cached.done, status.done) : cached.done,
                failed: status ? status.failed : cached.failed,
                totalBytes: offlineGlobalStats.bytes,
                bookCount: offlineGlobalStats.books,
            };
        }
        // 还没进索引(刚下第一章): 至少把"正在下"的状态暴露出来
        const status = downloadService.statusOf(filePath);
        if (!status) { return undefined; }
        return {
            filePath,
            total: status.total,
            done: status.done,
            failed: status.failed,
            running: status.running,
            paused: status.paused,
            downloaded: [],
            bytes: 0,
            totalBytes: offlineGlobalStats.bytes,
            bookCount: offlineGlobalStats.books,
        };
    }

    function pushOfflineStatus(): void {
        const cur = ReaderPanel.current;
        if (!cur) { return; }
        cur.postOfflineStatus(offlineViewOf(cur.novel.filePath));
        cur.postOfflineStats({ ...offlineGlobalStats });
    }

    // 进度节流: 5000 章的书不要每章都往 webview 发一条
    let lastProgressAt = 0;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingProgress: DownloadProgressEvent | null = null;

    function flushProgress(): void {
        if (!pendingProgress) { return; }
        const p = pendingProgress;
        pendingProgress = null;
        lastProgressAt = Date.now();
        const status = downloadService.statusOf(p.key);
        ReaderPanel.current?.postDownloadProgress({
            done: p.done,
            total: p.total,
            failed: p.failed,
            running: !!status,
            paused: status?.paused ?? false,
            index: p.index,
            title: p.title,
            added: p.added,
            // 归属: 进度属于 p.key 这本书, 不一定是"当前打开的那本"
            filePath: p.key,
            bookTitle: shelf.get(p.key)?.title || '',
        });
    }

    /** 250ms 内的进度只保留最后一条; 首帧立即发, 避免进度条半天不动 */
    function queueProgress(p: DownloadProgressEvent): void {
        pendingProgress = p;
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
            flushProgress();
            return;
        }
        if (!progressTimer) {
            progressTimer = setTimeout(() => {
                progressTimer = null;
                flushProgress();
            }, 250);
        }
    }

    async function finishDownload(r: DownloadResult): Promise<void> {
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
        pendingProgress = null;
        await refreshOfflineIndex();
        refreshShelfView();
        pushOfflineStatus();
        // 任务表快照: 结束后按钮/进度条靠它收敛(哪怕当前打开的是另一本书)
        ReaderPanel.current?.postDownloadTasks();

        const label = shelf.get(r.key)?.title || ReaderPanel.current?.novel.bookTitle || '这本书';
        if (r.cancelled) {
            ReaderPanel.current?.postDownloadDone({
                ok: false, cancelled: true, done: r.done, total: r.total, failed: r.failed,
                message: '已取消', filePath: r.key,
            });
            return;
        }
        ReaderPanel.current?.postDownloadDone({
            ok: r.failed === 0,
            cancelled: false,
            done: r.done,
            total: r.total,
            failed: r.failed,
            filePath: r.key,
        });
        if (r.failed === 0) {
            void vscode.window.showInformationMessage(
                `「${label}」离线下载完成：${r.done}/${r.total} 章`
            );
        } else {
            void vscode.window.showWarningMessage(
                `「${label}」已下载 ${r.done}/${r.total} 章，${r.failed} 章失败（再次下载会自动重试）`
            );
        }
    }

    function currentOfflineKey(): string | undefined {
        const novel = ReaderPanel.current?.novel;
        const ref = novel ? refForNovel(novel) : undefined;
        return ref ? onlineKey(ref.sourceId, ref.bookUrl) : undefined;
    }

    /**
     * 解析下载目标。
     * 优先用显式 `filePath`（= 在线书 `online://` 键）—— 这样"在书架里对 A 发起下载、
     * 随后切到 B"仍然下的是 A；缺省才退回"当前打开的书"。
     */
    function resolveDownloadTarget(
        filePath?: string
    ): { title: string; author: string; ref: OnlineRef; key: string } | undefined {
        const cur = ReaderPanel.current?.novel;
        if (!filePath || (cur && cur.filePath === filePath)) {
            if (!cur) { return undefined; }
            const ref = refForNovel(cur);
            if (!ref) { return undefined; }
            return { title: cur.bookTitle, author: cur.author, ref, key: onlineKey(ref.sourceId, ref.bookUrl) };
        }
        const entry = shelf.get(filePath);
        if (!entry?.online) { return undefined; }
        return {
            title: entry.title,
            author: entry.author,
            ref: entry.online,
            key: filePath,
        };
    }

    /** 开始下载(不传范围 = 整本) */
    async function startOfflineDownload(
        range?: { start?: number; end?: number },
        filePath?: string
    ): Promise<{ ok: boolean; message?: string }> {
        const target = resolveDownloadTarget(filePath);
        if (!target) { return { ok: false, message: '请先打开一本在线书' }; }
        const ref = target.ref;

        const key = target.key;
        if (downloadService.isRunning(key)) { return { ok: false, message: '这本书正在下载中' }; }

        // 目录: 已下载过就用离线快照(书源没了也能续传), 否则走 TTL 缓存/重新抓
        const saved = await offlineStore.readManifest(key);
        let chapters: OnlineChapter[];
        let tocUrl = ref.tocUrl;
        if (saved && saved.chapters.length) {
            chapters = saved.chapters;
            tocUrl = saved.tocUrl || tocUrl;
        } else {
            try {
                const toc = await resolveOnlineToc(ref);
                chapters = toc.chapters;
                tocUrl = toc.tocUrl || tocUrl;
            } catch (err) {
                return { ok: false, message: err instanceof Error ? err.message : '获取目录失败' };
            }
        }
        if (!chapters.length) { return { ok: false, message: '目录为空，无法下载' }; }

        const last = chapters.length - 1;
        const start = Math.min(Math.max(0, range?.start ?? 0), last);
        const end = Math.min(Math.max(start, range?.end ?? last), last);

        lastProgressAt = 0;
        pendingProgress = null;
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }

        downloadService.start(
            {
                key,
                ref: { ...ref, tocUrl, tocFetchedAt: saved?.tocFetchedAt || Date.now() },
                chapters,
                bookTitle: target.title,
                author: target.author,
                range: { start, end },
            },
            {
                onProgress: (p) => queueProgress(p),
                onDone: (r) => { void finishDownload(r); },
            }
        );

        // 立刻回一帧"已开始", 让按钮马上变成「暂停」
        ReaderPanel.current?.postDownloadProgress({
            done: offlineViewOf(key)?.done ?? 0,
            total: end - start + 1,
            failed: 0,
            running: true,
            paused: false,
            filePath: key,
            bookTitle: target.title,
        });
        ReaderPanel.current?.postDownloadTasks();
        return { ok: true };
    }

    /**
     * 导出当前书的离线内容为本地 txt。
     *
     * **只保存文件**: 不打开阅读页、也不加入书架 —— 要不要变成书架里的书由用户自己决定
     * (之后用「添加书籍」或「刷新书架」导入即可)。写完给一条带「打开所在文件夹」的提示。
     */
    async function exportCurrentOfflineTxt(): Promise<{
        ok: boolean; message?: string; filePath?: string; chapters?: number; missing?: number;
    }> {
        const novel = ReaderPanel.current?.novel;
        const ref = novel ? refForNovel(novel) : undefined;
        if (!novel || !ref) { return { ok: false, message: '请先打开一本在线书' }; }

        const key = onlineKey(ref.sourceId, ref.bookUrl);
        const manifest = await offlineStore.readManifest(key);
        if (!manifest) { return { ok: false, message: '这本书还没有离线内容，请先下载' }; }

        const baseName = safeFileName(novel.bookTitle || manifest.bookTitle || '未命名');
        const library = getLibraryPath();

        let targetFile: string;
        if (library) {
            targetFile = await uniquePath(library, baseName + '.txt');
        } else {
            const picked = await vscode.window.showSaveDialog({
                title: '导出为本地 txt',
                saveLabel: '导出',
                defaultUri: vscode.Uri.file(path.join(os.homedir(), baseName + '.txt')),
                filters: { '小说文本': ['txt'] },
            });
            if (!picked) { return { ok: false, message: '已取消' }; }
            targetFile = picked.fsPath;
        }

        const res = await exportOfflineTxt({ store: offlineStore, key, targetFile, baseName });
        if (!res.ok || !res.filePath) {
            return {
                ok: false,
                message: res.message || '导出失败',
                filePath: res.filePath,
                chapters: res.chapters,
                missing: res.missing,
            };
        }

        // 只落盘, 不做任何"打开/加入书架"的副作用
        const suffix = res.missing > 0 ? `（另有 ${res.missing} 章未下载）` : '';
        const where = library ? '书库目录' : path.dirname(res.filePath);
        void vscode.window
            .showInformationMessage(
                `已导出到${where}：${path.basename(res.filePath)}（${res.chapters} 章）${suffix}`,
                '打开所在文件夹'
            )
            .then((picked) => {
                if (picked === '打开所在文件夹') {
                    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.filePath as string));
                }
            });
        return { ok: true, filePath: res.filePath, chapters: res.chapters, missing: res.missing };
    }

    /** 用书架里的 online 元信息重建 Novel(不含正文) */
    async function buildOnlineNovel(filePath: string): Promise<Novel> {
        const entry = shelf.get(filePath);
        const ref = entry?.online;
        if (!entry || !ref) { throw new Error('书架中找不到这本在线书'); }
        const toc = await resolveOnlineToc(ref);
        const chapters = toc.chapters.map(function (c) {
            return { index: c.index, title: c.title, content: '', url: c.url, wordCount: 0 };
        });
        const nextRef: OnlineRef = { ...ref, tocUrl: toc.tocUrl, tocFetchedAt: toc.fetchedAt };
        await shelf.upsert({
            filePath,
            title: entry.title,
            author: entry.author,
            totalChapters: chapters.length,
            online: nextRef,
        });
        return {
            filePath,
            bookTitle: entry.title,
            author: entry.author,
            chapters,
            preface: '',
            encoding: 'utf-8',
            totalWords: ref.wordCount || 0,
            online: {
                sourceId: ref.sourceId,
                sourceName: ref.sourceName,
                bookUrl: ref.bookUrl,
                tocUrl: toc.tocUrl,
            },
        };
    }

    /** 打开在线书: 目录(缓存优先) + 当前章正文预取 */
    async function loadOnlineNovel(filePath: string, opts: LoadOptions = {}): Promise<Novel | undefined> {
        // 打开意图号: 抓目录/预取正文都可能很慢, 必须在 await 之前取号
        const intentSeq = nextOpenIntent();
        try {
            const entry = shelf.get(filePath);
            if (!entry || !entry.online) { throw new Error('书架中找不到这本在线书'); }
            const ref = entry.online;
            const novel = await buildOnlineNovel(filePath);
            if (!novel.chapters.length) { throw new Error('目录为空'); }

            const hasProgress = entry.chapterIndex >= 0;
            const chapterIndex = opts.chapterIndex ??
                (hasProgress ? Math.min(entry.chapterIndex, novel.chapters.length - 1) : 0);
            const scrollRatio = opts.scrollRatio ?? (hasProgress ? entry.scrollRatio : 0);

            // 预取当前章(失败不阻塞打开: 面板会显示错误与重试)
            const chapter = novel.chapters[chapterIndex];
            if (chapter && chapter.url) {
                try {
                    const paragraphs = await onlineChapterParagraphs(ref, chapterIndex, chapter.url);
                    chapter.content = paragraphs.join('\n');
                    chapter.wordCount = chapter.content.length;
                } catch { /* 面板内再加载/重试 */ }
            }

            currentNovel = novel;
            void vscode.commands.executeCommand('setContext', 'novelReader.hasNovel', true);
            refreshShelfView();
            if (opts.openPanel !== false) {
                ReaderPanel.createOrShow(
                    novel,
                    chapterIndex,
                    scrollRatio,
                    store,
                    vscode.ViewColumn.One,
                    opts.openSettings
                );
                // 历史上的写入已由 ReaderPanel.onOpen 统一处理(打开即记), 这里不再重复
            }
            return novel;
        } catch (err) {
            opts.onError?.(err);
            if (!opts.silent) {
                void vscode.window.showErrorMessage(
                    `打开在线书失败: ${err instanceof Error ? err.message : String(err)}`
                );
            }
            return undefined;
        }
    }

    /** 把搜索结果加入在线书架(目录在后台补全) */
    async function addOnlineBook(item: {
        sourceId: string; sourceName: string; title: string; author?: string;
        bookUrl: string; coverUrl?: string; intro?: string; kind?: string;
        lastChapter?: string; wordCount?: number;
    }): Promise<{ ok: boolean; message?: string }> {
        const source = bookSources.get(item.sourceId);
        if (!source) { return { ok: false, message: '书源不存在或已被删除' }; }
        if (!item.bookUrl || !/^https?:\/\//i.test(item.bookUrl)) {
            return { ok: false, message: '书籍地址无效' };
        }
        const key = onlineKey(item.sourceId, item.bookUrl);
        const existing = shelf.get(key);
        const ref: OnlineRef = {
            sourceId: item.sourceId,
            sourceName: source.bookSourceName || item.sourceName,
            bookUrl: item.bookUrl,
            coverUrl: item.coverUrl,
            intro: item.intro,
            kind: item.kind,
            lastChapter: item.lastChapter,
            wordCount: item.wordCount,
        };
        try {
            await shelf.upsert({
                filePath: key,
                title: item.title,
                author: item.author || '',
                totalChapters: existing?.totalChapters || 0,
                online: ref,
            });
        } catch (err) {
            return {
                ok: false,
                message: '写入书架失败: ' + (err instanceof Error ? err.message : String(err)),
            };
        }
        refreshShelfView();
        // 后台抓目录补总章数, 失败不影响已入库
        void (async function () {
            try {
                const toc = await resolveOnlineToc(ref, !existing);
                await shelf.upsert({
                    filePath: key,
                    title: item.title,
                    author: item.author || '',
                    totalChapters: toc.chapters.length,
                    online: { ...ref, tocUrl: toc.tocUrl, tocFetchedAt: toc.fetchedAt },
                });
                refreshShelfView();
            } catch { /* 打开时再提示 */ }
        })();
        return { ok: true, message: existing ? '已在书架' : '' };
    }

    /** 临时预览: 抓目录与首章后直接打开阅读页, 不写入书架 */
    async function previewOnlineBook(item: {
        sourceId: string; sourceName: string; title: string; author?: string;
        bookUrl: string; coverUrl?: string; intro?: string; kind?: string;
        lastChapter?: string; wordCount?: number;
        /** 起始章节(从历史重开时回到原章); 不传则从第 0 章开始 */
        chapterIndex?: number;
    }): Promise<{ ok: boolean; message?: string }> {
        const seq = nextOpenIntent();
        const source = bookSources.get(item.sourceId);
        if (!source) {
            const message = '书源不存在或已被删除';
            void vscode.window.showErrorMessage('预览失败: ' + message);
            return { ok: false, message };
        }
        const key = onlineKey(item.sourceId, item.bookUrl);
        // 已在书架: 直接按正常书打开(预览按钮不会出现)
        if (shelf.get(key)) {
            let detail = '';
            const opened = await loadOnlineNovel(key, {
                openPanel: true,
                silent: true,
                onError: (err) => { detail = err instanceof Error ? err.message : String(err); },
            });
            if (!opened) {
                const message = detail || '打开这本书失败';
                void vscode.window.showErrorMessage('预览失败: ' + message);
                return { ok: false, message };
            }
            return { ok: true };
        }
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在加载预览', cancellable: false },
                async function () {
                    const ref: OnlineRef = {
                        sourceId: item.sourceId,
                        sourceName: source.bookSourceName || item.sourceName,
                        bookUrl: item.bookUrl,
                        coverUrl: item.coverUrl,
                        intro: item.intro,
                        kind: item.kind,
                        lastChapter: item.lastChapter,
                        wordCount: item.wordCount,
                    };
                    const toc = await resolveOnlineToc(ref, true);
                    const chapters = toc.chapters.map(function (c) {
                        return { index: c.index, title: c.title, content: '', url: c.url, wordCount: 0 };
                    });
                    const novel: Novel = {
                        filePath: key,
                        bookTitle: item.title,
                        author: item.author || '',
                        chapters,
                        preface: '',
                        encoding: 'utf-8',
                        totalWords: item.wordCount || 0,
                        online: {
                            sourceId: ref.sourceId,
                            sourceName: ref.sourceName,
                            bookUrl: ref.bookUrl,
                            tocUrl: toc.tocUrl,
                            preview: true,
                        },
                    };
                    const start = Math.min(
                        Math.max(0, typeof item.chapterIndex === 'number' && Number.isFinite(item.chapterIndex)
                            ? item.chapterIndex
                            : 0),
                        Math.max(0, chapters.length - 1)
                    );
                    // 起始章预取(失败也不阻塞, 阅读页会显示重试)
                    try {
                        const first = chapters[start];
                        if (first?.url) {
                            const paragraphs = await onlineChapterParagraphs(ref, start, first.url);
                            first.content = paragraphs.join('\n');
                            first.wordCount = first.content.length;
                        }
                    } catch { /* 预览页内重试 */ }

                    // 旧轮请求: 不打开, 避免覆盖用户后来的选择
                    if (!openIntentAlive(seq)) { return; }
                    currentNovel = novel;
                    ReaderPanel.createOrShow(novel, start, 0, store, vscode.ViewColumn.One);
                }
            );
            if (!openIntentAlive(seq)) {
                return { ok: false, message: '预览请求已被新的操作取代' };
            }
            return { ok: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`预览失败: ${message}`);
            return { ok: false, message };
        }
    }

    /** 把当前预览的书转为正式书架条目 */
    async function savePreview(): Promise<{ ok: boolean; message?: string }> {
        // 面板持有的 novel 才是按钮所属的书(窗口恢复路径下 currentNovel 可能为空或指向别处)
        const novel = ReaderPanel.current?.novel || currentNovel;
        if (!novel?.online || !novel.online.preview) {
            return { ok: false, message: '当前不是预览书籍' };
        }
        const res = await addOnlineBook({
            sourceId: novel.online.sourceId,
            sourceName: novel.online.sourceName,
            title: novel.bookTitle,
            author: novel.author,
            bookUrl: novel.online.bookUrl,
            wordCount: novel.totalWords,
        });
        if (!res.ok) { return res; }
        await shelf.upsert({
            filePath: novel.filePath,
            title: novel.bookTitle,
            author: novel.author,
            totalChapters: novel.chapters.length,
            online: {
                sourceId: novel.online.sourceId,
                sourceName: novel.online.sourceName,
                bookUrl: novel.online.bookUrl,
                tocUrl: novel.online.tocUrl,
            },
        });
        novel.online.preview = false;
        refreshShelfView();
        return { ok: true };
    }

    /** 阅读面板: 在线章按需加载 */
    ReaderPanel.onlineChapterLoader = async function (novel: Novel, index: number): Promise<string[]> {
        const ref = refForNovel(novel);
        const chapter = novel.chapters[index];
        if (!ref || !chapter || !chapter.url) { throw new Error('在线章节信息缺失'); }
        return onlineChapterParagraphs(ref, index, chapter.url);
    };
    /** 窗口恢复: 用缓存/重新抓取重建在线书 */
    ReaderPanel.onlineRestore = async function (filePath: string): Promise<Novel | null> {
        try {
            const entry = shelf.get(filePath);
            if (!entry?.online) { return null; }
            const novel = await buildOnlineNovel(filePath);
            const index = entry.chapterIndex >= 0
                ? Math.min(entry.chapterIndex, novel.chapters.length - 1)
                : 0;
            const chapter = novel.chapters[index];
            if (chapter?.url) {
                try {
                    const paragraphs = await onlineChapterParagraphs(entry.online, index, chapter.url);
                    chapter.content = paragraphs.join('\n');
                    chapter.wordCount = chapter.content.length;
                } catch { /* 恢复后重试 */ }
            }
            return novel;
        } catch {
            return null;
        }
    };

        /**
 * 没书时也把阅读面板打开(正文显示引导文案)。
 *
 * 为什么不是弹一句"书架里还没有小说": 书源搜索、笔记、阅读设置这些入口
 * 全都在面板内部, 弹窗+return 等于把用户挡在门外, 连搜书都没地方点。
 *
 * @param tab 指定的抽屉页签(打开面板后切过去), 由 openDrawerAt 传入
 */
function openEmptyReader(tab?: DrawerTab): void {
    // 同步路径: 取号紧跟 createOrShow, 让还在飞的"慢打开"作废
    nextOpenIntent();
    ReaderPanel.createOrShow(createEmptyNovel(shelfItems().length === 0), 0, 0, store);
    refreshShelfView();
    syncLibraryToView();
    if (tab) {
        ReaderPanel.openDrawer(tab);
    }
}

    // ---------------------------------------------------------------- 命令

        /** 活动栏图标动作: 打开阅读面板(在读则续读, 否则给空态页) */
    async function openReaderFromLauncher(): Promise<void> {
        const novel = await ensureNovel();
        if (!novel) {
            openEmptyReader();
            return;
        }
        const entry = shelf.get(novel.filePath);
        const chapterIndex =
            ReaderPanel.current?.chapterIndex ??
            (entry && entry.chapterIndex >= 0 ? entry.chapterIndex : 0);
        const scrollRatio = ReaderPanel.current?.scrollRatio ?? (entry ? entry.scrollRatio : 0);
        nextOpenIntent();
        ReaderPanel.createOrShow(novel, chapterIndex, scrollRatio, store);
        refreshShelfView();
        syncLibraryToView();
    }

    // 抽屉入口(命令面板 / 快捷键): 打开阅读面板并切到对应页签
        async function openDrawerAt(tab: DrawerTab): Promise<void> {
            const novel = await ensureNovel();
            if (!novel) {
                // 没书也开面板: 抽屉(如书源搜索)本身没有书也能用
                openEmptyReader(tab);
                return;
            }
            const entry = shelf.get(novel.filePath);
            const chapterIndex =
                ReaderPanel.current?.chapterIndex ??
                (entry && entry.chapterIndex >= 0 ? entry.chapterIndex : 0);
            const scrollRatio = ReaderPanel.current?.scrollRatio ?? (entry ? entry.scrollRatio : 0);
            nextOpenIntent();
            ReaderPanel.createOrShow(novel, chapterIndex, scrollRatio, store);
            refreshShelfView();
            syncLibraryToView();
            ReaderPanel.openDrawer(tab);
        }

    // ---------------------------------------------------------------- 网络书源(可选功能)

    const sourcesFile = path.join(context.globalStorageUri.fsPath, 'book-sources.json');
    const bookSources = new BookSourceStore({
        read: async () => {
            try { return await fs.promises.readFile(sourcesFile, 'utf8'); } catch { return null; }
        },
        write: async (text: string) => {
            await fs.promises.mkdir(path.dirname(sourcesFile), { recursive: true });
            await fs.promises.writeFile(sourcesFile, text, 'utf8');
        },
    });
    const sourcePool = new SourceHttpPool();
    const searchService = new SearchService(bookSources, sourcePool);
    const onlineCache = new OnlineCache(path.join(context.globalStorageUri.fsPath, 'online-cache'));
    /** 目录缓存有效期: 6 小时; 过期后重新抓, 失败则回退旧缓存 */
    const TOC_TTL = 6 * 60 * 60 * 1000;
    // 书源改存文件(合集可达数千条); 首次启动把旧版 globalState 数据迁移过来
    void bookSources.load().then(async () => {
        const legacy = context.globalState.get(LEGACY_BOOK_SOURCES_KEY);
        if (legacy) {
            const moved = await bookSources.migrateLegacy(legacy);
            if (moved > 0) {
                await context.globalState.update(LEGACY_BOOK_SOURCES_KEY, undefined);
                ReaderPanel.current?.postSources();
            }
        }
    });

    /**
     * 书源文本解码: **UTF-8 优先**。
     * 合集 JSON 里本身就可能有少量 \uFFFD(源站数据坏字符), 用 decodeBuffer 的
     * "发现替换字符就回退 GB18030" 会导致整表乱码 —— 这里以"能否解析出书源"为准。
     */
    function decodeSourceBytes(buf: Buffer): string {
        const utf8 = new TextDecoder('utf-8').decode(buf);
        if (utf8.indexOf('\uFFFD') < 0) { return utf8; }
        if (parseSourceText(utf8).raws.length > 0) { return utf8; }
        const gb = new TextDecoder('gb18030').decode(buf);
        return parseSourceText(gb).raws.length > 0 ? gb : utf8;
    }

    /** 导入交互: URL / 剪贴板 / 本地文件 -> 存库 -> 刷新面板 */
    async function importSourcesInteractive(mode: 'url' | 'clipboard' | 'file'): Promise<void> {
        let text = '';
        if (mode === 'url') {
            const url = await vscode.window.showInputBox({
                title: '从 URL 导入书源',
                prompt: '粘贴 legado 书源 JSON 地址(例如 Yiove 书源合集导入链接)',
                placeHolder: 'https://shuyuan-api.yiove.com/import/book-source-collection/…',
                ignoreFocusOut: true,
            });
            if (!url) { return; }
            try {
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 r-novel-reader' } });
                if (!res.ok) { throw new Error('HTTP ' + res.status); }
                text = decodeSourceBytes(Buffer.from(await res.arrayBuffer()));
            } catch (err) {
                void vscode.window.showErrorMessage('下载书源失败: ' + (err instanceof Error ? err.message : String(err)));
                return;
            }
        } else if (mode === 'clipboard') {
            text = await vscode.env.clipboard.readText();
            if (!text.trim()) {
                void vscode.window.showWarningMessage('剪贴板里没有内容');
                return;
            }
        } else {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                title: '选择书源文件',
                filters: { '书源 JSON (*.json;*.txt)': ['json', 'txt'], '所有文件': ['*'] },
            });
            if (!picked || !picked[0]) { return; }
            try {
                text = decodeSourceBytes(fs.readFileSync(picked[0].fsPath));
            } catch (err) {
                void vscode.window.showErrorMessage('读取书源文件失败: ' + (err instanceof Error ? err.message : String(err)));
                return;
            }
        }
        const result = await bookSources.importText(text);
        ReaderPanel.current?.postSources();
        const summary = '书源导入完成: 新增 ' + result.added + ' 条, 更新 ' + result.updated + ' 条, 跳过 ' + result.skipped + ' 条';
        if (result.errors.length) {
            void vscode.window.showWarningMessage(summary + ' (' + result.errors.join('; ') + ')');
        } else {
            void vscode.window.showInformationMessage(summary);
        }
    }

    type CheckScope = 'active' | 'dead' | 'all';
    /** 正在跑的批量检查: 按 scope 分开(书源 Tab / 失效 Tab 互不影响) */
    const activeChecks = new Map<string, { control: SearchControl; runId?: number }>();
    /** 书源可用性检查: 用测试关键词搜一次, 看是否出结果(结果批量落盘) */
    async function checkBookSources(arg?: string | { id?: string; scope?: CheckScope; runId?: number }): Promise<void> {
        const id = typeof arg === 'string' ? arg : arg?.id;
        const scope: CheckScope = (typeof arg === 'object' && arg?.scope) || 'active';
        const runId = typeof arg === 'object' ? arg?.runId : undefined;
        let targets: BookSource[];
        if (id) {
            const one = bookSources.get(id);
            targets = one ? [one] : [];
        } else if (scope === 'dead') {
            targets = bookSources.deadList();
        } else if (scope === 'all') {
            targets = bookSources.list();
        } else {
            // 检查全部 = 所有已启用且未失效的源, 不再截断
            targets = bookSources.searchable();
        }
        if (!targets.length) {
            void vscode.window.showInformationMessage('没有可检查的书源');
            return;
        }

        // 新一轮检查开始: 取消上一轮(暂停中的也释放)
        const runKey = id ? 'single:' + id : scope;
        const previous = activeChecks.get(runKey);
        previous?.control.cancel();
        const control = new SearchControl();
        activeChecks.set(runKey, { control, runId });

        const results: { id: string; ok: boolean; message: string }[] = [];
        const postProgress = (done: number, sourceName: string): void => {
            ReaderPanel.current?.postSourceCheckProgress({
                scope: id ? 'single' : scope,
                done,
                total: targets.length,
                sourceName,
                paused: control.paused,
                runId,
            });
        };
        postProgress(0, targets[0].bookSourceName);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '检查书源可用性', cancellable: false },
            async (progress) => {
                for (let i = 0; i < targets.length; i++) {
                    if (control.cancelled) { break; }
                    // 暂停: 不再发起下一个, 在途的会完成
                    if (control.paused) { await control.waitIfPaused(); }
                    if (control.cancelled) { break; }
                    const source = targets[i];
                    progress.report({ message: source.bookSourceName, increment: 100 / targets.length });
                    try {
                        const req = await buildSearchRequest(source, '我的', 1, sandboxHttpFor(source, sourcePool));
                        const res = await fetchForSource(source, sourcePool, req.url, {
                            method: req.method,
                            headers: req.headers,
                            body: req.body,
                            timeoutMs: 12000,
                        });
                        const items = await parseSearchPage(source, res.text, res.url, sandboxHttpFor(source, sourcePool));
                        results.push({ id: source.id, ok: true, message: items.length ? '命中 ' + items.length + ' 条' : '可请求, 但未命中结果' });
                    } catch (err) {
                        results.push({ id: source.id, ok: false, message: err instanceof Error ? err.message : String(err) });
                    }
                    if (control.cancelled) { break; }
                    postProgress(results.length, source.bookSourceName);
                }
            }
        );

        const stillMine = activeChecks.get(runKey);
        if (stillMine && stillMine.control === control) { activeChecks.delete(runKey); }
        ReaderPanel.current?.postSourceCheckDone(id ? 'single' : scope, runId);
        // 一次写盘: 失败一次即判失效, 成功则清零/自动恢复
        if (results.length) { await bookSources.recordResults(results); }
        ReaderPanel.current?.postSources();
    }

    ReaderPanel.bookSources = {
        list: () => bookSources.list().map(toSourceView),
        importText: (text) => bookSources.importText(text),
        remove: (id) => bookSources.remove(id),
        removeMany: (ids) => bookSources.removeMany(ids),
        setEnabled: (id, enabled) => bookSources.setEnabled(id, enabled),
        update: async (id, patch) => {
            const current = bookSources.get(id);
            if (!current) { return undefined; }
            const next = {
                ...current,
                bookSourceName: patch.name === undefined ? current.bookSourceName : patch.name,
                searchUrl: patch.searchUrl === undefined ? current.searchUrl : patch.searchUrl,
            };
            await bookSources.upsert(next);
            return toSourceView(next);
        },
        addOnlineBook: (item) => addOnlineBook(item),
        previewOnlineBook: (item) => previewOnlineBook(item),
        savePreview: () => savePreview(),
        exportText: () => bookSources.exportText(),
        revive: (id) => bookSources.revive(id),
        reviveMany: (ids) => bookSources.reviveMany(ids),
        clearDead: () => bookSources.clearDead(),
        deadCount: () => bookSources.deadList().length,
        setEnabledMany: (patches) => bookSources.setEnabledMany(patches),
        pauseCheck: (scope, paused, runId) => {
            const entry = activeChecks.get(scope);
            if (!entry) { return; }
            // 过期轮次的暂停/继续请求直接忽略
            if (runId !== undefined && entry.runId !== runId) { return; }
            if (paused) { entry.control.pause(); } else { entry.control.resume(); }
        },
        cancelCheck: (scope, runId) => {
            const entry = activeChecks.get(scope);
            if (!entry) { return; }
            if (runId !== undefined && entry.runId !== runId) { return; }
            entry.control.cancel();
        },
        search: (key, sourceIds, hooks) => searchService.search(key, { sourceIds, ...(hooks || {}) }).then((out) => {
            // 失效/恢复有变化时立刻刷新列表(避免用户还要手动刷新)
            if (out.recorded > 0) { ReaderPanel.current?.postSources(); }
            return {
                items: out.items,
                errors: out.errors,
                skippedSources: out.skippedSources,
                deadAdded: out.deadAdded,
            };
        }),
        importInteractive: importSourcesInteractive,
    };

    // 离线下载/缓存: 面板只做转发, 编排都在这里(下载队列挂在 activate 作用域, 关面板不停)
    ReaderPanel.offlineView = (filePath: string) => offlineViewOf(filePath);

    /**
     * 目录里每章的标记: 临时读缓存(读过就存) + 已读章节。
     * 与主动下载的 downloaded 一起, 让用户一眼看出「哪些章没网也能读」。
     */
    ReaderPanel.chapterMarks = async function (novel: Novel): Promise<ChapterMarksView | null> {
        const ref = refForNovel(novel);
        if (!ref) { return null; }
        const key = onlineKey(ref.sourceId, ref.bookUrl);
        const cached = await onlineCache.listChapters(key);
        const entry = shelf.get(novel.filePath);
        const read: number[] = [];
        const ratios = entry?.chapterRatios;
        if (ratios) {
            for (const raw of Object.keys(ratios)) {
                const n = Number(raw);
                if (Number.isInteger(n) && n >= 0) { read.push(n); }
            }
            read.sort(function (a, b) { return a - b; });
        }
        return {
            cached,
            read,
            // 与状态栏「读至第 N 章」同一口径; -1 = 还没开始
            readUpTo: entry && entry.chapterIndex >= 0 ? entry.chapterIndex : -1,
        };
    };

    /**
     * 下载任务表（webview 任务表用）。
     *
     * 两条来源合并、按 `filePath`(= 下载 key) 去重：
     *  1. 运行中的任务（`downloadService.snapshot()`，带真实书名）；
     *  2. 离线索引里已存在的书（running=false，只作为"查看/清理"入口）。
     * 这是**全局**视图，与"当前打开哪本书"无关（R9-06）。
     */
    function buildDownloadTasks(): DownloadTaskView[] {
        const now = Date.now();
        const out = new Map<string, DownloadTaskView>();
        for (const s of downloadService.snapshot()) {
            out.set(s.key, {
                filePath: s.key,
                bookTitle: s.bookTitle || shelf.get(s.key)?.title || s.key,
                done: s.done,
                total: s.total,
                failed: s.failed,
                running: true,
                paused: s.paused,
                updatedAt: now,
            });
        }
        offlineIndex.forEach(function (view, key) {
            if (out.has(key)) { return; }
            out.set(key, {
                filePath: key,
                bookTitle: shelf.get(key)?.title || key,
                done: view.done,
                total: view.total,
                failed: view.failed,
                running: false,
                paused: false,
                updatedAt: now,
            });
        });
        return Array.from(out.values());
    }

    ReaderPanel.offline = {
        stats: () => ({ ...offlineGlobalStats }),
        status: () => {
            const key = currentOfflineKey();
            return key ? offlineViewOf(key) : undefined;
        },
        start: (range, filePath) => startOfflineDownload(range, filePath),
        // 三个控制动作都按显式 key: 用户可以在 B 书的页面上暂停 A 的下载
        pause: (key) => {
            const k = key || currentOfflineKey();
            return k ? downloadService.pause(k) : false;
        },
        resume: (key) => {
            const k = key || currentOfflineKey();
            return k ? downloadService.resume(k) : false;
        },
        cancel: (key) => {
            const k = key || currentOfflineKey();
            if (k) { downloadService.cancel(k); }
        },
        exportTxt: () => exportCurrentOfflineTxt(),
        clearCurrent: async (key) => {
            const k = key || currentOfflineKey();
            if (!k) { return; }
            downloadService.cancel(k);
            await offlineStore.remove(k);
            await refreshOfflineIndex();
            refreshShelfView();
            pushOfflineStatus();
        },
        clearAll: async () => {
            const total = offlineGlobalStats.books;
            if (!total) {
                void vscode.window.showInformationMessage('还没有离线下载内容。');
                return;
            }
            const pick = await vscode.window.showWarningMessage(
                `删除全部 ${total} 本书的离线内容？该操作不可恢复（已导出的本地 txt 不受影响）。`,
                { modal: true },
                '删除'
            );
            if (pick !== '删除') { return; }
            downloadService.cancelAll();
            await offlineStore.removeAll();
            await refreshOfflineIndex();
            refreshShelfView();
            pushOfflineStatus();
        },
        tasks: () => buildDownloadTasks(),
    };

    // 面板关闭时停掉批量检查, 避免后台挂着
    ReaderPanel.cancelSourceCheck = () => {
        for (const entry of activeChecks.values()) { entry.control.cancel(); }
        activeChecks.clear();
    };

    // ---------------------------------------------------------- 书架移除(单本/批量)

    interface RemoveTarget {
        filePath: string;
        name: string;
        online: boolean;
        /** 文件就在书库目录里 -> 移除时一并丢进回收站 */
        willTrash: boolean;
        onlineRef?: OnlineRef;
        offlineKey?: string;
        offlineDone: number;
        /** 不删文件的原因(单本确认文案要写清楚) */
        whyNotTrash: string;
    }

    /** 解析一个移除目标: 只做判断, 不产生任何副作用 */
    function resolveRemoveTarget(filePath: string): RemoveTarget {
        const book = shelf.get(filePath);
        const libPath = getLibraryPath();
        const online = isOnlinePath(filePath);
        const inLibrary = !online && !!libPath && isInsideDir(filePath, libPath);
        const fileExists = !online && fs.existsSync(filePath);
        const offlineKey = online && book?.online
            ? onlineKey(book.online.sourceId, book.online.bookUrl)
            : undefined;
        const view = offlineKey ? offlineIndex.get(offlineKey) : undefined;
        const whyNotTrash = online
            ? '在线书没有本地文件'
            : !libPath
                ? '未设置书库目录'
                : !inLibrary
                    ? '该书文件不在书库目录内'
                    : '文件不存在';
        return {
            filePath,
            name: book?.title || path.basename(filePath),
            online,
            willTrash: inLibrary && fileExists,
            onlineRef: book?.online,
            offlineKey,
            offlineDone: view ? view.done : 0,
            whyNotTrash,
        };
    }

    /**
     * 真正执行移除。逐个处理, 单个失败不影响其它:
     * 文件没删成的书**保留书架记录**(否则会出现"文件还在但书架里找不到")。
     */
    async function applyRemoveTargets(
        targets: RemoveTarget[],
        deleteOffline: boolean
    ): Promise<{ removed: number; trashed: number; failures: { name: string; message: string }[] }> {
        let removed = 0;
        let trashed = 0;
        let offlineRemoved = false;
        const failures: { name: string; message: string }[] = [];
        for (const t of targets) {
            if (t.willTrash) {
                try {
                    await moveToTrash(t.filePath);
                    trashed += 1;
                } catch (err) {
                    failures.push({ name: t.name, message: err instanceof Error ? err.message : String(err) });
                    continue;
                }
            }
            await shelf.remove(t.filePath);
            // 临时读缓存始终清掉(重读会重新抓); 离线下载区按用户选择处理
            if (t.online) { await onlineCache.clear(t.filePath); }
            if (deleteOffline && t.offlineKey && t.offlineDone > 0) {
                downloadService.cancel(t.offlineKey);
                await offlineStore.remove(t.offlineKey);
                offlineRemoved = true;
            }
            // 当前正在读的就是这本: 退回预览态, 正文里的「+ 加入书架」重新出现
            if (t.online) { ReaderPanel.resetToPreview(t.filePath, t.onlineRef); }
            removed += 1;
        }
        if (offlineRemoved) { await refreshOfflineIndex(); }
        if (removed) { refreshShelfView(); }
        return { removed, trashed, failures };
    }

    /** 有离线内容时统一问一次「保留 / 一并删除」; 返回 null = 用户取消 */
    async function askKeepOffline(
        targets: RemoveTarget[]
    ): Promise<boolean | null> {
        const withOffline = targets.filter(function (t) { return t.offlineDone > 0; });
        if (!withOffline.length) { return true; }
        const chapters = withOffline.reduce(function (s, t) { return s + t.offlineDone; }, 0);
        const head = withOffline.length === 1
            ? `「${withOffline[0].name}」已离线下载 ${withOffline[0].offlineDone} 章。移除后要保留离线内容吗？`
            : `其中 ${withOffline.length} 本已离线下载（共 ${chapters} 章）。移除后要保留离线内容吗？`;
        const choice = await vscode.window.showWarningMessage(
            head + '\n保留后重新加入书架仍可离线阅读；导出过的本地 txt 不受影响。',
            { modal: true },
            '保留离线内容',
            '一并删除'
        );
        if (!choice) { return null; }
        return choice !== '一并删除';
    }

    /**
     * 移除类命令的参数归一化。
     *
     * 双形态兼容（架构文档 §3.2 / D5）：
     *  - 旧：`string`（单本）或 `string[]`（批量）—— 命令面板与其它内部调用仍走这两式；
     *  - 新：`{ filePaths, skipConfirm?, keepOffline?, opId? }` —— 来自 webview，
     *    因为 webview 已用 ConfirmDialog 确认过，宿主要跳过 `showWarningMessage`。
     */
    type RemoveArg =
        | string
        | string[]
        | {
            filePaths?: string[];
            filePath?: string;
            skipConfirm?: boolean;
            keepOffline?: boolean;
            opId?: string;
        };

    interface RemoveNorm {
        filePaths: string[];
        skipConfirm: boolean;
        /** 仅 skipConfirm 路径使用：显式保留/删除离线内容 */
        keepOffline?: boolean;
    }

    function normalizeRemoveArg(arg: RemoveArg | undefined): RemoveNorm {
        if (typeof arg === 'string') {
            return { filePaths: arg ? [arg] : [], skipConfirm: false };
        }
        if (Array.isArray(arg)) {
            return { filePaths: arg.filter(function (p) { return typeof p === 'string' && !!p; }), skipConfirm: false };
        }
        if (arg && typeof arg === 'object') {
            const list = Array.isArray(arg.filePaths)
                ? arg.filePaths
                : (arg.filePath ? [arg.filePath] : []);
            return {
                filePaths: list.filter(function (p) { return typeof p === 'string' && !!p; }),
                skipConfirm: arg.skipConfirm === true,
                keepOffline: arg.keepOffline,
            };
        }
        return { filePaths: [], skipConfirm: false };
    }


    // ---------------------------------------------------------- 刷新书架(预演/执行)

    /** 预演编号: 每次预演 +1, 执行时必须与之匹配（过期即拒绝） */
    let refreshPlanSeq = 0;
    /** 最近一次预演计划（执行阶段唯一真相源） */
    let lastRefreshPlan: ShelfRefreshPlan | undefined;
    /** 最近一次执行结果（命令面板入口要拿它拼提示文案） */
    let lastRefreshResult: ShelfRefreshResult | undefined;

    /** access() 错误码 -> 预演用的探测码。只有 ENOENT 会被当作"文件真的没了" */
    const PROBE_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE'];

    function probeFile(target: string): Promise<ProbeCode> {
        return new Promise(function (resolve) {
            fs.access(target, fs.constants.F_OK, function (err) {
                if (!err) { resolve(null); return; }
                const code = (err as NodeJS.ErrnoException).code || '';
                resolve((PROBE_CODES.indexOf(code) >= 0 ? code : 'UNKNOWN') as ProbeCode);
            });
        });
    }

    /** 预演用的 fs 适配器(注入式, 便于 src/shelfRefresh.ts 保持零 vscode 依赖) */
    const shelfPlanFs: FsProbe = {
        readdir: (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
        readFile: (target) => fs.promises.readFile(target),
        probe: (target) => probeFile(target),
        exists: (target) => fs.existsSync(target),
    };

    /** 组装预演入参 */
    function makePlanInput(planId: number): PlanInput {
        return {
            dir: getLibraryPath(),
            shelf: shelf.list().map(function (b) {
                return {
                    filePath: b.filePath,
                    title: b.title,
                    author: b.author,
                    totalChapters: b.totalChapters,
                    chapterIndex: b.chapterIndex,
                    addedAt: b.addedAt,
                };
            }),
            fs: shelfPlanFs,
            isInsideDir,
            decode: decodeBuffer,
            parse: function (text, filePath, enc) {
                const novel = parseNovel(text, filePath, enc);
                return { bookTitle: novel.bookTitle, author: novel.author, chapters: novel.chapters };
            },
            deriveTitleAuthor,
            planId,
        };
    }

    /** 第一步: 预演。只读盘, 不写任何东西 */
    async function refreshShelfPlan(): Promise<{ ok: boolean; message?: string }> {
        const dir = getLibraryPath();
        if (!dir) {
            const message = '未设置书库目录：请先在「存储位置」里选择书库目录。';
            void vscode.window.showInformationMessage(message);
            return { ok: false, message };
        }
        if (!fs.existsSync(dir)) {
            const message = '书库目录不存在：' + dir;
            void vscode.window.showWarningMessage(message);
            return { ok: false, message };
        }
        refreshPlanSeq += 1;
        const plan = await planShelfRefresh(makePlanInput(refreshPlanSeq));
        lastRefreshPlan = plan;
        lastRefreshResult = undefined;
        ReaderPanel.current?.postShelfRefreshPlan(plan);
        return { ok: true };
    }

    /**
     * 第二步: 按预演结果执行。
     * @param planId 用户确认时带回来的编号; 与最近一次预演不一致 = 已过期, 拒绝执行
     */
    async function refreshShelfApply(planId?: number): Promise<{ ok: boolean; message?: string }> {
        const plan = lastRefreshPlan;
        if (!plan) {
            return { ok: false, message: '预演已过期，请重新预演' };
        }
        if (typeof planId === 'number' && planId !== plan.planId) {
            return { ok: false, message: '文件已变化，请重新预演' };
        }
        // 计划一次性: 执行后作废, 避免重复点「执行」把同一份 plan 应用两遍
        lastRefreshPlan = undefined;
        const result = await applyShelfRefresh(plan, {
            list: () => shelf.list(),
            upsert: async function (b) { await shelf.upsert(b); },
            remove: async function (target) { await shelf.remove(target); },
        });
        lastRefreshResult = result;
        refreshShelfView();
        ReaderPanel.current?.postShelfRefreshResult(result);
        if (result.failed.length > 0) {
            return { ok: false, message: result.driftNote || '部分条目未能刷新' };
        }
        return { ok: true };
    }

    /**
     * 打开书源面板。
     *
     * 空书架**不再**用提示弹窗把人挡在门外: 书源搜索、笔记、阅读设置都在面板内部,
     * 弹一句"请先打开一本书"等于让用户无路可走。改为直接开空阅读页并切到书源抽屉
     * (R6-01), 搜索到书后预览/加入书架都在同一个面板里完成。
     */
    async function showSourcesPanel(): Promise<void> {
        const novel = await ensureNovel();
        if (!novel) {
            openEmptyReader('source');
            return;
        }
        await openDrawerAt('source');
    }

    // 打开/添加小说文件的共用实现(openFile 与标题栏「添加书籍」按钮同一行为)
    async function openNovelFile(arg?: vscode.Uri): Promise<void> {
        // 资源管理器右键 .txt 文件: 只加入书架, 不自动打开阅读面板
        if (arg && arg.fsPath) {
            await loadNovel(arg.fsPath, { openPanel: false });
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            title: '选择小说文件',
            filters: { '小说文本 (*.txt)': ['txt'], '所有文件': ['*'] },
        });
        if (picked && picked[0]) {
            // 只添加进书架: 阅读面板由用户点书名时再打开
            await loadNovel(picked[0].fsPath, { openPanel: false });
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('novelReader.openFile', openNovelFile),
        vscode.commands.registerCommand('novelReader.showSources', showSourcesPanel),
        vscode.commands.registerCommand('novelReader.importSourceFromUrl', () => importSourcesInteractive('url')),
        vscode.commands.registerCommand('novelReader.importSourceFromClipboard', () => importSourcesInteractive('clipboard')),
        vscode.commands.registerCommand('novelReader.importSourceFromFile', () => importSourcesInteractive('file')),
        vscode.commands.registerCommand('novelReader.checkSources', (arg?: string | { id?: string; scope?: 'active' | 'dead' | 'all'; runId?: number }) => checkBookSources(arg)),
        vscode.commands.registerCommand('novelReader.exportSources', async () => {
            const picked = await vscode.window.showSaveDialog({
                title: '导出书源',
                filters: { '书源 JSON': ['json'] },
                saveLabel: '导出',
            });
            if (!picked) { return; }
            try {
                fs.writeFileSync(picked.fsPath, bookSources.exportText(), 'utf8');
                void vscode.window.showInformationMessage('书源已导出: ' + path.basename(picked.fsPath));
            } catch (err) {
                void vscode.window.showErrorMessage('导出失败: ' + (err instanceof Error ? err.message : String(err)));
            }
        }),

        // 书架: 打开某本书(自动延续该书上次的阅读进度)
        vscode.commands.registerCommand('novelReader.openBook', async (filePath: string) => {
            if (!filePath) {
                return;
            }
            // 在线书没有本地文件, 直接按 online:// 打开
            if (isOnlinePath(filePath)) {
                // 已从书架移除但历史还留着: 用历史里的书源信息按"预览"重开,
                // 否则这条历史就是个点不开的死链
                if (!shelf.get(filePath)) {
                    const h = history.find(filePath);
                    if (h && h.sourceId && h.bookUrl) {
                        await previewOnlineBook({
                            sourceId: h.sourceId,
                            sourceName: h.sourceName || '',
                            title: h.title,
                            author: h.author,
                            bookUrl: h.bookUrl,
                            chapterIndex: h.chapterIndex,
                        });
                        return;
                    }
                    void vscode.window.showInformationMessage('这本书已不在书架，且缺少书源信息，无法重新打开。');
                    return;
                }
                await loadNovel(filePath, { openPanel: true });
                return;
            }
            // 文件被移动/改名/删除: 提供重新定位(保留进度)或移除
            if (!fs.existsSync(filePath)) {
                const book = shelf.get(filePath);
                const name = book?.title || path.basename(filePath);
                const picked = await vscode.window.showWarningMessage(
                    `「${name}」的文件已不在原位置，可能被移动或改名了。`,
                    { modal: true },
                    '重新选择文件',
                    '从书架移除'
                );
                if (picked === '从书架移除') {
                    await shelf.remove(filePath);
                    refreshShelfView();
                    return;
                }
                if (picked !== '重新选择文件') {
                    return;
                }
                const sel = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectMany: false,
                    title: `为「${name}」重新选择文件`,
                    filters: { '小说文本 (*.txt)': ['txt'], '所有文件': ['*'] },
                });
                if (!sel || !sel[0]) {
                    return;
                }
                const novel = await loadNovel(sel[0].fsPath, {
                    openPanel: false,
                    silent: true,
                });
                if (!novel) {
                    return;
                }
                await shelf.relink(filePath, novel.filePath, {
                    title: novel.bookTitle,
                    author: novel.author,
                    totalChapters: novel.chapters.length,
                });
                // 笔记跟着走, 否则重选文件后旧分组会变成孤儿
                await notes.relink(filePath, novel.filePath, novel.bookTitle);
                ReaderPanel.current?.postNotes();
                refreshShelfView();
                await loadNovel(novel.filePath, { openPanel: true });
                return;
            }
            await loadNovel(filePath, { openPanel: true });
        }),

        // 书架: 移除某本书(二次确认)
        //  - 设置了书库目录且文件就在书库内 -> 确认后把文件移入系统回收站
        //  - 其它情况(未设置书库目录 / 文件在书库外) -> 只移除书架记录, 不动文件
        vscode.commands.registerCommand('novelReader.removeFromShelf', async (arg: RemoveArg): Promise<{ ok: boolean; message?: string }> => {
            const norm = normalizeRemoveArg(arg);
            const filePath = norm.filePaths[0];
            if (!filePath) {
                return { ok: false, message: '没有指定要移除的书' };
            }
            const target = resolveRemoveTarget(filePath);
            // 未删除文件时说明原因, 避免"设了书库目录却提示不删文件"的困惑
            const confirmText = target.willTrash
                ? `从书架移除「${target.name}」并把文件移入回收站？\n文件：${filePath}`
                : `从书架移除「${target.name}」？仅移除书架记录，不删除文件。\n原因：${target.whyNotTrash}\n文件：${filePath}`;
            // skipConfirm: webview 已用自己的确认框确认过, 这里不能再弹宿主模态框
            if (!norm.skipConfirm) {
                // 注意: modal 对话框会自动带「取消」, 这里只传确认按钮, 否则出现两个取消
                const picked = await vscode.window.showWarningMessage(confirmText, { modal: true }, '移除');
                if (picked !== '移除') {
                    return { ok: false, message: '已取消' };
                }
            }

            // 离线内容保留/删除: 跳过确认时取显式 keepOffline, 缺省**保留**
            // (用户刚确认的只是"移除书架", 没说删离线内容 —— 最小惊讶)
            let keepOffline: boolean;
            if (norm.skipConfirm) {
                keepOffline = norm.keepOffline !== false;
            } else {
                const asked = await askKeepOffline([target]);
                if (asked === null) { return { ok: false, message: '已取消' }; }
                keepOffline = asked;
            }

            const res = await applyRemoveTargets([target], !keepOffline);
            if (res.failures.length) {
                // 移入回收站失败: 记录未动, 文件也没丢
                const message = `移入回收站失败，已取消删除: ${res.failures[0].message}`;
                void vscode.window.showErrorMessage(message);
                return { ok: false, message };
            }
            vscode.window.setStatusBarMessage(
                target.willTrash
                    ? `已移除「${target.name}」并移入回收站`
                    : target.offlineDone > 0
                        ? `已从书架移除「${target.name}」${keepOffline ? '（离线内容已保留）' : '（离线内容已删除）'}`
                        : `已从书架移除「${target.name}」`,
                3000
            );
            return { ok: true };
        }),

        // 书架: 批量移除(一次确认 + 一次离线内容选择, 不再逐本弹窗)
        vscode.commands.registerCommand('novelReader.removeBooksFromShelf', async (arg: RemoveArg): Promise<{ ok: boolean; message?: string }> => {
            const norm = normalizeRemoveArg(arg);
            const paths = Array.from(new Set(norm.filePaths));
            if (!paths.length) { return { ok: false, message: '没有选中要移除的书' }; }
            const targets = paths.map(resolveRemoveTarget);
            const trashCount = targets.filter(function (t) { return t.willTrash; }).length;
            const head = targets.length === 1
                ? `从书架移除「${targets[0].name}」？`
                : `从书架移除 ${targets.length} 本？`;
            const detail = trashCount > 0
                ? `其中 ${trashCount} 个文件会移入回收站。`
                : '仅移除书架记录，不删除文件。';
            if (!norm.skipConfirm) {
                const picked = await vscode.window.showWarningMessage(`${head}\n${detail}`, { modal: true }, '移除');
                if (picked !== '移除') { return { ok: false, message: '已取消' }; }
            }

            let keepOffline: boolean;
            if (norm.skipConfirm) {
                keepOffline = norm.keepOffline !== false;
            } else {
                const asked = await askKeepOffline(targets);
                if (asked === null) { return { ok: false, message: '已取消' }; }
                keepOffline = asked;
            }

            const res = await applyRemoveTargets(targets, !keepOffline);
            const bits = [`已从书架移除 ${res.removed} 本`];
            if (res.trashed > 0) { bits.push(`${res.trashed} 个文件已移入回收站`); }
            if (targets.some(function (t) { return t.offlineDone > 0; })) {
                bits.push(keepOffline ? '离线内容已保留' : '离线内容已删除');
            }
            vscode.window.setStatusBarMessage(bits.join('，'), 4000);
            if (res.failures.length) {
                const message = `有 ${res.failures.length} 本未能移除（书架记录已保留）：` +
                    res.failures.slice(0, 6).map(function (f) { return `「${f.name}」${f.message}`; }).join('；');
                void vscode.window.showWarningMessage(message);
                // 部分成功也算失败: webview 保留选择, 用户可以只重试失败的那几本
                return { ok: false, message };
            }
            return { ok: true };
        }),

        // 历史: 批量删除所选
        vscode.commands.registerCommand('novelReader.removeHistory', async (arg: RemoveArg): Promise<{ ok: boolean; message?: string }> => {
            const norm = normalizeRemoveArg(arg);
            const paths = Array.from(new Set(norm.filePaths));
            if (!paths.length) { return { ok: false, message: '没有选中要删除的历史记录' }; }
            if (!norm.skipConfirm) {
                const picked = await vscode.window.showWarningMessage(
                    `删除选中的 ${paths.length} 条阅读记录？\n只删记录，不影响书架、笔记与已下载的离线内容。`,
                    { modal: true },
                    '删除'
                );
                if (picked !== '删除') { return { ok: false, message: '已取消' }; }
            }
            const removed = history.removeMany(paths);
            if (removed > 0) {
                await history.flush();
                ReaderPanel.current?.postHistory();
            }
            vscode.window.setStatusBarMessage(`已删除 ${removed} 条历史记录`, 3000);
            return { ok: true };
        }),

        // 历史: 清空某一栏(本地 / 在线)
        vscode.commands.registerCommand(
            'novelReader.clearHistory',
            async (arg: 'local' | 'online' | { kind?: 'local' | 'online'; skipConfirm?: boolean; opId?: string }): Promise<{ ok: boolean; message?: string }> => {
                const isObj = !!arg && typeof arg === 'object';
                const rawKind = isObj ? (arg as { kind?: 'local' | 'online' }).kind : arg as 'local' | 'online';
                const skipConfirm = isObj ? (arg as { skipConfirm?: boolean }).skipConfirm === true : false;
                const k: 'local' | 'online' = rawKind === 'online' ? 'online' : 'local';
                const label = k === 'online' ? '在线' : '本地';
                const count = history.list()[k].length;
                if (!count) {
                    void vscode.window.showInformationMessage(`还没有${label}阅读记录。`);
                    return { ok: true };
                }
                if (!skipConfirm) {
                    const picked = await vscode.window.showWarningMessage(
                        `清空全部${label}阅读记录（${count} 条）？\n只删记录，不影响书架、笔记与已下载的离线内容。`,
                        { modal: true },
                        '清空'
                    );
                    if (picked !== '清空') { return { ok: false, message: '已取消' }; }
                }
                const removed = history.clearKind(k);
                await history.flush();
                ReaderPanel.current?.postHistory();
                vscode.window.setStatusBarMessage(`已清空 ${removed} 条${label}阅读记录`, 3000);
                return { ok: true };
            }
        ),

        // 书架: 按书库目录重新扫描 —— **两阶段**: 先预演(只读盘), 再按 planId 执行。
        // 命令面板入口保留旧语义 = 预演 + 立即执行（不弹 webview 确认框,
        // 因为命令面板本身就是一次显式确认）。
        vscode.commands.registerCommand('novelReader.refreshShelfFromLibrary', async (): Promise<{ ok: boolean; message?: string }> => {
            const planned = await refreshShelfPlan();
            if (!planned.ok) { return planned; }
            const scanned = lastRefreshPlan ? lastRefreshPlan.scanned : 0;
            const applied = await refreshShelfApply();
            if (!applied.ok) {
                void vscode.window.showWarningMessage(applied.message || '刷新书架未完成');
                return applied;
            }
            const r = lastRefreshResult;
            void vscode.window.showInformationMessage(
                `书架已刷新：新增 ${r ? r.added : 0} 本` +
                (r && r.skippedDup ? `，跳过重复副本 ${r.skippedDup} 个` : '') +
                (r && r.merged ? `，合并重复记录 ${r.merged} 条` : '') +
                (r && r.retitled ? `，修正书名 ${r.retitled} 条` : '') +
                (r && r.pruned ? `，清理失效记录 ${r.pruned} 条` : '') +
                `（书库内共 ${scanned} 个 txt）`
            );
            return applied;
        }),

        // 预演(webview「刷新书架」第一步): 只算不写, 结果走 shelfRefreshPlan 消息下发
        vscode.commands.registerCommand('novelReader.refreshShelfPlan', () => refreshShelfPlan()),
        // 执行(用户确认后): planId 不一致 = 预演已过期, 拒绝并回失败
        vscode.commands.registerCommand('novelReader.refreshShelfApply', (planId?: number) => refreshShelfApply(planId)),

        // 回到当前阅读的章节(阅读面板已关闭时会重新打开)
        vscode.commands.registerCommand('novelReader.resumeCurrent', async () => {
            const novel = await ensureNovel();
            if (!novel) {
                // 状态栏「小说阅读」在空书架时也要能进面板(正文给引导文案)
                openEmptyReader();
                return;
            }
            const entry = shelf.get(novel.filePath);
            // 续读落点: 面板还开着就用面板的实时位置; 否则用书架记录;
            // **从未读过(记录 chapterIndex<0)一律回第 1 章** —— 以前这里会退回
            // "最后一章", 新书点「小说阅读」直接跳到结尾, 是明确的入口缺陷(R6-04)。
            const live = ReaderPanel.current;
            const target = live
                ? live.chapterIndex
                : entry && entry.chapterIndex >= 0
                    ? entry.chapterIndex
                    : 0;
            const ratio = live ? live.scrollRatio : (entry ? entry.scrollRatio : 0);
            refreshShelfView();
            nextOpenIntent();
            ReaderPanel.createOrShow(novel, target, ratio, store);
        }),

        vscode.commands.registerCommand('novelReader.showBookshelf', () => void openDrawerAt('shelf')),
        vscode.commands.registerCommand('novelReader.showChapters', () => void openDrawerAt('catalog')),
        vscode.commands.registerCommand('novelReader.showSettings', () => void openDrawerAt('storage')),

        // 离线下载: 下载整本 / 导出本地 txt / 清理离线缓存
        vscode.commands.registerCommand('novelReader.downloadBook', async () => {
            const novel = await ensureNovel();
            if (!novel) {
                void vscode.window.showInformationMessage('请先打开一本在线书，再下载。');
                return;
            }
            if (!novel.online) {
                void vscode.window.showInformationMessage('这本书已经是本地文件，不需要下载。');
                return;
            }
            const res = await startOfflineDownload();
            if (!res.ok) {
                void vscode.window.showWarningMessage(res.message || '无法开始下载');
                return;
            }
            ReaderPanel.openDrawer('catalog');
        }),
        vscode.commands.registerCommand('novelReader.exportOfflineTxt', async () => {
            const novel = await ensureNovel();
            if (!novel || !novel.online) {
                void vscode.window.showInformationMessage('请先打开一本在线书。');
                return;
            }
            if (!ReaderPanel.current) { ReaderPanel.openDrawer('catalog'); }
            const res = await exportCurrentOfflineTxt();
            if (!res.ok) {
                void vscode.window.showWarningMessage(res.message || '导出失败');
            }
        }),
        vscode.commands.registerCommand('novelReader.clearOfflineCache', async () => {
            await ReaderPanel.offline?.clearAll();
        }),

        // 选择书库目录(导入时复制到这里)
        vscode.commands.registerCommand('novelReader.pickLibraryPath', async () => {
            const current = getLibraryPath();
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: '选为书库目录',
                title: '选择书库目录（之后导入的小说会复制到这里）',
                defaultUri: current && fs.existsSync(current) ? vscode.Uri.file(current) : undefined,
            });
            if (!picked || !picked[0]) {
                return;
            }
            const dir = picked[0].fsPath;
            try {
                await store.setLibraryPath(dir);
            } catch (err) {
                vscode.window.showErrorMessage(
                    `保存书库目录失败：${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }
            syncLibraryToView();
            if (ReaderPanel.current) { ReaderPanel.openDrawer('storage'); }
            vscode.window.showInformationMessage(`书库目录已设置为 ${dir}，之后导入的小说会复制到这里。`);
        }),

        // 取消书库目录(恢复读取原路径)
        vscode.commands.registerCommand('novelReader.clearLibraryPath', async () => {
            try {
                await store.setLibraryPath('');
            } catch (err) {
                vscode.window.showErrorMessage(
                    `保存设置失败：${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }
            syncLibraryToView();
            if (ReaderPanel.current) { ReaderPanel.openDrawer('storage'); }
            vscode.window.setStatusBarMessage('已取消书库目录：导入的小说将直接读取原路径', 4000);
        }),

        // 在系统文件管理器中打开书库目录
        vscode.commands.registerCommand('novelReader.openLibraryFolder', async () => {
            const dir = getLibraryPath();
            if (!dir) {
                vscode.window.showInformationMessage('尚未设置书库目录。');
                return;
            }
            if (!fs.existsSync(dir)) {
                vscode.window.showWarningMessage(`书库目录不存在：${dir}`);
                return;
            }
            await vscode.env.openExternal(vscode.Uri.file(dir));
        }),

        vscode.commands.registerCommand('novelReader.openChapter', async (index?: number) => {
            const novel = await ensureNovel();
            if (!novel) {
                const picked = await vscode.window.showInformationMessage(
                    '请先打开一本小说（书架里还没有）。',
                    '添加书籍'
                );
                if (picked === '添加书籍') {
                    await vscode.commands.executeCommand('novelReader.openFile');
                }
                return;
            }
            const idx = Math.min(Math.max(0, Number(index) || 0), novel.chapters.length - 1);
            ReaderPanel.createOrShow(novel, idx, 0, store);
        }),

        vscode.commands.registerCommand('novelReader.refresh', async () => {
            if (!currentNovel) {
                return;
            }
            const chapter = ReaderPanel.current?.chapterIndex ?? 0;
            const novel = await loadNovel(currentNovel.filePath, {
                chapterIndex: chapter,
                scrollRatio: 0,
                openPanel: false,
                silent: true,
            });
            if (novel) {
                ReaderPanel.createOrShow(novel, chapter, 0, store);
                vscode.window.setStatusBarMessage(`目录已刷新: 共 ${novel.chapters.length} 章`, 3000);
            }
        }),

        vscode.commands.registerCommand('novelReader.openSettings', async () => {
            const novel = await ensureNovel();
            if (!novel) {
                vscode.window.showInformationMessage('请先打开一本小说后再调整阅读设置。');
                return;
            }
            // 复用当前阅读位置: 传 0 会让正文回到章首(阅读面板已被打开时尤其明显)
            const entry = shelf.get(novel.filePath);
            const chapterIndex =
                ReaderPanel.current?.chapterIndex ??
                (entry && entry.chapterIndex >= 0 ? entry.chapterIndex : 0);
            const scrollRatio = ReaderPanel.current?.scrollRatio ?? (entry ? entry.scrollRatio : 0);
            ReaderPanel.createOrShow(
                novel,
                chapterIndex,
                scrollRatio,
                store,
                vscode.ViewColumn.One,
                true
            );
        }),

        vscode.commands.registerCommand('novelReader.prevChapter', () => {
            const panel = ReaderPanel.current;
            if (panel) {
                // 'prev' -> 停在上一章底部(接着往下读, 视觉连续)
                ReaderPanel.showChapter(panel.chapterIndex - 1, 'prev');
            }
        }),

        vscode.commands.registerCommand('novelReader.nextChapter', () => {
            const panel = ReaderPanel.current;
            if (panel) {
                // 'next' -> 回到新章顶部
                ReaderPanel.showChapter(panel.chapterIndex + 1, 'next');
            }
        }),

        // ---------------------------------------------------------------- 摸鱼模式
        // 小说伪装成代码注释, 用 VS Code 原生编辑器展示(不共用阅读 webview);
        // 老板键一键关闭所有摸鱼文档
        vscode.commands.registerCommand('novelReader.slackerStart', async () => {
            const novel = await ensureNovel();
            if (!novel) {
                const picked = await vscode.window.showInformationMessage(
                    '书架里还没有小说，先添加一本吧。',
                    '添加书籍'
                );
                if (picked === '添加书籍') {
                    await vscode.commands.executeCommand('novelReader.openFile');
                }
                return;
            }
            const entry = shelf.get(novel.filePath);
            const idx = entry && entry.chapterIndex >= 0 ? entry.chapterIndex : 0;
            await slacker.open(novel, idx);
        }),
        vscode.commands.registerCommand('novelReader.slackerNext', () => slacker.step(1)),
        vscode.commands.registerCommand('novelReader.slackerPrev', () => slacker.step(-1)),
        vscode.commands.registerCommand('novelReader.slackerLanguage', () => slacker.pickLanguage()),
        vscode.commands.registerCommand('novelReader.slackerCatalog', () => slacker.catalog()),
        vscode.commands.registerCommand('novelReader.slackerShelf', () => slacker.shelf()),
        vscode.commands.registerCommand('novelReader.slackerJump', () => slacker.jump()),
        vscode.commands.registerCommand('novelReader.slackerBoss', () => slacker.boss())
    );

    // ---------------------------------------------------------------- 阅读进度 -> 书架

    ReaderPanel.onProgress = (filePath: string, chapterIndex: number, scrollRatio: number) => {
        // 空态占位面板(filePath 为空)没有真实书籍: 不写书架、不记阅读历史
        if (!filePath) {
            return;
        }
        // 用消息里带的 filePath, 而不是 currentNovel ——
        // 窗口恢复出来的面板不会经过 loadNovel, currentNovel 可能为空或指向别的书
        void shelf.updateProgress(filePath, chapterIndex, scrollRatio).then(refreshShelfView);
        // 只推进已有条目: 章内滚动不置顶、不刷新时间, 否则历史列表会一直跳
        history.updateProgress(filePath, chapterIndex);
    };

    // 打开即记历史: createOrShow / restore 两个漏斗都会走到这里
    ReaderPanel.onOpen = (novel: Novel, chapterIndex: number) => {
        recordOpenHistory(novel, chapterIndex);
    };

    // ---------------------------------------------------------------- 摸鱼模式会话

    const slacker = new SlackerController({
        getNovel: ensureNovel,
        getLanguage: () =>
            vscode.workspace.getConfiguration('novelReader').get<string>('slackerLanguage', 'javascript'),
        setLanguage: (id: string) =>
            vscode.workspace
                .getConfiguration('novelReader')
                .update('slackerLanguage', id, vscode.ConfigurationTarget.Global),
        onProgress: (filePath: string, chapterIndex: number) => {
            void shelf.updateProgress(filePath, chapterIndex, 0).then(refreshShelfView);
        },
        listBooks: () => shelfItems(),
        switchBook: (filePath: string) =>
            loadNovel(filePath, { openPanel: false, silent: true }).then((n) => n ?? null),
        getProgress: (filePath: string) => shelf.get(filePath)?.chapterIndex ?? -1,
        onStateChange: (active: boolean) => ReaderPanel.setSlackerActive(active),
    });
    // 阅读面板(新开/重开)init 时实时查询摸鱼会话状态, 保证侧边栏高亮不丢
    ReaderPanel.slackerStateProvider = () => slacker.isActive;
    context.subscriptions.push(slacker.register());


    // ---------------------------------------------------------------- VS Code 设置页 -> 同步阅读偏好

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('novelReader.libraryPath')) {
                syncLibraryToView();
            }
            if (!e.affectsConfiguration('novelReader')) {
                return;
            }
            const next: ReadingSettings | null = await store.applyConfigurationChange(e);
            if (next) {
                ReaderPanel.updateSettings(next);
            }
        })
    );

    // ---------------------------------------------------------------- 启动: 迁移旧数据(不自动打开阅读页)

    syncLibraryToView();
    void (async () => {
        await shelf.migrateLegacySession();
        // 先建离线索引, 书架行才能一次带出「离线 N」标签(不做二次刷新)
        await refreshOfflineIndex();
        refreshShelfView();
        const last = shelf.last();
        // 只把上次那本预载到内存(供书架/章节/设置抽屉使用), 绝不自动弹出阅读面板;
        // 想继续读请点状态栏「小说阅读」或执行 novelReader.resumeCurrent
        if (!last || (!isOnlinePath(last.filePath) && !fs.existsSync(last.filePath))) {
            return;
        }
        await loadNovel(last.filePath, { openPanel: false, silent: true });
    })();
}

export function deactivate(): void {
    // 停掉后台下载: 已下完的章在 done.log 里, 下次会自动续传
    downloadQueue?.cancelAll();
    void historyStore?.flush();
    ReaderPanel.current?.dispose();
}
