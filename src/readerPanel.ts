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
import { FONTS, ReadingSettings, SettingsStore, THEMES, fontStackById, themeById } from './settings';

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
    | { type: 'openFile' };

export class ReaderPanel {
    public static readonly viewType = 'novelReader.reader';
    public static current: ReaderPanel | undefined;
    /** 章节变化回调(供侧边栏「当前阅读」条与目录同步) */
    public static onDidChangeChapter?: (index: number) => void;
    /** 阅读进度回调(由插件入口写入书架) */
    public static onProgress?: (chapterIndex: number, scrollRatio: number) => void;

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
        ReaderPanel.current?._panel.webview.postMessage({ type: 'settings', payload: settings });
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
                void this._store.update(msg.patch).then((next) => {
                    this._settings = next;
                    this._panel.webview.postMessage({ type: 'settings', payload: next });
                });
                break;
            case 'resetSettings':
                void this._store.reset().then((next) => {
                    this._settings = next;
                    this._panel.webview.postMessage({ type: 'settings', payload: next });
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
        };
        this._openSettingsOnLoad = false;
        this._panel.webview.postMessage({ type: 'init', payload });
    }

    private _postChapter(): void {
        if (!this._ready) {
            return;
        }
        this._panel.webview.postMessage({ type: 'chapter', payload: this._chapterPayload() });
    }

    // ---------------------------------------------------------------- HTML

    private _getHtml(settings: ReadingSettings): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const fontStacks = JSON.stringify(
            Object.fromEntries(FONTS.map((f) => [f.id, f.stack]))
        );
        const themes = JSON.stringify(THEMES);
        const defaults = JSON.stringify(settings);

        return `<!DOCTYPE html>
<html lang="zh-CN">
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
    /* 悬浮球(起点风格): 浅色=白底+主题色图标/描边; 黑夜=深底+暖金图标 */
    --fab-bg: ${settings.theme === 'dark' ? '#1c1c1c' : '#ffffff'};
    --fab-fg: ${settings.theme === 'dark' ? '#c9963f' : themeById(settings.theme).accent};
    --fab-border: ${settings.theme === 'dark' ? '#333333' : themeById(settings.theme).chromeBorder};
    --btn-hover: ${themeById(settings.theme).accent};
    --input-bg: ${themeById(settings.theme).bg};
    --input-fg: ${themeById(settings.theme).fg};
    --input-border: ${themeById(settings.theme).chromeBorder};
    /* 设置面板配色初值(实际值由 applySettings 按当前主题实时维护, 切主题立即跟随) */
    --font-size: ${settings.fontSize}px;
    --font-family: ${fontStackById(settings.fontFamily)};
    --line-height: ${settings.lineHeight};
    --para-spacing: ${settings.paragraphSpacing}em;
    --content-width: ${settings.contentWidth}px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-family);
    background: var(--chrome-bg);
    color: var(--chrome-fg);
  }

  /* ---------- 悬浮球(目录 / 阅读设置), 可拖动 ---------- */
  #fabs {
    position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; gap: 10px;
    z-index: 40;
    opacity: .5; transition: opacity .25s ease;
  }
  #fabs:hover, #fabs.dragging, #fabs.awake { opacity: 1; }
  .fab {
    width: 58px;
    padding: 9px 4px 7px;
    border-radius: 12px;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    background: var(--fab-bg); color: var(--fab-fg);
    border: 1px solid var(--fab-border);
    box-shadow: 0 3px 12px rgba(0, 0, 0, .32);
    cursor: grab; user-select: none;
    touch-action: none;
    transition: transform .15s ease, filter .15s ease;
  }
  .fab:hover { transform: scale(1.05); filter: brightness(1.1); }
  .fab:active { cursor: grabbing; }
  .fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #fabs.dragging .fab { transform: none; }
  .fab svg { width: 20px; height: 20px; pointer-events: none; }
  .fab-label { font-size: clamp(10px, calc(var(--font-size) * 0.65), 13px); pointer-events: none; letter-spacing: .02em; }
  /* 长文案(如"阅读设置")用更小字号, 保证不超出按钮宽度 */
  .fab-label-sm { font-size: clamp(9px, calc(var(--font-size) * 0.55), 11px); letter-spacing: 0; }
  /* 首末章时上一章/下一章置灰不可点 */
  .fab.off { opacity: .35; pointer-events: none; }

  .progress-fill { height: 100%; width: 0; background: var(--accent); transition: width .2s ease; }

  /* ---------- 目录面板(参考起点中文网目录) ---------- */
  #catalogPanel {
    display: none;
    position: fixed;
    top: 12px; left: 50%; transform: translateX(-50%);
    width: min(980px, calc(100vw - 32px));
    max-height: calc(100vh - 76px);
    flex-direction: column;
    z-index: 45;
    background: var(--chrome-bg);
    color: var(--chrome-fg);
    border: 1px solid var(--chrome-border);
    border-radius: 8px;
    box-shadow: 0 8px 28px var(--vscode-widget-shadow, rgba(0, 0, 0, .35));
    overflow: hidden;
  }
  #catalogPanel.open { display: flex; }
  .cat-head {
    flex: none;
    display: flex; align-items: baseline; gap: 10px;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--chrome-border);
  }
  /* 目录字号与阅读区同步: 章节条目 = 正文字号; 分卷名/面板标题 ≈ 章节标题字号 */
  .cat-title { font-size: clamp(16px, calc(var(--font-size) * 1.2), 24px); font-weight: 600; }
  .cat-sub { font-size: clamp(11px, calc(var(--font-size) * 0.78), 16px); opacity: .6; }
  .cat-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .cat-btn {
    border: 1px solid var(--input-border);
    background: var(--input-bg); color: var(--chrome-fg);
    border-radius: 4px; padding: 3px 10px; cursor: pointer;
    font-size: 12px; font-family: inherit; line-height: 1.5; white-space: nowrap;
  }
  .cat-btn:hover { border-color: var(--accent); color: var(--accent); }
  .cat-btn.on { border-color: var(--accent); color: var(--accent); }
  .cat-close {
    border: none; background: none; cursor: pointer; color: inherit;
    opacity: .65; font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 4px;
  }
  .cat-close:hover { opacity: 1; background: var(--input-bg); }
  .cat-body { flex: 1 1 auto; overflow-y: auto; padding: 4px 0 10px; }
  .cat-group { border-bottom: 1px solid var(--chrome-border); }
  .cat-group:last-child { border-bottom: none; }
  .cat-group-head {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 16px; cursor: pointer; user-select: none;
    background: var(--input-bg);
  }
  .cat-group-head:hover { color: var(--accent); }
  .cat-group-name { font-size: clamp(14px, calc(var(--font-size) * 1.05), 21px); font-weight: 600; }
  .cat-group-count { font-size: clamp(11px, calc(var(--font-size) * 0.78), 16px); opacity: .55; }
  .cat-group-toggle {
    margin-left: auto; opacity: .6;
    font-size: clamp(12px, calc(var(--font-size) * 0.85), 17px);
    padding: 2px 8px; border-radius: 4px;
  }
  .cat-group-head:hover .cat-group-toggle { opacity: 1; background: var(--chrome-bg); }
  .cat-group.collapsed .cat-group-toggle { transform: rotate(180deg); }
  .cat-group.collapsed .cat-items { display: none; }
  .cat-items {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px 14px; padding: 8px 16px 12px;
  }
  @media (max-width: 720px) { .cat-items { grid-template-columns: 1fr; } }
  .cat-item {
    display: flex; align-items: baseline; gap: 6px;
    padding: 6px 8px; border-radius: 4px; cursor: pointer;
    white-space: nowrap; overflow: hidden;
  }
  .cat-item:hover { background: var(--input-bg); }
  /* 条目字号与正文一致 */
  .cat-item .cat-no { font-size: clamp(13px, var(--font-size), 22px); opacity: .55; flex: none; }
  .cat-item .cat-name { font-size: clamp(13px, var(--font-size), 22px); overflow: hidden; text-overflow: ellipsis; }
  .cat-item.cur { background: var(--input-bg); }
  .cat-item.cur .cat-no { color: var(--accent); opacity: 1; font-weight: 600; }
  .cat-item.cur .cat-name { color: var(--accent); font-weight: 600; }
  .cat-foot {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    padding: 9px 16px;
    border-top: 1px solid var(--chrome-border);
  }
  .cat-foot .cat-pos { margin-left: auto; font-size: clamp(11px, calc(var(--font-size) * 0.78), 16px); opacity: .6; font-variant-numeric: tabular-nums; }
  .cat-foot .cat-btn { font-size: clamp(12px, calc(var(--font-size) * 0.82), 17px); }
  .cat-head .cat-btn { font-size: clamp(12px, calc(var(--font-size) * 0.82), 17px); }

  /* ---------- 设置面板(起点风格; 黑夜模式沿用深色面板) ---------- */
  #settingsPanel {
    display: none;
    position: fixed;
    top: 12px;
    left: 12px;
    width: 340px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    z-index: 45;
    padding: 14px 16px 12px;
    background: var(--sp-bg);
    color: var(--sp-fg);
    border: 1px solid var(--sp-border);
    border-radius: 10px;
    box-shadow: 0 10px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25));
  }
  #settingsPanel.open { display: block; }
  .sp-head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 12px; }
  .sp-title { font-weight: 600; font-size: clamp(15px, calc(var(--font-size) * 1.05), 20px); }
  .sp-close {
    border: none; background: none; cursor: pointer;
    color: var(--sp-muted); font-size: 13px; line-height: 1;
    padding: 3px 7px; border-radius: 50%;
  }
  .sp-close:hover { color: var(--sp-fg); background: var(--sp-hover); }
  .sp-row { display: flex; align-items: center; gap: 10px; margin: 0 0 13px; }
  .sp-label {
    flex: none; width: 60px;
    font-size: clamp(12px, calc(var(--font-size) * 0.8), 16px); color: var(--sp-muted);
  }
  .sp-themes { display: flex; gap: 10px; flex-wrap: wrap; }
  .sp-dot {
    width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
    border: 1px solid var(--sp-border);
    display: inline-flex; align-items: center; justify-content: center;
  }
  .sp-dot.active { box-shadow: 0 0 0 2px var(--sp-accent); border-color: transparent; }
  .sp-dot.active::after { content: '✓'; font-size: 12px; font-weight: 700; color: var(--sp-check, #ffffff); }
  .sp-seg { display: flex; flex-wrap: wrap; gap: 6px; }
  .sp-seg-btn {
    padding: 4px 12px; cursor: pointer; font-family: inherit;
    font-size: clamp(12px, calc(var(--font-size) * 0.8), 15px);
    background: var(--sp-control-bg); color: var(--sp-fg);
    border: 1px solid var(--sp-border); border-radius: 4px;
  }
  .sp-seg-btn:hover { border-color: var(--sp-accent); }
  .sp-seg-btn.active { border-color: var(--sp-accent); color: var(--sp-accent); }
  .sp-step { display: flex; align-items: stretch; border: 1px solid var(--sp-border); border-radius: 4px; overflow: hidden; }
  .sp-step-btn {
    border: none; background: var(--sp-control-bg); color: var(--sp-fg); cursor: pointer;
    padding: 4px 10px; font-family: inherit;
    font-size: clamp(12px, calc(var(--font-size) * 0.8), 15px); line-height: 1.4;
  }
  .sp-step-btn:hover { color: var(--sp-accent); }
  .sp-step-val {
    min-width: 46px; text-align: center; padding: 4px 6px;
    font-size: clamp(12px, calc(var(--font-size) * 0.8), 15px);
    border-left: 1px solid var(--sp-border); border-right: 1px solid var(--sp-border);
    font-variant-numeric: tabular-nums; align-self: center;
  }
  .sp-reset {
    display: block; width: 100%; margin: 2px 0 10px; padding: 6px 0; cursor: pointer;
    background: transparent; color: var(--sp-fg);
    border: 1px solid var(--sp-border); border-radius: 4px;
    font-size: clamp(12px, calc(var(--font-size) * 0.82), 16px); font-family: inherit;
  }
  .sp-reset:hover { border-color: var(--sp-accent); color: var(--sp-accent); }
  .settings-hint {
    line-height: 1.6;
    font-size: clamp(11px, calc(var(--font-size) * 0.7), 14px); color: var(--sp-muted);
  }

  /* ---------- 阅读区(留白底色 + 正文"纸面") ---------- */
  #reader {
    background: var(--page-bg); color: var(--fg);
    min-height: 100vh;
    padding: 24px 20px 70px;
  }
  #content {
    max-width: var(--content-width);
    margin: 0 auto;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--chrome-border);
    border-radius: 6px;
    box-shadow: 0 2px 16px rgba(0, 0, 0, .14);
    padding: 26px 34px 46px;
    min-height: calc(100vh - 120px);
    font-size: var(--font-size);
    font-family: var(--font-family);
    line-height: var(--line-height);
    letter-spacing: .02em;
  }
  #content p { margin: 0 0 var(--para-spacing); text-indent: 2em; }
  #content .chapter-title {
    text-indent: 0; text-align: center;
    font-size: 1.35em; font-weight: 600;
    margin: .4em 0 1.2em; letter-spacing: .05em;
  }
  .empty-tip { text-align: center; padding: 60px 0; opacity: .7; }

  /* ---------- 底部状态栏(含整书进度条) ---------- */
  .statusbar {
    position: fixed; left: 0; right: 0; bottom: 0;
    display: flex; flex-direction: column;
    font-size: 12px;
    background: var(--chrome-bg); color: var(--chrome-fg);
    border-top: 1px solid var(--chrome-border);
    font-variant-numeric: tabular-nums;
  }
  .statusbar .progress-track { height: 3px; width: 100%; background: var(--chrome-border); }
  .statusbar .status-row { display: flex; gap: 16px; align-items: center; padding: 4px 14px; }
  .statusbar .status-row .spacer { flex: 1; }
</style>
</head>
<body>
<!-- 悬浮球工具栏: 上一章 / 目录 / 下一章 / 字 (icon+文字, 可拖动) -->
<div id="fabs">
  <button id="fabPrev" class="fab" type="button" title="上一章 (Alt+←)" aria-label="上一章">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    <span class="fab-label">上一章</span>
  </button>
  <button id="fabCatalog" class="fab" type="button" title="目录" aria-label="目录">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>
    <span class="fab-label">目录</span>
  </button>
  <button id="fabNext" class="fab" type="button" title="下一章 (Alt+→)" aria-label="下一章">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
    <span class="fab-label">下一章</span>
  </button>
  <button id="fabSettings" class="fab" type="button" title="阅读设置" aria-label="阅读设置">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><text x="2.5" y="17.5" font-size="15" font-weight="600" stroke="none" fill="currentColor">A</text><text x="13.5" y="17.5" font-size="10" stroke="none" fill="currentColor">A</text></svg>
    <span class="fab-label fab-label-sm">阅读设置</span>
  </button>
</div>

<!-- 目录面板: 参考起点中文网目录(分卷 + 双列 + 当前章高亮) -->
<section id="catalogPanel" role="dialog" aria-label="目录">
  <div class="cat-head">
    <span class="cat-title">目录</span>
    <span class="cat-sub" id="catSub"></span>
    <span class="cat-tools">
      <button class="cat-btn" id="catReverse" type="button" title="切换正序 / 倒序">倒序</button>
      <button class="cat-close" id="catClose" type="button" title="关闭 (Esc)">✕</button>
    </span>
  </div>
  <div class="cat-body" id="catBody"></div>
  <div class="cat-foot">
    <button class="cat-btn" id="catPrev" type="button" title="上一章 (Alt+←)">‹ 上一章</button>
    <button class="cat-btn" id="catNext" type="button" title="下一章 (Alt+→)">下一章 ›</button>
    <span class="cat-pos" id="catPos"></span>
  </div>
</section>

<section id="settingsPanel" role="dialog" aria-label="阅读设置">
  <div class="sp-head">
    <span class="sp-title">设置</span>
    <button id="settingsClose" class="sp-close" title="关闭设置 (Esc)">✕</button>
  </div>
  <div class="sp-row">
    <span class="sp-label">阅读主题</span>
    <div class="sp-themes" id="themeSwatches"></div>
  </div>
  <div class="sp-row">
    <span class="sp-label">正文字体</span>
    <div class="sp-seg" id="fontFamilySeg"></div>
  </div>
  <div class="sp-row">
    <span class="sp-label">字号大小</span>
    <div class="sp-step">
      <button id="fontDec" class="sp-step-btn" title="缩小字号">A-</button>
      <span id="fontSizeVal" class="sp-step-val"></span>
      <button id="fontInc" class="sp-step-btn" title="放大字号">A+</button>
    </div>
  </div>
  <div class="sp-row">
    <span class="sp-label">行距</span>
    <div class="sp-step">
      <button id="lineDec" class="sp-step-btn" title="减小行距">−</button>
      <span id="lineHeightVal" class="sp-step-val"></span>
      <button id="lineInc" class="sp-step-btn" title="增大行距">＋</button>
    </div>
  </div>
  <div class="sp-row">
    <span class="sp-label">段距</span>
    <div class="sp-step">
      <button id="paraDec" class="sp-step-btn" title="减小段距">−</button>
      <span id="paraSpacingVal" class="sp-step-val"></span>
      <button id="paraInc" class="sp-step-btn" title="增大段距">＋</button>
    </div>
  </div>
  <div class="sp-row">
    <span class="sp-label">页面宽度</span>
    <div class="sp-seg" id="widthSeg"></div>
  </div>
  <button id="resetSettings" class="sp-reset">恢复默认设置</button>
  <div class="settings-hint" id="shortcutHint"></div>
</section>

<main id="reader">
  <article id="content"><p class="empty-tip">加载中…</p></article>
</main>

<footer class="statusbar">
  <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
  <div class="status-row">
    <span id="bookInfo"></span>
    <span class="spacer"></span>
    <span id="chapterWords"></span>
    <span id="chapterInfo"></span>
  </div>
</footer>

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var FONT_STACKS = ${fontStacks};
  var THEMES = ${themes};
  var DEFAULT_SETTINGS = ${defaults};

  var state = { novel: null, settings: DEFAULT_SETTINGS, chapterIndex: 0, chapterWords: 0, chapters: [], catReverse: false, catCollapsed: [], prevCombo: null, nextCombo: null };

  /** 快捷键字符串 -> {ctrl,alt,shift,meta,key}; 空/非法返回 null(表示禁用) */
  function parseShortcut(str) {
    if (!str || typeof str !== 'string') { return null; }
    // 不用正则: 模板字符串会吃掉反斜杠转义
    var raw = str.toLowerCase().split('+');
    var parts = [];
    for (var i = 0; i < raw.length; i++) {
      var trimmed = raw[i].split(' ').join('');
      if (trimmed) { parts.push(trimmed); }
    }
    var combo = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (p === 'ctrl' || p === 'control') { combo.ctrl = true; }
      else if (p === 'alt' || p === 'option') { combo.alt = true; }
      else if (p === 'shift') { combo.shift = true; }
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') { combo.meta = true; }
      else { combo.key = normalizeKey(p); }
    }
    return combo.key ? combo : null;
  }

  function normalizeKey(k) {
    if (k === 'left') { return 'arrowleft'; }
    if (k === 'right') { return 'arrowright'; }
    if (k === 'up') { return 'arrowup'; }
    if (k === 'down') { return 'arrowdown'; }
    if (k === 'esc') { return 'escape'; }
    if (k === 'space' || k === 'spacebar') { return ' '; }
    return k;
  }

  function matchShortcut(combo, e) {
    if (!combo) { return false; }
    var key = (e.key || '').toLowerCase();
    if (key === 'esc') { key = 'escape'; }
    return (
      !!combo.ctrl === !!e.ctrlKey &&
      !!combo.alt === !!e.altKey &&
      !!combo.shift === !!e.shiftKey &&
      !!combo.meta === !!e.metaKey &&
      combo.key === key
    );
  }

  /** 快捷键展示文案(给设置面板底部提示用) */
  function shortcutLabel(str) {
    if (!str) { return '未设置'; }
    return String(str)
      .toLowerCase()
      .split('arrowleft').join('←')
      .split('arrowright').join('→')
      .split('arrowup').join('↑')
      .split('arrowdown').join('↓')
      .split('+').join(' + ');
  }

  function $(id) { return document.getElementById(id); }
  var els = {
    fabs: $('fabs'), fabCatalog: $('fabCatalog'), fabSettings: $('fabSettings'),
    catalogPanel: $('catalogPanel'), catBody: $('catBody'), catSub: $('catSub'),
    catClose: $('catClose'), catReverse: $('catReverse'),
    catPrev: $('catPrev'), catNext: $('catNext'), catPos: $('catPos'),
    settingsPanel: $('settingsPanel'), settingsClose: $('settingsClose'),
    fontSizeVal: $('fontSizeVal'),
    fontDec: $('fontDec'), fontInc: $('fontInc'),
    fontFamilySeg: $('fontFamilySeg'),
    lineDec: $('lineDec'), lineInc: $('lineInc'), lineHeightVal: $('lineHeightVal'),
    paraDec: $('paraDec'), paraInc: $('paraInc'), paraSpacingVal: $('paraSpacingVal'),
    widthSeg: $('widthSeg'),
    themeSwatches: $('themeSwatches'), reset: $('resetSettings'),
    shortcutHint: $('shortcutHint'),
    content: $('content'), bookInfo: $('bookInfo'), chapterInfo: $('chapterInfo'),
    chapterWords: $('chapterWords'),
    fabPrev: $('fabPrev'), fabNext: $('fabNext'),
    progressFill: $('progressFill'),
    statusbar: document.querySelector('.statusbar'),
  };

  /* ---------------- 悬浮球: 拖动 + 点击 + 闲置淡化 ---------------- */
  var IDLE_MS = 3000;
  var idleTimer = null;
  var lastPointerActivate = 0;
  var lastFabPressAt = 0;
  /** 用户是否拖动过悬浮球(拖过则以拖动位置为准, 不再自动跟随阅读区域) */
  var fabDragged = false;

  /** 单击之间的间隔判断双击(用于恢复默认位置) */
  function resetFabPosition() {
    fabDragged = false;
    els.fabs.style.left = 'auto';
    els.fabs.style.transform = 'translateY(-50%)';
    syncFabAnchor();
    // -1 表示恢复"跟随阅读区域"
    persistSettings({ fabLeft: -1, fabTop: -1 });
  }

  /** 悬浮球动作: 上一章 / 目录 / 下一章 / 字体设置 */
  function activateFab(id) {
    if (id === 'fabPrev') {
      gotoChapter(state.chapterIndex - 1);
    } else if (id === 'fabNext') {
      gotoChapter(state.chapterIndex + 1);
    } else if (id === 'fabCatalog') {
      if (catalogOpen()) { closeCatalog(); } else { openCatalog(); }
    } else if (id === 'fabSettings') {
      closeCatalog();
      if (settingsOpen()) { closeSettings(); } else { openSettings(); }
    }
  }

  function wakeFabs() {
    els.fabs.classList.add('awake');
    if (idleTimer) { clearTimeout(idleTimer); }
    idleTimer = setTimeout(function () { els.fabs.classList.remove('awake'); }, IDLE_MS);
  }
  document.addEventListener('mousemove', wakeFabs, { passive: true });
  document.addEventListener('scroll', wakeFabs, { passive: true });

  /** 悬浮球纵向可放的最大 top(避免下边界超出: 减去实测高度与底部状态栏) */
  function fabMaxTop() {
    var h = els.fabs.offsetHeight || 240;
    var statusH = els.statusbar ? els.statusbar.offsetHeight : 30;
    return Math.max(8, window.innerHeight - h - statusH - 8);
  }

  function applyFabPosition(pos) {
    if (!pos) { return; }
    var maxX = Math.max(0, window.innerWidth - 60);
    els.fabs.style.left = Math.min(Math.max(0, pos.left), maxX) + 'px';
    els.fabs.style.top = Math.min(Math.max(0, pos.top), fabMaxTop()) + 'px';
    els.fabs.style.right = 'auto';
    els.fabs.style.transform = 'none';
  }

  /**
   * 悬浮球默认位置: 跟随阅读区域的右边缘(起点那样贴在正文列的右侧留白里)。
   * 留白不足时退回贴近窗口右侧, 避免压住正文。
   */
  function fabLayoutMetrics() {
    var BALL_W = 58;
    var GAP = 12; // 与正文列边缘保持的间距
    var vw = window.innerWidth;
    var cssW =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-width')) ||
      720;
    var contentW = Math.min(cssW, Math.max(0, vw - 40)); // #reader 左右各 20px padding
    var gutter = (vw - contentW) / 2; // 正文列外侧留白
    return { BALL_W: BALL_W, GAP: GAP, vw: vw, contentW: contentW, gutter: gutter };
  }

  /**
   * 拖动松手后的吸附位置: 吸附到正文列两侧的留白里(贴着纸面边缘),
   * 留白不足时退回贴近窗口边缘。
   */
  function snapFabPosition(side, top) {
    var m = fabLayoutMetrics();
    var hasRoom = m.gutter >= m.GAP + m.BALL_W + 12;
    var left;
    if (side === 'left') {
      // 球的右缘贴在正文列左缘外 GAP 处
      left = hasRoom ? m.gutter - m.GAP - m.BALL_W : 16;
    } else {
      // 球的左缘贴在正文列右缘外 GAP 处
      left = hasRoom ? m.vw - m.gutter + m.GAP : m.vw - m.BALL_W - 16;
    }
    var maxY = fabMaxTop();
    return {
      left: Math.round(Math.min(Math.max(16, left), m.vw - m.BALL_W - 16)),
      top: Math.round(Math.min(Math.max(8, top), maxY)),
    };
  }

  function syncFabAnchor() {
    if (fabDragged) {
      return;
    }
    var m = fabLayoutMetrics();
    // 让球的左缘落在正文列右缘 + GAP 处
    var right = m.gutter - m.BALL_W - m.GAP;
    if (!isFinite(right) || right < 12) {
      right = 12; // 留白不足时退回贴近窗口右侧
    }
    els.fabs.style.right = right + 'px';
    els.fabs.style.left = 'auto';
    // 默认垂直居中; 空间不足(窗口太矮)时贴顶, 避免下边界超出
    var h = els.fabs.offsetHeight || 240;
    var avail = window.innerHeight - (els.statusbar ? els.statusbar.offsetHeight : 30) - 16;
    if (h > avail) {
      els.fabs.style.top = '8px';
      els.fabs.style.transform = 'none';
    } else {
      els.fabs.style.top = '50%';
      els.fabs.style.transform = 'translateY(-50%)';
    }
  }

  (function initFabDrag() {
    var pressId = null;
    var dragging = false;
    var startX = 0;
    var startY = 0;
    var originLeft = 0;
    var originTop = 0;

    els.fabs.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest ? e.target.closest('.fab') : null;
      pressId = btn ? btn.id : null;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      var rect = els.fabs.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      els.fabs.classList.add('awake');
      wakeFabs();
    });

    els.fabs.addEventListener('pointermove', function (e) {
      if (!pressId) { return; }
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) { return; }
        // 真正开始拖动后才捕获指针(pointerdown 时就捕获会吞掉随后的 click)
        dragging = true;
        els.fabs.classList.add('dragging');
        if (els.fabs.setPointerCapture) { els.fabs.setPointerCapture(e.pointerId); }
      }
      e.preventDefault();
      applyFabPosition({ left: originLeft + dx, top: originTop + dy });
    });

    function endDrag() {
      if (dragging) {
        var rect = els.fabs.getBoundingClientRect();
        // 松手后吸附到正文列两侧(左/右留白里, 贴着纸面边缘)
        var side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
        var pos = snapFabPosition(side, rect.top);
        applyFabPosition(pos);
        fabDragged = true;
        persistSettings({ fabLeft: pos.left, fabTop: pos.top });
      } else if (pressId) {
        // 未移动 -> 视为点击(不依赖 click 事件, 避免指针捕获/事件重定向导致无响应)
        lastPointerActivate = Date.now();
        // 双击 -> 恢复"跟随阅读区域"的默认位置
        if (lastPointerActivate - lastFabPressAt < 350) {
          lastFabPressAt = 0;
          resetFabPosition();
        } else {
          lastFabPressAt = lastPointerActivate;
          activateFab(pressId);
        }
      }
      pressId = null;
      dragging = false;
      els.fabs.classList.remove('dragging');
    }
    els.fabs.addEventListener('pointerup', endDrag);
    els.fabs.addEventListener('pointercancel', endDrag);
  })();

  /* ---------------- 目录面板(参考起点中文网) ---------------- */
  function chapterParts(title) {
    var m = /^(第[0-9０-９一二三四五六七八九十百千零两]+[章节回卷部篇集])(.*)$/.exec(title.trim());
    if (m) { return { no: m[1], name: m[2].trim() }; }
    // 注意: 模板字符串里 \s \d 会被吃掉反斜杠, 必须写成 \\s \\d
    var m2 = /^(Chapter\\s*\\d+)(.*)$/i.exec(title.trim());
    if (m2) { return { no: m2[1], name: m2[2].trim() }; }
    return { no: '', name: title.trim() };
  }

  /**
   * 按 卷/部/篇/集 类章节切分目录层级(无此类章节则整体归入"正文")。
   * 卷标题本身也是正文章节, 因此它既作组名, 也作为该组的可点击入口(head.hash),
   * 不会出现"内容不可达"或重复条目。
   */
  function buildCatalogGroups(chapters) {
    // 卷/部/篇/集 标记需出现在标题前部, 避免正文标题里偶尔提及"第X篇"被误判为分卷
    var isVolume = function (title) { return /^.{0,10}第[0-9０-９一二三四五六七八九十百千零两]+[卷部篇集]/.test(title); };
    var groups = [];
    var cur = null;
    for (var i = 0; i < chapters.length; i++) {
      var c = chapters[i];
      if (isVolume(c.title)) {
        if (cur) { groups.push(cur); }
        cur = { name: c.title, entry: c.index, items: [] };
      } else {
        if (!cur) { cur = { name: '正文', entry: -1, items: [] }; }
        cur.items.push(c);
      }
    }
    if (cur) { groups.push(cur); }
    return groups;
  }

  function renderCatalog() {
    var chapters = state.chapters || [];
    if (!state.novel || chapters.length === 0) {
      els.catBody.innerHTML = '<div class="empty-tip">尚未打开小说</div>';
      els.catSub.textContent = '';
      return;
    }
    els.catSub.textContent = '共 ' + chapters.length + ' 章';
    var groups = buildCatalogGroups(chapters);
    if (state.catReverse) {
      groups = groups
        .slice()
        .reverse()
        .map(function (g) { return { name: g.name, entry: g.entry, items: g.items.slice().reverse() }; });
    }

    var html = '';
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var collapsed = (state.catCollapsed || []).indexOf(g.name) >= 0 ? ' collapsed' : '';
      var total = g.items.length + (g.entry >= 0 ? 1 : 0);
      html += '<div class="cat-group' + collapsed + '" data-g="' + escapeHtml(g.name) + '">' +
        '<div class="cat-group-head" title="展开 / 收起本卷">' +
        '<span class="cat-group-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="cat-group-count">共 ' + total + ' 章</span>' +
        '<span class="cat-group-toggle" title="展开 / 收起本卷">⌃</span></div>' +
        '<div class="cat-items">';
      if (g.entry >= 0) {
        var pe = chapterParts(g.name);
        html += '<div class="cat-item" data-i="' + g.entry + '" title="' + escapeHtml(g.name) + '">' +
          (pe.no ? '<span class="cat-no">' + escapeHtml(pe.no) + '</span>' : '') +
          '<span class="cat-name">' + escapeHtml(pe.name || g.name) + '</span></div>';
      }
      for (var i = 0; i < g.items.length; i++) {
        var c = g.items[i];
        var p = chapterParts(c.title);
        html += '<div class="cat-item" data-i="' + c.index + '" title="' + escapeHtml(c.title) + '">' +
          (p.no ? '<span class="cat-no">' + escapeHtml(p.no) + '</span>' : '') +
          '<span class="cat-name">' + escapeHtml(p.name || c.title) + '</span></div>';
      }
      html += '</div></div>';
    }
    els.catBody.innerHTML = html;
    updateCatalogCurrent(true);
  }

  /** 更新当前章高亮 + 底部位置信息 */
  function updateCatalogCurrent(scrollToCurrent) {
    var chapters = state.chapters || [];
    if (chapters.length === 0) { return; }
    var prev = els.catBody.querySelector('.cat-item.cur');
    if (prev) { prev.classList.remove('cur'); }
    var el = els.catBody.querySelector('.cat-item[data-i="' + state.chapterIndex + '"]');
    if (el) {
      el.classList.add('cur');
      // 当前章所在分组自动展开
      var group = el.closest ? el.closest('.cat-group') : null;
      if (group) { group.classList.remove('collapsed'); }
      if (scrollToCurrent && catalogOpen()) {
        el.scrollIntoView({ block: 'center' });
      }
    }
    els.catPos.textContent = '第 ' + (state.chapterIndex + 1) + ' / ' + chapters.length + ' 章';
  }

  function catalogOpen() {
    return els.catalogPanel.classList.contains('open');
  }
  function openCatalog() {
    closeSettings();
    els.catalogPanel.classList.add('open');
    renderCatalog();
  }
  function closeCatalog() {
    els.catalogPanel.classList.remove('open');
  }

  // 兜底: 键盘回车/空格触发的 click(指针路径已由 pointerup 处理, 避免重复)
  els.fabs.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.fab') : null;
    if (!btn) { return; }
    if (Date.now() - lastPointerActivate < 600) { return; }
    activateFab(btn.id);
  });
  // 底部导航按钮已移除(改为悬浮球工具栏)
  els.catClose.addEventListener('click', closeCatalog);
  els.catReverse.addEventListener('click', function () {
    state.catReverse = !state.catReverse;
    els.catReverse.classList.toggle('on', !!state.catReverse);
    els.catReverse.textContent = state.catReverse ? '正序' : '倒序';
    renderCatalog();
  });
  els.catPrev.addEventListener('click', function () { gotoChapter(state.chapterIndex - 1); });
  els.catNext.addEventListener('click', function () { gotoChapter(state.chapterIndex + 1); });
  els.catBody.addEventListener('click', function (e) {
    var target = e.target;
    // 分卷标题: 整行都是"展开/收起", 不做跳转(避免误关面板);
    // 该卷对应的正文章节作为组内第一条, 需要阅读时点它即可
    var head = target.closest ? target.closest('.cat-group-head') : null;
    if (head) {
      var group = head.parentElement;
      group.classList.toggle('collapsed');
      var name = group.dataset.g;
      var list = state.catCollapsed || [];
      var at = list.indexOf(name);
      if (group.classList.contains('collapsed')) {
        if (at < 0) { list.push(name); }
      } else if (at >= 0) {
        list.splice(at, 1);
      }
      state.catCollapsed = list;
      return;
    }
    var item = target.closest ? target.closest('.cat-item') : null;
    if (item) {
      gotoChapter(Number(item.dataset.i));
      closeCatalog();
    }
  });

  /**
   * 设置面板贴着悬浮工具栏弹出(工具栏在左半屏就放右侧, 反之放左侧),
   * 并整体夹在视口内, 保证不超出边界。
   */
  function positionSettingsPanel() {
    var panel = els.settingsPanel;
    if (!panel) { return; }
    var margin = 12;
    var gap = 10;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var maxH = Math.max(200, vh - margin * 2);
    panel.style.maxHeight = maxH + 'px';
    var pw = panel.offsetWidth || 520;
    var ph = Math.min(panel.offsetHeight || 420, maxH);
    var anchor = els.fabs.getBoundingClientRect();
    var hasAnchor = !!(anchor && (anchor.width || anchor.height));
    var left;
    var top;
    if (hasAnchor) {
      left =
        anchor.left + anchor.width / 2 > vw / 2
          ? anchor.left - gap - pw // 工具栏在右半屏 -> 面板放左侧
          : anchor.right + gap; // 工具栏在左半屏 -> 面板放右侧
      top = anchor.top; // 与工具栏顶部对齐
    } else {
      left = (vw - pw) / 2;
      top = margin;
    }
    if (left + pw > vw - margin) { left = vw - margin - pw; }
    if (left < margin) { left = margin; }
    if (!isFinite(left)) { left = margin; }
    if (top + ph > vh - margin) { top = vh - margin - ph; }
    if (top < margin) { top = margin; }
    if (!isFinite(top)) { top = margin; }
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function openSettings() {
    els.settingsPanel.classList.add('open');
    positionSettingsPanel();
  }
  function closeSettings() {
    els.settingsPanel.classList.remove('open');
  }
  function settingsOpen() {
    return els.settingsPanel.classList.contains('open');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function themeOf(id) {
    for (var i = 0; i < THEMES.length; i++) { if (THEMES[i].id === id) { return THEMES[i]; } }
    return THEMES[0];
  }

  /* ---------------- 设置渲染 ---------------- */
  function applySettings(s) {
    state.settings = s;
    var t = themeOf(s.theme);
    var root = document.documentElement;
    root.style.setProperty('--bg', t.bg);
    root.style.setProperty('--fg', t.fg);
    root.style.setProperty('--page-bg', t.pageBg);
    root.style.setProperty('--chrome-bg', t.chromeBg);
    root.style.setProperty('--chrome-fg', t.fg);
    root.style.setProperty('--chrome-border', t.chromeBorder);
    root.style.setProperty('--accent', t.accent);
    root.style.setProperty('--accent-fg', t.accentFg);
    root.style.setProperty('--btn-hover', t.accent);
    root.style.setProperty('--input-bg', t.bg);
    root.style.setProperty('--input-fg', t.fg);
    root.style.setProperty('--input-border', t.chromeBorder);
    // 设置面板配色跟随主题面板色(像起点: 面板与阅读区同一色调), 黑夜沿用深色面板
    // 必须在这里实时设置 -- 静态注入的初值只对应生成 HTML 时的主题, 切主题后不会自动变
    var curTheme = null;
    for (var ti = 0; ti < THEMES.length; ti++) {
      if (THEMES[ti].id === s.theme) { curTheme = THEMES[ti]; }
    }
    if (!curTheme) { curTheme = THEMES[0]; }
    var isDark = curTheme.id === 'dark';
    root.style.setProperty('--sp-bg', isDark ? '#1c1c1c' : curTheme.chromeBg);
    root.style.setProperty('--sp-fg', isDark ? '#bababa' : curTheme.fg);
    root.style.setProperty('--sp-border', isDark ? '#333333' : curTheme.chromeBorder);
    root.style.setProperty('--sp-muted', isDark ? '#8a8a8a' : curTheme.fg + '99');
    root.style.setProperty('--sp-hover', isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)');
    root.style.setProperty('--sp-accent', isDark ? '#c9963f' : '#f56c6c');
    root.style.setProperty('--sp-control-bg', isDark ? '#232323' : curTheme.bg);
    // 悬浮球: 白底 + 主题色图标/描边(黑夜深底 + 暖金图标)
    root.style.setProperty('--fab-bg', isDark ? '#1c1c1c' : '#ffffff');
    root.style.setProperty('--fab-fg', isDark ? '#c9963f' : curTheme.accent);
    root.style.setProperty('--fab-border', isDark ? '#333333' : curTheme.chromeBorder);
    // 快捷键(可在 VS Code 设置里自定义 novelReader.shortcutPrevChapter / NextChapter)
    state.prevCombo = parseShortcut(s.shortcutPrev);
    state.nextCombo = parseShortcut(s.shortcutNext);
    root.style.setProperty('--font-size', s.fontSize + 'px');
    root.style.setProperty('--font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.system);
    root.style.setProperty('--line-height', String(s.lineHeight));
    root.style.setProperty('--para-spacing', s.paragraphSpacing + 'em');
    root.style.setProperty('--content-width', s.contentWidth + 'px');
    syncControls(s);
    // 悬浮球位置: 拖动过(fabLeft >= 0)就保持拖动位置, 否则跟随阅读区域右缘
    fabDragged =
      typeof s.fabLeft === 'number' &&
      s.fabLeft >= 0 &&
      typeof s.fabTop === 'number' &&
      s.fabTop >= 0;
    if (fabDragged) {
      applyFabPosition({ left: s.fabLeft, top: s.fabTop });
    } else {
      syncFabAnchor();
    }
  }

  function syncControls(s) {
    els.fontSizeVal.textContent = String(s.fontSize);
    els.lineHeightVal.textContent = Number(s.lineHeight).toFixed(1);
    els.paraSpacingVal.textContent = Number(s.paragraphSpacing).toFixed(1);
    var dots = els.themeSwatches.children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('active', dots[i].dataset.theme === s.theme);
    }
    var fontBtns = els.fontFamilySeg.children;
    for (var j = 0; j < fontBtns.length; j++) {
      fontBtns[j].classList.toggle('active', fontBtns[j].dataset.font === s.fontFamily);
    }
    var wBtns = els.widthSeg.children;
    for (var k = 0; k < wBtns.length; k++) {
      wBtns[k].classList.toggle('active', Number(wBtns[k].dataset.w) === Number(s.contentWidth));
    }
    els.shortcutHint.textContent =
      'Ctrl + 滚轮 缩放字号 · 上一章 ' + shortcutLabel(s.shortcutPrev) +
      ' · 下一章 ' + shortcutLabel(s.shortcutNext) +
      '（可在 VS Code 设置中自定义）';
  }

  // 页面宽度档位(起点风格)
  var WIDTH_STEPS = [640, 800, 1000, 1200];
  function buildSettingsControls() {
    var dots = '';
    for (var i = 0; i < THEMES.length; i++) {
      var t = THEMES[i];
      dots += '<span class="sp-dot" data-theme="' + t.id + '" title="' + t.name +
        '" style="background:' + t.bg + ';color:' + t.fg + ';--sp-check:' + t.fg + '"></span>';
    }
    els.themeSwatches.innerHTML = dots;

    // 起点风格: 黑体 / 宋体 / 楷体 三个按钮
    var fontIds = ['heiti', 'songti', 'kaiti'];
    var fontNames = { heiti: '黑体', songti: '宋体', kaiti: '楷体' };
    var seg = '';
    for (var j = 0; j < fontIds.length; j++) {
      seg += '<button class="sp-seg-btn" data-font="' + fontIds[j] + '">' + (fontNames[fontIds[j]] || fontIds[j]) + '</button>';
    }
    els.fontFamilySeg.innerHTML = seg;

    var widths = '';
    for (var k = 0; k < WIDTH_STEPS.length; k++) {
      widths += '<button class="sp-seg-btn" data-w="' + WIDTH_STEPS[k] + '">' + WIDTH_STEPS[k] + '</button>';
    }
    els.widthSeg.innerHTML = widths;
  }

  /* ---------------- 章节渲染 ---------------- */
  function renderChapter(payload) {
    state.chapterIndex = payload.index;
    state.chapterWords = payload.chapterWords || 0;
    var html = '<h2 class="chapter-title">' + escapeHtml(payload.title) + '</h2>';
    var paras = payload.paragraphs || [];
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i].trim();
      if (p) { html += '<p>' + escapeHtml(p) + '</p>'; }
    }
    els.content.innerHTML = html || '<p class="empty-tip">(本章无内容)</p>';
    els.catPrev.disabled = payload.index <= 0;
    els.catNext.disabled = payload.index >= payload.totalChapters - 1;
    // 悬浮球: 首末章置灰上一章/下一章
    els.fabPrev.classList.toggle('off', payload.index <= 0);
    els.fabNext.classList.toggle('off', payload.index >= payload.totalChapters - 1);
    updateProgress();
    updateCatalogCurrent(false);
    requestAnimationFrame(function () {
      var max = document.body.scrollHeight - window.innerHeight;
      window.scrollTo(0, max > 0 ? payload.scrollRatio * max : 0);
    });
    sendProgress(true);
  }

  function updateProgress() {
    var total = state.novel ? state.novel.totalChapters : 0;
    var idx = state.chapterIndex + 1;
    els.progressFill.style.width = (total > 0 ? (idx / total) * 100 : 0) + '%';
    els.chapterInfo.textContent = state.novel
      ? ('第 ' + idx + ' 章 / 共 ' + total + ' 章')
      : '';
    // 当前章字数(千分位)
    var words = state.chapterWords || 0;
    els.chapterWords.textContent =
      state.novel && words > 0
        ? '本章 ' + String(words).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + ' 字'
        : '';
  }

  /* ---------------- 进度保存(节流) ---------------- */
  var progressTimer = null;
  function sendProgress(immediate) {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    var send = function () {
      var max = document.body.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      vscode.postMessage({ type: 'saveProgress', chapterIndex: state.chapterIndex, scrollRatio: ratio });
    };
    if (immediate) { send(); } else { progressTimer = setTimeout(send, 600); }
  }
  window.addEventListener('scroll', function () { sendProgress(false); }, { passive: true });

  /* ---------------- 设置变更(防抖保存) ---------------- */
  var saveTimer = null;
  var pendingPatch = {};
  function persistSettings(patch) {
    applySettings(Object.assign({}, state.settings, patch));
    // 累积待发送的改动: 不能被后一次调用覆盖(否则滚轮改字号会被随后的
    // 悬浮球位置写回等操作顶掉, 扩展回推旧设置时字号就"自动还原"了)
    pendingPatch = Object.assign(pendingPatch, patch);
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(function () {
      var sending = pendingPatch;
      pendingPatch = {};
      vscode.postMessage({ type: 'updateSettings', patch: sending });
    }, 250);
  }

  function stepFontSize(d) {
    var cur = state.settings.fontSize || DEFAULT_SETTINGS.fontSize;
    var next = Math.min(32, Math.max(12, cur + d));
    if (next !== cur) { persistSettings({ fontSize: next }); }
  }
  function stepSetting(key, d, min, max) {
    var cur = Number(state.settings[key]) || 0;
    var next = Math.min(max, Math.max(min, Math.round((cur + d) * 10) / 10));
    if (next !== cur) {
      var patch = {};
      patch[key] = next;
      persistSettings(patch);
    }
  }
  els.fontDec.addEventListener('click', function () { stepFontSize(-1); });
  els.fontInc.addEventListener('click', function () { stepFontSize(1); });
  els.lineDec.addEventListener('click', function () { stepSetting('lineHeight', -0.1, 1.2, 2.8); });
  els.lineInc.addEventListener('click', function () { stepSetting('lineHeight', 0.1, 1.2, 2.8); });
  els.paraDec.addEventListener('click', function () { stepSetting('paragraphSpacing', -0.1, 0, 2); });
  els.paraInc.addEventListener('click', function () { stepSetting('paragraphSpacing', 0.1, 0, 2); });
  els.fontFamilySeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.sp-seg-btn');
    if (btn) { persistSettings({ fontFamily: btn.dataset.font }); }
  });
  els.widthSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.sp-seg-btn');
    if (btn) { persistSettings({ contentWidth: Number(btn.dataset.w) }); }
  });
  els.themeSwatches.addEventListener('click', function (e) {
    var btn = e.target.closest('.sp-dot');
    if (btn) { persistSettings({ theme: btn.dataset.theme }); }
  });
  els.reset.addEventListener('click', function () {
    vscode.postMessage({ type: 'resetSettings' });
  });

  /* ---------------- 导航 ---------------- */
  function gotoChapter(index) {
    vscode.postMessage({ type: 'getChapter', index: index });
  }
  els.settingsClose.addEventListener('click', function (e) {
    e.stopPropagation();
    closeSettings();
  });
  // 点击面板外部关闭(用 mousedown: 拖动滑块时鼠标可能在面板外松开, 不应误关)
  document.addEventListener('mousedown', function (e) {
    if (settingsOpen() && !els.settingsPanel.contains(e.target) && !els.fabSettings.contains(e.target)) {
      closeSettings();
    }
    if (catalogOpen() && !els.catalogPanel.contains(e.target) && !els.fabCatalog.contains(e.target)) {
      closeCatalog();
    }
  });
  /**
   * 视图尺寸变化(窗口缩放、侧边栏展开/收起)后修正悬浮球位置。
   * 拖动过的: 保留纵向位置与所在侧, 水平方向重新贴回正文两侧;
   * 未拖动的: 直接按新的阅读区域重算。
   */
  function syncFabOnResize() {
    // 尺寸变化后设置面板也要重新贴合工具栏并夹回视口内
    if (settingsOpen()) {
      positionSettingsPanel();
    }
    if (!fabDragged) {
      syncFabAnchor();
      return;
    }
    var left = parseFloat(els.fabs.style.left);
    var top = parseFloat(els.fabs.style.top);
    if (isNaN(left) || isNaN(top)) {
      return;
    }
    var mid = left + (els.fabs.offsetWidth || 58) / 2;
    var side = mid < window.innerWidth / 2 ? 'left' : 'right';
    var pos = snapFabPosition(side, top);
    applyFabPosition(pos);
    persistSettings({ fabLeft: pos.left, fabTop: pos.top });
  }

  window.addEventListener('resize', syncFabOnResize);
  // 侧边栏展开/收起不一定会触发 window resize, 用 ResizeObserver 兜底
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncFabOnResize).observe(document.body);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (catalogOpen()) { e.preventDefault(); closeCatalog(); return; }
      if (settingsOpen()) { e.preventDefault(); closeSettings(); return; }
    }
    // 设置面板里的滑块/下拉保留自身按键行为(方向键调值等)
    var tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') { return; }
    if (matchShortcut(state.prevCombo, e)) {
      e.preventDefault();
      gotoChapter(state.chapterIndex - 1);
      return;
    }
    if (matchShortcut(state.nextCombo, e)) {
      e.preventDefault();
      gotoChapter(state.chapterIndex + 1);
    }
  });

  // Ctrl(或 macOS 的 Cmd) + 滚轮: 放大 / 缩小字号
  // capture: true 让本监听尽早拿到事件并阻止浏览器页面缩放
  document.addEventListener(
    'wheel',
    function (e) {
      if (!e.ctrlKey && !e.metaKey) { return; }
      e.preventDefault();
      var cur = state.settings.fontSize || DEFAULT_SETTINGS.fontSize;
      var next = Math.min(32, Math.max(12, cur + (e.deltaY < 0 ? 1 : -1)));
      if (next !== cur) {
        persistSettings({ fontSize: next });
      }
    },
    { passive: false, capture: true }
  );

  /* ---------------- 消息 ---------------- */
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || !msg.type) { return; }
    switch (msg.type) {
      case 'init': {
        var p = msg.payload;
        state.novel = {
          totalChapters: p.totalChapters,
          totalWords: p.totalWords,
          bookTitle: p.bookTitle
        };
        document.title = p.bookTitle + ' - 小说阅读';
        state.chapters = p.chapters || [];
        state.catReverse = false;
        state.catCollapsed = [];
        els.catReverse.classList.remove('on');
        els.catReverse.textContent = '倒序';
        els.catSub.textContent = '共 ' + state.chapters.length + ' 章';
        els.catBody.innerHTML = ''; // 目录按需渲染(打开面板时)
        applySettings(p.settings);
        renderChapter({
          index: p.chapterIndex, title: p.chapterTitle,
          paragraphs: p.paragraphs, totalChapters: p.totalChapters,
          chapterWords: p.chapterWords || 0,
          scrollRatio: p.scrollRatio || 0
        });
        var words = p.totalWords >= 10000
          ? (p.totalWords / 10000).toFixed(1) + ' 万字'
          : p.totalWords + ' 字';
        els.bookInfo.textContent = p.bookTitle + (p.author ? ' · ' + p.author : '') +
          ' · 共 ' + p.totalChapters + ' 章 · 约 ' + words;
        if (p.openSettings) { openSettings(); }
        break;
      }
      case 'chapter':
        renderChapter(msg.payload);
        break;
      case 'settings':
        applySettings(msg.payload);
        break;
      case 'openSettings':
        openSettings();
        break;
    }
  });

  buildSettingsControls();
  applySettings(DEFAULT_SETTINGS);
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
