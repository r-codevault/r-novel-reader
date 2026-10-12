/**
 * extension.ts — 插件入口
 *
 * 职责:
 *  - 注册命令 / 侧边栏目录树 / 阅读面板
 *  - 打开并解码本地 txt(自动识别 UTF-8 / GB18030 / UTF-16 编码)
 *  - 恢复上次阅读进度(启动即加载, 无需手动打开)
 *  - VS Code 设置页修改阅读偏好时同步到阅读界面
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseNovel, Novel } from './novelParser';
import { ChapterViewProvider } from './chapterViewProvider';
import { ReaderPanel, getSession } from './readerPanel';
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
    const chapterView = new ChapterViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChapterViewProvider.viewType, chapterView, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    let currentNovel: Novel | null = null;

    /** 加载小说: 解析 -> 刷新目录 -> (可选)打开阅读面板 */
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
            void vscode.commands.executeCommand('setContext', 'novelReader.hasNovel', true);

            const session = getSession(context.globalState);
            const resume = !!session && session.filePath === filePath;
            const chapterIndex =
                opts.chapterIndex ?? (resume && session ? session.chapterIndex : 0);
            const scrollRatio = opts.scrollRatio ?? (resume && session ? session.scrollRatio : 0);

            const continueTarget =
                resume && session
                    ? {
                          index: Math.min(session.chapterIndex, novel.chapters.length - 1),
                          title:
                              novel.chapters[Math.min(session.chapterIndex, novel.chapters.length - 1)]
                                  ?.title ?? '',
                      }
                    : null;
            chapterView.setNovel(novel, continueTarget);

            if (opts.openPanel !== false) {
                ReaderPanel.createOrShow(
                    novel,
                    chapterIndex,
                    scrollRatio,
                    store,
                    context.globalState,
                    vscode.ViewColumn.One,
                    opts.openSettings
                );
                chapterView.setCurrent(chapterIndex);
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

    /** 确保已加载某本书(供命令使用) */
    async function ensureNovel(): Promise<Novel | null> {
        if (currentNovel) {
            return currentNovel;
        }
        const session = getSession(context.globalState);
        if (session && fs.existsSync(session.filePath)) {
            await loadNovel(session.filePath, { openPanel: false, silent: true });
        }
        return currentNovel;
    }

    function revealInTree(index: number, center = false): void {
        // 侧边栏是 WebviewView: 只更新"在读"高亮, 不做任何 reveal,
        // 因此侧边栏收起时切换章节不会被强行展开;
        // center=true(点击"继续阅读")时才把当前章节滚动到列表中间。
        chapterView.setCurrent(index, center);
    }

    // ---------------------------------------------------------------- 命令

    context.subscriptions.push(
        vscode.commands.registerCommand('novelReader.openFile', async (arg?: vscode.Uri) => {
            // 资源管理器右键 .txt 文件时直接打开该文件
            if (arg && arg.fsPath) {
                await loadNovel(arg.fsPath, { openPanel: true });
                return;
            }
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                title: '选择小说文件',
                filters: { '小说文本 (*.txt)': ['txt'], '所有文件': ['*'] },
            });
            if (picked && picked[0]) {
                await loadNovel(picked[0].fsPath, { openPanel: true });
            }
        }),

        vscode.commands.registerCommand('novelReader.continueReading', async () => {
            const session = getSession(context.globalState);
            if (!session || !fs.existsSync(session.filePath)) {
                await vscode.commands.executeCommand('novelReader.openFile');
                return;
            }
            const novel = await loadNovel(session.filePath, {
                chapterIndex: session.chapterIndex,
                scrollRatio: session.scrollRatio,
                openPanel: true,
            });
            // 点击"继续阅读"后, 把当前章节在目录列表中定位到垂直中间
            if (novel) {
                revealInTree(Math.min(Math.max(0, session.chapterIndex), novel.chapters.length - 1), true);
            }
        }),

        vscode.commands.registerCommand('novelReader.openChapter', async (index?: number) => {
            const novel = await ensureNovel();
            if (!novel) {
                vscode.window.showInformationMessage('请先打开一本小说: 命令面板搜索"小说阅读器: 打开小说文件"。');
                return;
            }
            const idx = Math.min(Math.max(0, Number(index) || 0), novel.chapters.length - 1);
            ReaderPanel.createOrShow(novel, idx, 0, store, context.globalState);
            revealInTree(idx);
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
                ReaderPanel.createOrShow(novel, chapter, 0, store, context.globalState);
                vscode.window.setStatusBarMessage(`目录已刷新: 共 ${novel.chapters.length} 章`, 3000);
            }
        }),

        vscode.commands.registerCommand('novelReader.openSettings', async () => {
            const novel = await ensureNovel();
            if (!novel) {
                vscode.window.showInformationMessage('请先打开一本小说后再调整阅读设置。');
                return;
            }
            ReaderPanel.createOrShow(
                novel,
                ReaderPanel.current?.chapterIndex ?? 0,
                0,
                store,
                context.globalState,
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

    // ---------------------------------------------------------------- 阅读界面章节变化 -> 同步目录树
    ReaderPanel.onDidChangeChapter = (index: number) => {
        revealInTree(index);
    };

    // ---------------------------------------------------------------- VS Code 设置页 -> 同步阅读偏好
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration('novelReader')) {
                return;
            }
            const next: ReadingSettings | null = await store.applyConfigurationChange(e);
            if (next) {
                ReaderPanel.updateSettings(next);
            }
        })
    );

    // ---------------------------------------------------------------- 启动时恢复上次进度(仅加载, 不弹面板)
    const session = getSession(context.globalState);
    if (session && fs.existsSync(session.filePath)) {
        void loadNovel(session.filePath, { openPanel: false, silent: true });
    }
}

export function deactivate(): void {
    ReaderPanel.current?.dispose();
}
