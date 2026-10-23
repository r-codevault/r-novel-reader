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
import * as path from 'path';
import * as vscode from 'vscode';
import { parseNovel, deriveTitleAuthor, Novel } from './novelParser';
import { ReaderPanel, ShelfItemView, DrawerTab, ReaderPanelState } from './readerPanel';
import { ShelfStore } from './shelf';
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

interface LoadOptions {
    chapterIndex?: number;
    scrollRatio?: number;
    openPanel?: boolean;
    openSettings?: boolean;
    silent?: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
    const store = new SettingsStore(context.globalState);
    const shelf = new ShelfStore(context.globalState);
    const notes = new NotesStore(context.globalState);
    // 书架/目录/存储 已并入阅读面板左抽屉; 面板未打开时用状态栏按钮或命令面板进入
    ReaderPanel.getShelf = () => shelfItems();
    ReaderPanel.notes = notes;
    ReaderPanel.getLibrary = () => getLibraryPath();
    // 章节位置记忆(书架 chapterRatios): 目录切走再切回时恢复原阅读位置
    ReaderPanel.getChapterRatio = (filePath: string, chapterIndex: number) =>
        shelf.getRatio(filePath, chapterIndex);

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
            title: b.title || path.basename(b.filePath),
            author: b.author,
            chapterIndex: b.chapterIndex,
            totalChapters: b.totalChapters,
            current: !!currentNovel && currentNovel.filePath === b.filePath,
        }));
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

    /** 加载小说: 解析 -> 登记书架 -> 刷新视图 -> (可选)打开阅读面板 */
    async function loadNovel(filePath: string, opts: LoadOptions = {}): Promise<Novel | undefined> {
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
                ReaderPanel.createOrShow(
                    novel,
                    chapterIndex,
                    scrollRatio,
                    store,
                    vscode.ViewColumn.One,
                    opts.openSettings
                );
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
        if (last && fs.existsSync(last.filePath)) {
            await loadNovel(last.filePath, { openPanel: false, silent: true });
        }
        return currentNovel;
    }

    // ---------------------------------------------------------------- 命令

        /** 活动栏图标动作: 打开阅读面板(在读则续读, 否则引导添加) */
    async function openReaderFromLauncher(): Promise<void> {
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
        const chapterIndex =
            ReaderPanel.current?.chapterIndex ??
            (entry && entry.chapterIndex >= 0 ? entry.chapterIndex : 0);
        const scrollRatio = ReaderPanel.current?.scrollRatio ?? (entry ? entry.scrollRatio : 0);
        ReaderPanel.createOrShow(novel, chapterIndex, scrollRatio, store);
        refreshShelfView();
        syncLibraryToView();
    }

    // 抽屉入口(命令面板 / 快捷键): 打开阅读面板并切到对应页签
        async function openDrawerAt(tab: DrawerTab): Promise<void> {
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
            const chapterIndex =
                ReaderPanel.current?.chapterIndex ??
                (entry && entry.chapterIndex >= 0 ? entry.chapterIndex : 0);
            const scrollRatio = ReaderPanel.current?.scrollRatio ?? (entry ? entry.scrollRatio : 0);
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
    /** 正在跑的批量检查(暂停/取消) */
    let activeCheck: SearchControl | undefined;
    /** 书源可用性检查: 用测试关键词搜一次, 看是否出结果(结果批量落盘) */
    async function checkBookSources(arg?: string | { id?: string; scope?: CheckScope }): Promise<void> {
        const id = typeof arg === 'string' ? arg : arg?.id;
        const scope: CheckScope = (typeof arg === 'object' && arg?.scope) || 'active';
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
        activeCheck?.cancel();
        const control = new SearchControl();
        activeCheck = control;

        const results: { id: string; ok: boolean; message: string }[] = [];
        const postProgress = (done: number, sourceName: string): void => {
            ReaderPanel.current?.postSourceCheckProgress({
                scope: id ? 'single' : scope,
                done,
                total: targets.length,
                sourceName,
                paused: control.paused,
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

        activeCheck = undefined;
        ReaderPanel.current?.postSourceCheckDone();
        // 一次写盘: 失败一次即判失效, 成功则清零/自动恢复
        if (results.length) { await bookSources.recordResults(results); }
        ReaderPanel.current?.postSources();
    }

    ReaderPanel.bookSources = {
        list: () => bookSources.list().map(toSourceView),
        importText: (text) => bookSources.importText(text),
        remove: (id) => bookSources.remove(id),
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
        exportText: () => bookSources.exportText(),
        revive: (id) => bookSources.revive(id),
        clearDead: () => bookSources.clearDead(),
        deadCount: () => bookSources.deadList().length,
        setEnabledMany: (patches) => bookSources.setEnabledMany(patches),
        pauseCheck: (paused: boolean) => {
            if (!activeCheck) { return; }
            if (paused) { activeCheck.pause(); } else { activeCheck.resume(); }
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

    // 面板关闭时停掉批量检查, 避免后台挂着
    ReaderPanel.cancelSourceCheck = () => {
        activeCheck?.cancel();
        activeCheck = undefined;
    };

    /** 打开书源面板: 没有书时提示先打开一本(面板依赖阅读页) */
    async function showSourcesPanel(): Promise<void> {
        const novel = await ensureNovel();
        if (!novel) {
            const picked = await vscode.window.showInformationMessage(
                '请先打开一本书, 再使用书源搜索。',
                '选择本地文件'
            );
            if (picked === '选择本地文件') {
                await vscode.commands.executeCommand('novelReader.openFile');
            }
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
        vscode.commands.registerCommand('novelReader.checkSources', (arg?: string | { id?: string; scope?: 'active' | 'dead' | 'all' }) => checkBookSources(arg)),
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
        vscode.commands.registerCommand('novelReader.removeFromShelf', async (filePath: string) => {
            if (!filePath) {
                return;
            }
            const book = shelf.get(filePath);
            const name = book?.title || path.basename(filePath);
            const libPath = getLibraryPath();
            const inLibrary = !!libPath && isInsideDir(filePath, libPath);
            const fileExists = fs.existsSync(filePath);
            const willTrash = inLibrary && fileExists;
            // 未删除文件时说明原因, 避免"设了书库目录却提示不删文件"的困惑
            const whyNotTrash = !libPath
                ? '未设置书库目录'
                : !inLibrary
                  ? '该书文件不在书库目录内'
                  : '文件不存在';
            const confirmText = willTrash
                ? `从书架移除「${name}」并把文件移入回收站？\n文件：${filePath}`
                : `从书架移除「${name}」？仅移除书架记录，不删除文件。\n原因：${whyNotTrash}\n文件：${filePath}`;
            // 注意: modal 对话框会自动带「取消」, 这里只传确认按钮, 否则出现两个取消
            const picked = await vscode.window.showWarningMessage(confirmText, { modal: true }, '移除');
            if (picked !== '移除') {
                return;
            }
            if (willTrash) {
                try {
                    await moveToTrash(filePath);
                } catch (err) {
                    // 移入回收站失败: 中止操作(不删记录, 不丢文件)
                    vscode.window.showErrorMessage(
                        `移入回收站失败，已取消删除: ${err instanceof Error ? err.message : String(err)}`
                    );
                    return;
                }
            }
            await shelf.remove(filePath);
            refreshShelfView();
            vscode.window.setStatusBarMessage(
                willTrash ? `已移除「${name}」并移入回收站` : `已从书架移除「${name}」`,
                3000
            );
        }),

        // 书架: 按书库目录重新扫描(新增缺失的 txt, 清理书库内已不存在的记录)
        vscode.commands.registerCommand('novelReader.refreshShelfFromLibrary', async () => {
            const dir = getLibraryPath();
            if (!dir) {
                void vscode.window.showInformationMessage('未设置书库目录：请先在「存储位置」里选择书库目录。');
                return;
            }
            if (!fs.existsSync(dir)) {
                void vscode.window.showWarningMessage(`书库目录不存在：${dir}`);
                return;
            }
            let names: string[] = [];
            try {
                names = (await fs.promises.readdir(dir, { withFileTypes: true }))
                    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.txt'))
                    .map((d) => path.join(dir, d.name));
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `读取书库目录失败: ${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }
            const known = new Set(shelf.list().map((b) => b.filePath.toLowerCase()));
            // 已有书籍键(书名+作者+章节数): 同书的多份副本/老路径记录不重复补录
            const knownKeys = new Set(
                shelf.list().map((b) => shelfBookKey(b.title, b.author, b.totalChapters))
            );
            let added = 0;
            let skippedDup = 0;
            for (const file of names) {
                if (known.has(file.toLowerCase())) {
                    continue;
                }
                try {
                    const buf = await fs.promises.readFile(file);
                    const { text, encoding } = decodeBuffer(buf);
                    const novel = parseNovel(text, file, encoding);
                    const key = shelfBookKey(novel.bookTitle, novel.author, novel.chapters.length);
                    if (knownKeys.has(key)) {
                        // 同一本书已经在书架里(哪怕文件路径不同): 跳过, 避免重复出现
                        skippedDup += 1;
                        continue;
                    }
                    await shelf.upsert({
                        filePath: file,
                        title: novel.bookTitle,
                        author: novel.author,
                        totalChapters: novel.chapters.length,
                    });
                    knownKeys.add(key);
                    added += 1;
                } catch {
                    // 单个文件解析失败: 跳过, 不影响其余
                }
            }
            // 书名纠偏: 按文件名重新推导标题/作者(仅当文件名含《书名》时才改写)
            let retitled = 0;
            for (const b of shelf.list()) {
                if (!isInsideDir(b.filePath, dir) || !fs.existsSync(b.filePath)) {
                    continue;
                }
                const fnTitle = b.filePath.replace(/^.*[\\/]/, '').match(/《([^》]{1,60})》/);
                if (!fnTitle) {
                    continue;
                }
                const { bookTitle, author } = deriveTitleAuthor(b.filePath, '');
                if (bookTitle !== b.title || author !== b.author) {
                    await shelf.upsert({
                        filePath: b.filePath,
                        title: bookTitle,
                        author,
                        totalChapters: b.totalChapters,
                    });
                    retitled += 1;
                }
            }

            // 合并同书重复记录(同书名+作者+章节数): 只保留一条, 只删记录不动文件
            let merged = 0;
            const dupPlans = planDuplicateRemoval(
                shelf.list(),
                dir,
                (p) => fs.existsSync(p),
                isInsideDir
            );
            for (const plan of dupPlans) {
                for (const b of plan.removals) {
                    await shelf.remove(b.filePath);
                    merged += 1;
                }
            }
            // 清理: 书库内已不存在的文件, 其书架记录一并移除
            let pruned = 0;
            for (const b of shelf.list()) {
                if (isInsideDir(b.filePath, dir) && !fs.existsSync(b.filePath)) {
                    await shelf.remove(b.filePath);
                    pruned += 1;
                }
            }
            refreshShelfView();
            void vscode.window.showInformationMessage(
                `书架已刷新：新增 ${added} 本` +
                (skippedDup ? `，跳过重复副本 ${skippedDup} 个` : '') +
                (merged ? `，合并重复记录 ${merged} 条` : '') +
                (retitled ? `，修正书名 ${retitled} 条` : '') +
                (pruned ? `，清理失效记录 ${pruned} 条` : '') +
                `（书库内共 ${names.length} 个 txt）`
            );
        }),

        // 回到当前阅读的章节(阅读面板已关闭时会重新打开)
        vscode.commands.registerCommand('novelReader.resumeCurrent', async () => {
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
            const index = ReaderPanel.current?.chapterIndex ?? Math.max(0, novel.chapters.length - 1);
            const entry = shelf.get(novel.filePath);
            const target = entry && entry.chapterIndex >= 0 ? entry.chapterIndex : index;
            refreshShelfView();
            ReaderPanel.createOrShow(novel, target, entry?.scrollRatio ?? 0, store);
        }),

        vscode.commands.registerCommand('novelReader.showBookshelf', () => void openDrawerAt('shelf')),
        vscode.commands.registerCommand('novelReader.showChapters', () => void openDrawerAt('catalog')),
        vscode.commands.registerCommand('novelReader.showSettings', () => void openDrawerAt('storage')),

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
        // 用消息里带的 filePath, 而不是 currentNovel ——
        // 窗口恢复出来的面板不会经过 loadNovel, currentNovel 可能为空或指向别的书
        void shelf.updateProgress(filePath, chapterIndex, scrollRatio).then(refreshShelfView);
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
        refreshShelfView();
        const last = shelf.last();
        // 只把上次那本预载到内存(供书架/章节/设置抽屉使用), 绝不自动弹出阅读面板;
        // 想继续读请点状态栏「小说阅读」或执行 novelReader.resumeCurrent
        if (!last || !fs.existsSync(last.filePath)) {
            return;
        }
        await loadNovel(last.filePath, { openPanel: false, silent: true });
    })();
}

export function deactivate(): void {
    ReaderPanel.current?.dispose();
}
