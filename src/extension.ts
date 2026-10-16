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
import { parseNovel, Novel } from './novelParser';
import { ReaderPanel, ShelfItemView, DrawerTab } from './readerPanel';
import { LauncherViewProvider } from './launcherViewProvider';
import { ShelfStore } from './shelf';
import { ensureInLibrary } from './library';
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
    // 书架/目录/存储 已并入阅读面板左抽屉; 面板未打开时用命令面板或状态栏按钮进入
    ReaderPanel.getShelf = () => shelfItems();
    ReaderPanel.getLibrary = () => getLibraryPath();

    // 活动栏入口视图(极简启动页: 当前在读 + 直达按钮; 列表 UI 在阅读面板左抽屉)
    const launcher = new LauncherViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LauncherViewProvider.viewType, launcher, {
            webviewOptions: { retainContextWhenHidden: true },
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
        syncLauncher();
    }

    /** 活动栏入口视图: 当前在读的书 */
    function syncLauncher(): void {
        const entry = currentNovel ? shelf.get(currentNovel.filePath) : undefined;
        launcher.setCurrent(
            currentNovel
                ? {
                      title: currentNovel.bookTitle,
                      chapterIndex: entry && entry.chapterIndex >= 0 ? entry.chapterIndex : -1,
                      totalChapters: currentNovel.chapters.length,
                  }
                : null
        );
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
        vscode.commands.registerCommand('novelReader.removeFromShelf', async (filePath: string) => {
            if (!filePath) {
                return;
            }
            const book = shelf.get(filePath);
            const name = book?.title || path.basename(filePath);
            const picked = await vscode.window.showWarningMessage(
                `从书架移除「${name}」？阅读进度记录也会一并删除（不会删除文件）。`,
                { modal: true },
                '移除'
            );
            if (picked !== '移除') {
                return;
            }
            await shelf.remove(filePath);
            refreshShelfView();
            vscode.window.setStatusBarMessage(`已从书架移除「${name}」`, 3000);
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
