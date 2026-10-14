/**
 * settings.ts — 阅读偏好设置
 *
 * 数据源:
 *  - 默认值来自 package.json 的 contributes.configuration (novelReader.*)
 *  - 用户在阅读界面调整后的偏好写入 globalState, 优先于默认值
 *  - 用户在 VS Code 设置页修改时, 通过 onDidChangeConfiguration 同步覆盖
 */

import * as vscode from 'vscode';

export interface ReadingSettings {
    /** 正文字号(px) */
    fontSize: number;
    /** 字体族 id, 见 FONTS */
    fontFamily: string;
    /** 行距倍数 */
    lineHeight: number;
    /** 段距(em) */
    paragraphSpacing: number;
    /** 主题 id, 见 THEMES */
    theme: string;
    /** 阅读区最大宽度(px) */
    contentWidth: number;
    /** 悬浮球位置(拖动后记录; -1 表示"跟随阅读区域"的默认位置) */
    fabLeft?: number;
    fabTop?: number;
    /** 上一章快捷键(如 alt+arrowleft; 在阅读页内生效, 留空禁用) */
    shortcutPrev: string;
    /** 下一章快捷键(如 alt+arrowright) */
    shortcutNext: string;
}

export interface ThemeDef {
    id: string;
    name: string;
    /** 阅读区背景色 */
    bg: string;
    /** 正文文字色 */
    fg: string;
    /** 留白区域底色(正文"纸面"四周, 与 bg 区分出层次) */
    pageBg: string;
    /** 面板/状态栏底色(设置面板、目录面板、悬浮球等) */
    chromeBg: string;
    /** 面板/状态栏边框色 */
    chromeBorder: string;
    /** 主题主色(悬浮球、进度条、当前章高亮) */
    accent: string;
    /** 主色上的文字色 */
    accentFg: string;
}

export interface FontDef {
    id: string;
    name: string;
    stack: string;
}

// 主题色同步起点中文网: 纯净白 / 米白 / 羊皮纸 / 护眼绿 / 浅蓝 / 黑夜
// 黑夜按用户要求沿用原配色(深灰纸面 + 暖金主色)
export const THEMES: ThemeDef[] = [
    { id: 'white', name: '纯净白', bg: '#ffffff', fg: '#262626', pageBg: '#f3f3f3', chromeBg: '#f7f7f7', chromeBorder: '#e4e4e4', accent: '#f56c6c', accentFg: '#ffffff' },
    { id: 'beige', name: '米白', bg: '#f8f4ea', fg: '#33302a', pageBg: '#efe9db', chromeBg: '#f4f0e5', chromeBorder: '#e0d9c6', accent: '#f56c6c', accentFg: '#ffffff' },
    { id: 'sepia', name: '羊皮纸', bg: '#f4e8cd', fg: '#4b3f2a', pageBg: '#eadbb4', chromeBg: '#f0e3c2', chromeBorder: '#dbc79c', accent: '#f56c6c', accentFg: '#ffffff' },
    { id: 'green', name: '护眼绿', bg: '#d5ecd0', fg: '#2c3f2c', pageBg: '#c3e0ba', chromeBg: '#cde6c6', chromeBorder: '#a8cfa0', accent: '#f56c6c', accentFg: '#ffffff' },
    { id: 'blue', name: '浅蓝', bg: '#e4eef5', fg: '#2c3944', pageBg: '#d3e2ec', chromeBg: '#dfeaf2', chromeBorder: '#c3d5e1', accent: '#f56c6c', accentFg: '#ffffff' },
    { id: 'dark', name: '黑夜', bg: '#232323', fg: '#bababa', pageBg: '#141414', chromeBg: '#1c1c1c', chromeBorder: '#333333', accent: '#c9963f', accentFg: '#191919' },
];

export const FONTS: FontDef[] = [
    {
        id: 'system',
        name: '系统默认',
        stack: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
    },
    { id: 'songti', name: '宋体', stack: '"SimSun", "Songti SC", "Noto Serif SC", serif' },
    { id: 'heiti', name: '黑体', stack: '"SimHei", "Heiti SC", "Noto Sans SC", sans-serif' },
    { id: 'kaiti', name: '楷体', stack: '"KaiTi", "Kaiti SC", "STKaiti", "Kai", serif' },
    { id: 'fangsong', name: '仿宋', stack: '"FangSong", "FangSong_GB2312", "STFangsong", serif' },
    {
        id: 'yahei',
        name: '微软雅黑',
        stack: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif',
    },
];

export const DEFAULT_SETTINGS: ReadingSettings = {
    fontSize: 16,
    fontFamily: 'heiti',
    lineHeight: 1.8,
    paragraphSpacing: 0.8,
    theme: 'sepia',
    contentWidth: 720,
    shortcutPrev: 'alt+arrowleft',
    shortcutNext: 'alt+arrowright',
};

const STORAGE_KEY = 'novelReader.settings';
/** 书库目录(界面设置, 与 settings.json 的 novelReader.libraryPath 分离) */
const LIBRARY_KEY = 'novelReader.libraryPath';
const SETTING_KEYS: (keyof ReadingSettings)[] = [
    'fontSize',
    'fontFamily',
    'lineHeight',
    'paragraphSpacing',
    'theme',
    'contentWidth',
    'shortcutPrev',
    'shortcutNext',
];

function clamp(n: number, min: number, max: number, fallback: number): number {
    if (typeof n !== 'number' || Number.isNaN(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

/** 读取 package.json 中声明的默认值 */
function configDefaults(): ReadingSettings {
    const cfg = vscode.workspace.getConfiguration('novelReader');
    return {
        fontSize: clamp(cfg.get<number>('fontSize', DEFAULT_SETTINGS.fontSize), 12, 32, DEFAULT_SETTINGS.fontSize),
        fontFamily: cfg.get<string>('fontFamily', DEFAULT_SETTINGS.fontFamily),
        lineHeight: clamp(cfg.get<number>('lineHeight', DEFAULT_SETTINGS.lineHeight), 1.2, 2.8, DEFAULT_SETTINGS.lineHeight),
        paragraphSpacing: clamp(
            cfg.get<number>('paragraphSpacing', DEFAULT_SETTINGS.paragraphSpacing),
            0,
            2,
            DEFAULT_SETTINGS.paragraphSpacing
        ),
        theme: cfg.get<string>('theme', DEFAULT_SETTINGS.theme),
        contentWidth: clamp(cfg.get<number>('contentWidth', DEFAULT_SETTINGS.contentWidth), 480, 1200, DEFAULT_SETTINGS.contentWidth),
        shortcutPrev: cfg.get<string>('shortcutPrevChapter', DEFAULT_SETTINGS.shortcutPrev),
        shortcutNext: cfg.get<string>('shortcutNextChapter', DEFAULT_SETTINGS.shortcutNext),
    };
}

function sanitize(s: Partial<ReadingSettings>): Partial<ReadingSettings> {
    const out: Partial<ReadingSettings> = {};
    if (typeof s.fontSize === 'number') {
        out.fontSize = clamp(s.fontSize, 12, 32, DEFAULT_SETTINGS.fontSize);
    }
    if (typeof s.fontFamily === 'string') {
        // 旧字体值迁移: 设置面板已改为 黑体/宋体/楷体 三选项(起点风格)
        const legacy: Record<string, string> = { system: 'heiti', yahei: 'heiti', fangsong: 'songti' };
        const fid = legacy[s.fontFamily] ?? s.fontFamily;
        if (FONTS.some((f) => f.id === fid)) {
            out.fontFamily = fid;
        }
    }
    if (typeof s.lineHeight === 'number') {
        out.lineHeight = clamp(s.lineHeight, 1.2, 2.8, DEFAULT_SETTINGS.lineHeight);
    }
    if (typeof s.paragraphSpacing === 'number') {
        out.paragraphSpacing = clamp(s.paragraphSpacing, 0, 2, DEFAULT_SETTINGS.paragraphSpacing);
    }
    if (typeof s.theme === 'string' && THEMES.some((t) => t.id === s.theme)) {
        out.theme = s.theme;
    }
    if (typeof s.contentWidth === 'number') {
        out.contentWidth = clamp(s.contentWidth, 480, 1200, DEFAULT_SETTINGS.contentWidth);
    }
    if (typeof s.fabLeft === 'number') { out.fabLeft = Math.round(s.fabLeft); }
    if (typeof s.fabTop === 'number') { out.fabTop = Math.round(s.fabTop); }
    if (typeof s.shortcutPrev === 'string') { out.shortcutPrev = s.shortcutPrev; }
    if (typeof s.shortcutNext === 'string') { out.shortcutNext = s.shortcutNext; }
    return out;
}

export class SettingsStore {
    constructor(private readonly state: vscode.Memento) {}

    /** 生效中的设置: globalState 覆盖项优先, 缺省回落到 configuration 默认值 */
    get(): ReadingSettings {
        const stored = this.state.get<Partial<ReadingSettings>>(STORAGE_KEY, {});
        return { ...configDefaults(), ...sanitize(stored) };
    }

    /** 保存偏好(阅读界面调用), 返回合并后的完整设置 */
    async update(patch: Partial<ReadingSettings>): Promise<ReadingSettings> {
        const next: ReadingSettings = { ...this.get(), ...sanitize(patch) };
        await this.state.update(STORAGE_KEY, next);
        return next;
    }

    /** 恢复默认(清除所有覆盖项) */
    async reset(): Promise<ReadingSettings> {
        await this.state.update(STORAGE_KEY, undefined);
        return configDefaults();
    }

    /** VS Code 设置页发生变化时同步(extension.ts 的 onDidChangeConfiguration 调用) */
    async applyConfigurationChange(e: vscode.ConfigurationChangeEvent): Promise<ReadingSettings | null> {
        const patch: Partial<ReadingSettings> = {};
        const cfg = vscode.workspace.getConfiguration('novelReader');
        for (const key of SETTING_KEYS) {
            if (e.affectsConfiguration(`novelReader.${key}`)) {
                (patch as Record<string, unknown>)[key] = cfg.get(key);
            }
        }
        if (Object.keys(patch).length === 0) {
            return null;
        }
        return this.update(patch);
    }

    /**
     * 书库目录(空 = 未设置, 直接读取文件原路径)。
     * 优先级: 界面设置(globalState) > settings.json 的 novelReader.libraryPath。
     * 用 globalState 落盘可以避开"配置未注册时 update() 被拒"的问题
     * (更新扩展后仅重载窗口, 新增的配置项可能尚未注册)。
     */
    getLibraryPath(): string {
        const stored = this.state.get<string | undefined>(LIBRARY_KEY);
        if (typeof stored === 'string') {
            return stored.trim();
        }
        const fromConfig = vscode.workspace.getConfiguration('novelReader').get<string>('libraryPath', '');
        return (fromConfig || '').trim();
    }

    /** 保存书库目录(传空字符串表示恢复"读取原路径") */
    async setLibraryPath(dir: string): Promise<void> {
        await this.state.update(LIBRARY_KEY, (dir || '').trim());
    }
}

export function themeById(id: string): ThemeDef {
    return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function fontStackById(id: string): string {
    return (FONTS.find((f) => f.id === id) ?? FONTS[0]).stack;
}
