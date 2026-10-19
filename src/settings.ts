/**
 * settings.ts — 阅读偏好设置
 *
 * 数据源:
 *  - 默认值来自 package.json 的 contributes.configuration (novelReader.*)
 *  - 用户在阅读界面调整后的偏好写入 globalState, 优先于默认值
 *  - 用户在 VS Code 设置页修改时, 通过 onDidChangeConfiguration 同步覆盖
 */

import * as vscode from "vscode";
import { PROVINCES, DEFAULT_PROVINCE_CODE } from "./provinceColors";
import { SOLAR_TERMS, DEFAULT_TERM_ID } from "./solarTerms";

/**
 * 正文栏宽(px): 预设档位 + 合法区间。
 * 设置面板的档位按钮、拖拽手柄、后端 clamp 共用这一份定义(经虚拟模块注入 webview)。
 * 超过 1200 不设死上限 —— 由用户自定义, 窗口装不下时横向滚动。
 */
export const CONTENT_WIDTH = {
  min: 480,
  max: 4000,
  /** 预设档 = 视口宽度的比例(33.33% / 55.55% / 66.66% / 77.77%), 随窗口大小自适应 */
  ratios: [0.3333, 0.5555, 0.6666, 0.7777],
};

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
  /** 是否显示底部状态栏(默认显示; 由侧边菜单「状态栏」项切换) */
  showStatusBar: boolean;
  /** 正文栏宽: 视口宽度比例(0 = 关闭, 使用 contentWidth 的像素值) */
  widthRatio: number;
  /** 地域色彩主题: 省级行政区代码(见 provinceColors.ts), theme=province 时生效 */
  province: string;
  /** 廿四节气主题: 节气 id(见 solarTerms.ts), theme=term 时生效 */
  term: string;
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
  /** 次要文字色(设置面板标签/说明文字) */
  muted: string;
  /** 设置面板强调色(选中态描边、当前主题对勾等) */
  panelAccent: string;
  /** 面板悬停态底色 */
  panelHover: string;
}

export interface FontDef {
  id: string;
  name: string;
  stack: string;
}

// 主题色同步起点中文网: 纯净白 / 米白 / 羊皮纸 / 护眼绿 / 浅蓝 / 黑夜
// 黑夜按用户要求沿用原配色(深灰纸面 + 暖金主色)
export const THEMES: ThemeDef[] = [
  {
    id: "white",
    name: "纯净白",
    bg: "#ffffff",
    fg: "#262626",
    pageBg: "#f3f3f3",
    chromeBg: "#f7f7f7",
    chromeBorder: "#e4e4e4",
    accent: "#262626",
    accentFg: "#ffffff",
    muted: "#26262699",
    panelAccent: "#f56c6c",
    panelHover: "rgba(0,0,0,.05)",
  },
  {
    id: "beige",
    name: "米白",
    bg: "#f8f4ea",
    fg: "#33302a",
    pageBg: "#efe9db",
    chromeBg: "#f4f0e5",
    chromeBorder: "#e0d9c6",
    accent: "#33302a",
    accentFg: "#ffffff",
    muted: "#33302a99",
    panelAccent: "#f56c6c",
    panelHover: "rgba(0,0,0,.05)",
  },
  {
    id: "sepia",
    name: "羊皮纸",
    bg: "#f4e8cd",
    fg: "#4b3f2a",
    pageBg: "#eadbb4",
    chromeBg: "#f0e3c2",
    chromeBorder: "#dbc79c",
    accent: "#4b3f2a",
    accentFg: "#fdf6e3",
    muted: "#4b3f2a99",
    panelAccent: "#f56c6c",
    panelHover: "rgba(0,0,0,.05)",
  },
  {
    id: "green",
    name: "护眼绿",
    bg: "#d5ecd0",
    fg: "#2c3f2c",
    pageBg: "#c3e0ba",
    chromeBg: "#cde6c6",
    chromeBorder: "#a8cfa0",
    accent: "#2c3f2c",
    accentFg: "#f0fff2",
    muted: "#2c3f2c99",
    panelAccent: "#f56c6c",
    panelHover: "rgba(0,0,0,.05)",
  },
  {
    id: "blue",
    name: "浅蓝",
    bg: "#e4eef5",
    fg: "#2c3944",
    pageBg: "#d3e2ec",
    chromeBg: "#dfeaf2",
    chromeBorder: "#c3d5e1",
    accent: "#2c3944",
    accentFg: "#ffffff",
    muted: "#2c394499",
    panelAccent: "#f56c6c",
    panelHover: "rgba(0,0,0,.05)",
  },
  {
    id: "dark",
    name: "黑夜",
    bg: "#232323",
    fg: "#bababa",
    pageBg: "#141414",
    chromeBg: "#1c1c1c",
    chromeBorder: "#333333",
    accent: "#c9963f",
    accentFg: "#191919",
    muted: "#8a8a8a",
    panelAccent: "#c9963f",
    panelHover: "rgba(255,255,255,.08)",
  },
];

export const FONTS: FontDef[] = [
  {
    id: "system",
    name: "系统默认",
    stack:
      'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  },
  {
    id: "songti",
    name: "宋体",
    stack: '"SimSun", "Songti SC", "Noto Serif SC", serif',
  },
  {
    id: "heiti",
    name: "黑体",
    stack: '"SimHei", "Heiti SC", "Noto Sans SC", sans-serif',
  },
  {
    id: "kaiti",
    name: "楷体",
    stack: '"KaiTi", "Kaiti SC", "STKaiti", "Kai", serif',
  },
  {
    id: "fangsong",
    name: "仿宋",
    stack: '"FangSong", "FangSong_GB2312", "STFangsong", serif',
  },
  {
    id: "yahei",
    name: "微软雅黑",
    stack: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif',
  },
];

export const DEFAULT_SETTINGS: ReadingSettings = {
  fontSize: 16,
  fontFamily: "heiti",
  lineHeight: 1.8,
  paragraphSpacing: 0.8,
  theme: "sepia",
  contentWidth: 720,
  shortcutPrev: "alt+arrowleft",
  shortcutNext: "alt+arrowright",
  showStatusBar: true,

  widthRatio: 0,
  province: DEFAULT_PROVINCE_CODE,
  term: DEFAULT_TERM_ID,
};

const STORAGE_KEY = "novelReader.settings";
/** 书库目录(界面设置, 与 settings.json 的 novelReader.libraryPath 分离) */
const LIBRARY_KEY = "novelReader.libraryPath";
const SETTING_KEYS: (keyof ReadingSettings)[] = [
  "fontSize",
  "fontFamily",
  "lineHeight",
  "paragraphSpacing",
  "theme",
  "contentWidth",
  "shortcutPrev",
  "shortcutNext",
  "showStatusBar",

  "widthRatio",
  "province",
  "term",
];

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/** 读取 package.json 中声明的默认值 */
function configDefaults(): ReadingSettings {
  const cfg = vscode.workspace.getConfiguration("novelReader");
  return {
    fontSize: clamp(
      cfg.get<number>("fontSize", DEFAULT_SETTINGS.fontSize),
      12,
      32,
      DEFAULT_SETTINGS.fontSize,
    ),
    fontFamily: cfg.get<string>("fontFamily", DEFAULT_SETTINGS.fontFamily),
    lineHeight: clamp(
      cfg.get<number>("lineHeight", DEFAULT_SETTINGS.lineHeight),
      1.2,
      2.8,
      DEFAULT_SETTINGS.lineHeight,
    ),
    paragraphSpacing: clamp(
      cfg.get<number>("paragraphSpacing", DEFAULT_SETTINGS.paragraphSpacing),
      0,
      2,
      DEFAULT_SETTINGS.paragraphSpacing,
    ),
    theme: cfg.get<string>("theme", DEFAULT_SETTINGS.theme),
    contentWidth: clamp(
      cfg.get<number>("contentWidth", DEFAULT_SETTINGS.contentWidth),
      CONTENT_WIDTH.min,
      CONTENT_WIDTH.max,
      DEFAULT_SETTINGS.contentWidth,
    ),
    shortcutPrev: cfg.get<string>(
      "shortcutPrevChapter",
      DEFAULT_SETTINGS.shortcutPrev,
    ),
    shortcutNext: cfg.get<string>(
      "shortcutNextChapter",
      DEFAULT_SETTINGS.shortcutNext,
    ),
    showStatusBar: DEFAULT_SETTINGS.showStatusBar,

    widthRatio: 0,
    province: DEFAULT_SETTINGS.province,
    term: DEFAULT_SETTINGS.term,
  };
}

function sanitize(s: Partial<ReadingSettings>): Partial<ReadingSettings> {
  const out: Partial<ReadingSettings> = {};
  if (typeof s.showStatusBar === "boolean") {
    out.showStatusBar = s.showStatusBar;
  }
  if (typeof s.fontSize === "number") {
    out.fontSize = clamp(s.fontSize, 12, 32, DEFAULT_SETTINGS.fontSize);
  }
  if (typeof s.fontFamily === "string") {
    // 旧字体值迁移: 设置面板已改为 黑体/宋体/楷体 三选项(起点风格)
    const legacy: Record<string, string> = {
      system: "heiti",
      yahei: "heiti",
      fangsong: "songti",
    };
    const fid = legacy[s.fontFamily] ?? s.fontFamily;
    if (FONTS.some((f) => f.id === fid)) {
      out.fontFamily = fid;
    }
  }
  if (typeof s.lineHeight === "number") {
    out.lineHeight = clamp(s.lineHeight, 1.2, 2.8, DEFAULT_SETTINGS.lineHeight);
  }
  if (typeof s.paragraphSpacing === "number") {
    out.paragraphSpacing = clamp(
      s.paragraphSpacing,
      0,
      2,
      DEFAULT_SETTINGS.paragraphSpacing,
    );
  }
  // 主题白名单: 6 个预设 + province(地域色彩, 不在 THEMES 里但合法)
  if (typeof s.theme === "string" && (s.theme === "province" || s.theme === "term" || THEMES.some((t) => t.id === s.theme))) {
    out.theme = s.theme;
  }
  if (typeof s.widthRatio === "number" && isFinite(s.widthRatio) && s.widthRatio >= 0 && s.widthRatio <= 1) {
    // 只接受预设比例或 0(自定义像素)
    out.widthRatio = CONTENT_WIDTH.ratios.indexOf(s.widthRatio) >= 0 ? s.widthRatio : (s.widthRatio === 0 ? 0 : out.widthRatio || 0);
  }
  if (typeof s.province === "string" && PROVINCES.some((p) => p.code === s.province)) {
    out.province = s.province;
  }
  if (typeof s.term === "string" && SOLAR_TERMS.some((t) => t.id === s.term)) {
    out.term = s.term;
  }
  if (typeof s.contentWidth === "number") {
    out.contentWidth = clamp(
      s.contentWidth,
      CONTENT_WIDTH.min,
      CONTENT_WIDTH.max,
      DEFAULT_SETTINGS.contentWidth,
    );
  }
  if (typeof s.fabLeft === "number") {
    out.fabLeft = Math.round(s.fabLeft);
  }
  if (typeof s.fabTop === "number") {
    out.fabTop = Math.round(s.fabTop);
  }
  if (typeof s.shortcutPrev === "string") {
    out.shortcutPrev = s.shortcutPrev;
  }
  if (typeof s.shortcutNext === "string") {
    out.shortcutNext = s.shortcutNext;
  }
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
  async applyConfigurationChange(
    e: vscode.ConfigurationChangeEvent,
  ): Promise<ReadingSettings | null> {
    const patch: Partial<ReadingSettings> = {};
    const cfg = vscode.workspace.getConfiguration("novelReader");
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
    if (typeof stored === "string") {
      return stored.trim();
    }
    const fromConfig = vscode.workspace
      .getConfiguration("novelReader")
      .get<string>("libraryPath", "");
    return (fromConfig || "").trim();
  }

  /** 保存书库目录(传空字符串表示恢复"读取原路径") */
  async setLibraryPath(dir: string): Promise<void> {
    await this.state.update(LIBRARY_KEY, (dir || "").trim());
  }
}

export function themeById(id: string, provinceCode?: string, termId?: string): ThemeDef {
  if (id === "province") {
    return provinceTheme(provinceCode);
  }
  if (id === "term") {
    return termTheme(termId);
  }
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// ---------------------------------------------------------------- 地域色彩主题
//
// 设计要点: 省份色卡是"取自实物的原色"(故宫红/琉璃黄/天坛蓝...), 直接当背景
// 必然出现文字不可读。所以只用它推导"色相", 明度一律由算法锁定:
//   - 纸面/留白: 取该省主色相, 压到极浅(明度 0.91~0.96) -> 深色字始终清晰
//   - 正文色: 同色相压到很深(明度 0.16) -> 与纸面对比度通常在 12:1 以上
//   - 强调色: 原色若与纸面对比不足 4.5:1 则逐步压暗, 保证图标/当前章可辨认
// 这样 34 个省都能得到"有地域色相但可长时间阅读"的配色。

function hexToRgbTriple(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    return [0, 0, 0];
  }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** rgb -> {h:0~360, s:0~1, l:0~1} */
function rgbToHsl([r, g, b]: [number, number, number]): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return { h: 0, s: 0, l };
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const lig = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) {
    rgb = [c, x, 0];
  } else if (hue < 120) {
    rgb = [x, c, 0];
  } else if (hue < 180) {
    rgb = [0, c, x];
  } else if (hue < 240) {
    rgb = [0, x, c];
  } else if (hue < 300) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

/** WCAG 相对亮度 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgbTriple(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度(1~21) */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 取该省"代表色"作为色相来源。
 * 优先用色卡首项(数据按"最具代表性"排序, 如北京=故宫红), 但首项若是近白/近黑
 * 则色相不可靠, 退而取饱和度最高且明度适中的那个。
 */
function pickRepresentative(colors: { hex: string }[]): { hex: string } {
  const first = colors[0];
  if (first) {
    const hsl = rgbToHsl(hexToRgbTriple(first.hex));
    if (hsl.s >= 0.12 && hsl.l >= 0.15 && hsl.l <= 0.82) {
      return first;
    }
  }
  let best: { hex: string } | null = null;
  let bestScore = -1;
  for (const c of colors) {
    const hsl = rgbToHsl(hexToRgbTriple(c.hex));
    if (hsl.l < 0.15 || hsl.l > 0.82) {
      continue;
    }
    const score = hsl.s;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best || first || { hex: "#8A8A8A" };
}

/** 把强调色压暗到与纸面对比度达标(默认 4.5:1, 正文级) */
function ensureContrast(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) {
    return fg;
  }
  const hsl = rgbToHsl(hexToRgbTriple(fg));
  let l = hsl.l;
  for (let i = 0; i < 40 && l > 0.06; i += 1) {
    l -= 0.02;
    const next = hslToHex(hsl.h, hsl.s, l);
    if (contrastRatio(next, bg) >= target) {
      return next;
    }
  }
  return hslToHex(hsl.h, hsl.s, 0.12);
}

/**
 * 按省份推导完整的阅读色板。
 * @param provinceCode 省级行政区代码(如 110000); 缺省用北京
 */
/**
 * 由"一个代表色 + 主题名"生成完整阅读色板(地域色彩 / 廿四节气共用)。
 * 只借色相, 明度饱和度由算法锁定; 强调色对比度不足则自动压暗。
 */
function paintTheme(repHex: string, name: string, id: string): ThemeDef {
  const h = rgbToHsl(hexToRgbTriple(repHex)).h;
  // 纸面/留白/面板: 同一色相不同明度(层次可辨), 饱和度取到"看得出地域色、又不喧宾夺主"
  // 注: 明度不能太高(>0.96 时不同色相在 8bit 下会被量化成同一个颜色, 省份之间就没区别了);
  //     地域辨识度主要由留白区(pageBg)承担, 纸面保持偏白的"纸感"
  const bg = hslToHex(h, 0.26, 0.925);
  const pageBg = hslToHex(h, 0.3, 0.85);
  const chromeBg = hslToHex(h, 0.24, 0.915);
  const chromeBorder = hslToHex(h, 0.32, 0.76);
  // 正文/次要文字: 深色。次要文字同样要过对比度门槛(4.5:1), 不够就自动加暗
  const fg = hslToHex(h, 0.32, 0.16);
  const muted = ensureContrast(hslToHex(h, 0.12, 0.44), bg, 4.5);
  // 强调色: 代表色压暗到达标(与纸面同色相, 整体协调)
  const rawPrimary = repHex;
  const accent = ensureContrast(rawPrimary, bg, 4.5);
  const accentFg = contrastRatio("#ffffff", accent) >= 3 ? "#ffffff" : "#1a1a1a";
  return {
    id,
    name,
    bg,
    fg,
    pageBg,
    chromeBg,
    chromeBorder,
    accent,
    accentFg,
    muted,
    panelAccent: ensureContrast(rawPrimary, chromeBg, 3),
    panelHover: hslToHex(h, 0.18, 0.9),
  };
}

export function provinceTheme(provinceCode?: string): ThemeDef {
  const region =
    PROVINCES.find((p) => p.code === provinceCode) ??
    PROVINCES.find((p) => p.code === DEFAULT_PROVINCE_CODE) ??
    PROVINCES[0];
  const colors = region && region.colors.length > 0 ? region.colors : [{ hex: "#8A8A8A" }];
  return paintTheme(pickRepresentative(colors).hex, region ? region.name : "地域色彩", "province");
}

/** 廿四节气主题: 用该节气的代表色推导色板 */
export function termTheme(termId?: string): ThemeDef {
  const term =
    SOLAR_TERMS.find((t) => t.id === termId) ??
    SOLAR_TERMS.find((t) => t.id === DEFAULT_TERM_ID) ??
    SOLAR_TERMS[0];
  return paintTheme(term ? term.hex : "#8A8A8A", term ? term.name : "二十四节气", "term");
}

export function fontStackById(id: string): string {
  return (FONTS.find((f) => f.id === id) ?? FONTS[0]).stack;
}
