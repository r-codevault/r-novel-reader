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

export const THEMES: ThemeDef[] = [
    // 米黄纸: 暖米色纸面 + 更深的米色留白, 赭色主色
    { id: 'sepia', name: '米黄纸', bg: '#f5ecd7', fg: '#4b3f2a', pageBg: '#e6d5ae', chromeBg: '#efe3c4', chromeBorder: '#d6c395', accent: '#a3652a', accentFg: '#fdf6e3' },
    // 护眼绿: 淡绿纸面 + 深一档的绿留白
    { id: 'green', name: '护眼绿', bg: '#c7edcc', fg: '#274b27', pageBg: '#a5d2ac', chromeBg: '#b8e2bf', chromeBorder: '#8cc094', accent: '#2e7d43', accentFg: '#f0fff2' },
    // 纯净白: 白纸面 + 浅灰蓝留白
    { id: 'white', name: '纯净白', bg: '#ffffff', fg: '#333333', pageBg: '#e8ecf1', chromeBg: '#f2f5f8', chromeBorder: '#d3dae2', accent: '#3567c4', accentFg: '#ffffff' },
    // 简约灰: 灰纸面 + 更深的暖灰留白
    { id: 'gray', name: '简约灰', bg: '#e4e2dc', fg: '#3c3a36', pageBg: '#c9c6be', chromeBg: '#d8d5ce', chromeBorder: '#b5b1a8', accent: '#5d594f', accentFg: '#f5f3ee' },
    // 暗夜: 深灰纸面 + 近黑留白, 暖金主色
    { id: 'dark', name: '暗夜', bg: '#232323', fg: '#bababa', pageBg: '#141414', chromeBg: '#1c1c1c', chromeBorder: '#333333', accent: '#c9963f', accentFg: '#191919' },
    // 墨黑: 纯黑留白 + 近黑纸面
    { id: 'ink', name: '墨黑', bg: '#0d0d0d', fg: '#9e9e9e', pageBg: '#000000', chromeBg: '#060606', chromeBorder: '#262626', accent: '#8a8a8a', accentFg: '#0d0d0d' },
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
    fontFamily: 'system',
    lineHeight: 1.8,
    paragraphSpacing: 0.8,
    theme: 'sepia',
    contentWidth: 720,
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
    };
}

function sanitize(s: Partial<ReadingSettings>): Partial<ReadingSettings> {
    const out: Partial<ReadingSettings> = {};
    if (typeof s.fontSize === 'number') {
        out.fontSize = clamp(s.fontSize, 12, 32, DEFAULT_SETTINGS.fontSize);
    }
    if (typeof s.fontFamily === 'string' && FONTS.some((f) => f.id === s.fontFamily)) {
        out.fontFamily = s.fontFamily;
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
