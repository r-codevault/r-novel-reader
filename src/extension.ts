/**
 * extension.ts — 插件入口
 *
 * 职责:
 *  - 注册命令 / 阅读面板(内含 书架/目录/存储 左抽屉)
 *  - 打开并解码本地 txt(自动识别 UTF-8 / GB18030 / UTF-16 编码)
 *  - 书架管理: 多本小说的登记、进度同步、移除
 *  - 启动时自动延续上一次阅读状态(自动加载上次那本书与进度)
 *  - VS Code 设置页修改阅读偏好时同步到阅读界面
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseNovel, deriveTitleAuthor, Novel } from './novelParser';
import { ReaderPanel, ShelfItemView, DrawerTab, ReaderPanelState } from './readerPanel';
import { ShelfStore } from './shelf';
import { ensureInLibrary, isInsideDir } from './library';
import { shelfBookKey, planDuplicateRemoval } from './shelfMaintenance';
import { moveToTrash } from './trash';
import { ReadingSettings, SettingsStore } from './settings';

/** 读取文件字节并识别编码(站点下载的 txt 常为 GB18030) */
function decodeBuffer(buf: Buffer): { text: string; encoding: string } {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { text: buf.toString('utf8'), encoding: 'utf8-bom' };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.toString('utf16le'), encoding: 'utf16le' };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf);
        swapped.swap16();
        return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
    }
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) {
        return { text: utf8, encoding: 'utf8' };
    }
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
}

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
    // 书架/目录/存储 已并入阅读面板左抽屉; 面板未打开时用状态栏按钮或命令面板进入
    ReaderPanel.getShelf = () => shelfItems();
    ReaderPanel.getLibrary = () => getLibraryPath();

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
                await ReaderPanel.restore(
                    panel,
                    state as ReaderPanelState | undefined,
                    store,
                    enabled
                );
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

            const entry = await shelf.upsert({
                filePath,
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
                ReaderPanel.showChapter(panel.chapterIndex - 1);
            }
        }),

        vscode.commands.registerCommand('novelReader.nextChapter', () => {
            const panel = ReaderPanel.current;
            if (panel) {
                ReaderPanel.showChapter(panel.chapterIndex + 1);
            }
        })
    );

    // ---------------------------------------------------------------- 阅读进度 -> 书架

    ReaderPanel.onProgress = (chapterIndex: number, scrollRatio: number) => {
        if (!currentNovel) {
            return;
        }
        void shelf.updateProgress(currentNovel.filePath, chapterIndex, scrollRatio).then(refreshShelfView);
    };


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

    // ---------------------------------------------------------------- 启动: 迁移旧数据 + 自动延续上次阅读状态

    syncLibraryToView();
    void (async () => {
        await shelf.migrateLegacySession();
        refreshShelfView();
        const last = shelf.last();
        // 没有任何记录: 保持原样(用户可点状态栏「小说阅读」进入)
        if (!last || !fs.existsSync(last.filePath)) {
            return;
        }
        if (last.chapterIndex >= 0) {
            // 读过: 自动打开阅读面板, 恢复到上次的书/章节/章内位置
            await loadNovel(last.filePath, { openPanel: true, silent: true });
        } else {
            // 只加进书架还没开始读: 只加载到侧边栏
            await loadNovel(last.filePath, { openPanel: false, silent: true });
        }
    })();
}

export function deactivate(): void {
    ReaderPanel.current?.dispose();
}
