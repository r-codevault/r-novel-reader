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
import { FESTIVALS, DEFAULT_FESTIVAL_ID } from "./festivals";

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
  /** 重开 VS Code 时是否恢复上次打开的阅读页(关闭则丢弃 VS Code 恢复的阅读页 Tab) */
  restoreOnStartup: boolean;
  /** 正文栏宽: 视口宽度比例(0 = 关闭, 使用 contentWidth 的像素值) */
  widthRatio: number;
  /** 地域色彩主题: 省级行政区代码(见 provinceColors.ts), theme=province 时生效 */
  province: string;
  /** 廿四节气主题: 节气 id(见 solarTerms.ts), theme=term 时生效 */
  term: string;
  /** 传统节日主题: 节日 id(见 festivals.ts, 含 -night 后缀), theme=festival 时生效 */
  festival: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  /** 阅读区背景色(纸面) */
  bg: string;
  /** 正文文字色 */
  fg: string;
  /** 留白区域底色(正文"纸面"四周, 与 bg 至少差 1.25:1 才有层次) */
  pageBg: string;
  /** 面板/状态栏/侧栏底色(比 bg 暗一档, 与 pageBg 再暗一档) */
  chromeBg: string;
  /** 装饰性边框/分隔线: 只做分割, 不承担"可识别控件边界"的职责(约 1.55:1) */
  chromeBorder: string;
  /** 结构性边框: 输入框/按钮/主题色点/进度条槽, 对 chromeBg ≥ 3:1 (WCAG 1.4.11) */
  borderStrong: string;
  /** 主题强调色: 同时满足「作文字对 pageBg ≥4.5:1」与「作底色时 accentFg 可读」 */
  accent: string;
  /** 强调色上的文字色(对 accent ≥4.5:1) */
  accentFg: string;
  /** 次要文字色: 实色, 对 chromeBg ≥4.5:1。禁止再叠加 opacity */
  muted: string;
  /** 面板悬停态底色 */
  panelHover: string;
  /** 危险操作色(删除等), 对 bg ≥4.5:1 */
  danger: string;
  /** 浮层/纸面投影颜色(深色主题需更重, 否则投影不可见) */
  shadow: string;
  /** 深色主题: 明度推导方向相反 */
  isDark?: boolean;
}

export interface FontDef {
  id: string;
  name: string;
  stack: string;
}

// 主题色同步起点中文网: 纯净白 / 米白 / 羊皮纸 / 护眼绿 / 浅蓝 / 黑夜
// 黑夜沿用深灰纸面 + 暖金主色。
//
// 2026-10 配色重构(依据 docs/color-audit.html):
//  - 取消"固定品牌红 panelAccent", 强调色回到各自主题的色相, 七套主题共用一条规则;
//  - 强调色统一按「作文字压在留白区(pageBg)上 ≥4.5:1」校准, 一个 accent 令牌通吃
//    高亮文字 / 按钮底 / 进度条 / 焦点框, 不再需要第二枚强调色;
//  - 次要文字改实色(原先 #RRGGBBAA 叠在底色上, 实测只有 3.07~4.12:1);
//  - 背景拆成三级台阶: 纸面 bg → 侧栏 chromeBg → 留白 pageBg, 逐级变暗;
//  - 边框拆成两支: chromeBorder(装饰, ~1.55:1) 与 borderStrong(控件边界, ≥3:1);
//  - 新增 danger / shadow, 让删除色与投影也跟随主题。
export const THEMES: ThemeDef[] = [
  {
    id: "white",
    name: "纯净白",
    bg: "#ffffff",
    fg: "#262626",
    pageBg: "#e9e6e0",
    chromeBg: "#f2f0eb",
    chromeBorder: "#c5c3b6",
    borderStrong: "#928978",
    accent: "#b83729",
    accentFg: "#ffffff",
    muted: "#6e6d67",
    panelHover: "rgba(0,0,0,.05)",
    danger: "#8f1d16",
    shadow: "rgba(0,0,0,.10)",
  },
  {
    id: "beige",
    name: "米白",
    bg: "#f8f4ea",
    fg: "#33302a",
    pageBg: "#e2dbc9",
    chromeBg: "#f2ecdd",
    chromeBorder: "#c9bfa5",
    borderStrong: "#95865e",
    accent: "#8c4423",
    accentFg: "#ffffff",
    muted: "#6e6b62",
    panelHover: "rgba(0,0,0,.05)",
    danger: "#8f1d16",
    shadow: "rgba(0,0,0,.10)",
  },
  {
    id: "xuan",
    name: "宣纸",
    bg: "#f7f5ec",
    fg: "#33302a",
    pageBg: "#e7e3d5",
    chromeBg: "#efece0",
    chromeBorder: "#c7bda4",
    borderStrong: "#92815f",
    accent: "#835529",
    accentFg: "#ffffff",
    muted: "#6d695d",
    panelHover: "rgba(0,0,0,.045)",
    danger: "#8c1d18",
    shadow: "rgba(0,0,0,.12)",
  },
  {
    id: "sepia",
    name: "羊皮纸",
    bg: "#f4e8cd",
    fg: "#4b3f2a",
    pageBg: "#dfcfa6",
    chromeBg: "#eee1c0",
    chromeBorder: "#c5b58e",
    borderStrong: "#917f51",
    accent: "#8d3f22",
    accentFg: "#ffffff",
    muted: "#6e634f",
    panelHover: "rgba(0,0,0,.05)",
    danger: "#8c1d18",
    shadow: "rgba(0,0,0,.13)",
  },
  {
    id: "green",
    name: "护眼绿",
    bg: "#d5ecd0",
    fg: "#2c3f2c",
    pageBg: "#b9d5ae",
    chromeBg: "#cbe5c3",
    chromeBorder: "#9eba94",
    borderStrong: "#64875b",
    accent: "#2b6135",
    accentFg: "#ffffff",
    muted: "#53674e",
    panelHover: "rgba(0,0,0,.05)",
    danger: "#8c1d18",
    shadow: "rgba(0,0,0,.13)",
  },
  {
    id: "blue",
    name: "浅蓝",
    bg: "#e4eef5",
    fg: "#2c3944",
    pageBg: "#c5d7e3",
    chromeBg: "#dae7ef",
    chromeBorder: "#aabdcb",
    borderStrong: "#68879a",
    accent: "#2c5a8a",
    accentFg: "#ffffff",
    muted: "#5b6872",
    panelHover: "rgba(0,0,0,.05)",
    danger: "#8c1d18",
    shadow: "rgba(0,0,0,.13)",
  },
  {
    id: "dark",
    name: "黑夜",
    bg: "#232323",
    fg: "#bababa",
    pageBg: "#121212",
    chromeBg: "#1c1c1c",
    chromeBorder: "#433c3c",
    borderStrong: "#756a6a",
    accent: "#d8a84e",
    accentFg: "#191919",
    muted: "#8a8a8a",
    panelHover: "rgba(255,255,255,.08)",
    danger: "#ff9d93",
    shadow: "rgba(0,0,0,.55)",
    isDark: true,
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

  // 默认 true: 上次退出时阅读页开着, 重开窗口就原样恢复(章节+章内位置)。
  // 与"启动自动弹窗"无关 —— 全新窗口没有可恢复的 Tab, 压根不会走恢复流程。
  restoreOnStartup: true,
  widthRatio: 0,
  province: DEFAULT_PROVINCE_CODE,
  term: DEFAULT_TERM_ID,
  festival: DEFAULT_FESTIVAL_ID,
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

  "restoreOnStartup",
  "widthRatio",
  "province",
  "term",
  "festival",
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

    restoreOnStartup: DEFAULT_SETTINGS.restoreOnStartup,
    widthRatio: 0,
    province: DEFAULT_SETTINGS.province,
    term: DEFAULT_SETTINGS.term,
    festival: DEFAULT_SETTINGS.festival,
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
  // 主题白名单: 6 个预设 + province(地域色彩) / term(廿四节气) / festival(传统节日)
  // —— 漏放行会导致"设置静默不生效"(历史踩坑点)
  if (typeof s.theme === "string" && (s.theme === "province" || s.theme === "term" || s.theme === "festival" || THEMES.some((t) => t.id === s.theme))) {
    out.theme = s.theme;
  }
  if (typeof s.restoreOnStartup === "boolean") {
    out.restoreOnStartup = s.restoreOnStartup;
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
  if (typeof s.festival === "string" && FESTIVALS.some((f) => f.id === s.festival)) {
    out.festival = s.festival;
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

/**
 * 主题分发: 预设 / 地域色彩 / 廿四节气 / 传统节日。
 * 第 2~4 参可缺省 —— 旧的 1~3 参调用(如 themeById('sepia'))行为完全不变。
 */
export function themeById(
  id: string,
  provinceCode?: string,
  termId?: string,
  festivalId?: string,
): ThemeDef {
  if (id === "province") {
    return provinceTheme(provinceCode);
  }
  if (id === "term") {
    return termTheme(termId);
  }
  if (id === "festival") {
    return festivalTheme(festivalId);
  }
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// ---------------------------------------------------------------- 地域色彩主题
//
// 设计要点: 省份色卡是"取自实物的原色"(故宫红/琉璃黄/天坛蓝...), 直接当背景
// 必然出现文字不可读。所以只用它推导"色相", 明度一律由算法锁定:
//   - 纸面/留白: 取该省主色相, 压到极浅(明度 0.91~0.96) -> 深色字始终清晰
//   - 正文色: 同色相压到很深(明度 0.16) -> 与纸面对比度通常在 12:1 以上
//   - 强调色: 原色若与留白区对比不足 4.5:1 则逐步压暗, 保证文字型高亮可辨认
// 这样 58 套(省 + 节气)都能得到"有地域色相但可长时间阅读"的配色。

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

/**
 * 解析颜色: 支持 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba()。
 * 返回 [r, g, b, a]，r/g/b 为 0~255，a 为 0~1。
 */
function parseColor(input: string): [number, number, number, number] {
  const s = (input || "").trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h.split("").map((c) => c + c).join("");
    }
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(",").map((v) => v.trim());
    const num = (v: string, max: number): number =>
      v.endsWith("%") ? (parseFloat(v) / 100) * max : parseFloat(v);
    return [
      num(parts[0], 255),
      num(parts[1], 255),
      num(parts[2], 255),
      parts[3] === undefined ? 1 : num(parts[3], 1),
    ];
  }
  return [0, 0, 0, 1];
}

/** 把带透明度的前景色合成到背景上(alpha 混合) */
function composite(fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

function rgbToHslOf(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = parseColor(hex);
  return rgbToHsl([r, g, b]);
}

/** WCAG 相对亮度(带 alpha 时先合成到不透明白底) */
function relativeLuminance(color: string, backdrop = "#ffffff"): number {
  const c = parseColor(color);
  const base = parseColor(backdrop);
  const solid = c[3] < 1 ? composite(c, base) : c;
  const [r, g, b] = solid.slice(0, 3).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 对比度(1~21)。
 * 支持 #RRGGBBAA 与 rgba(): 前景带 alpha 时按 bg 合成后再算,
 * 背景带 alpha 时按白底合成 —— 与浏览器实际渲染一致。
 */
export function contrastRatio(fg: string, bg: string): number {
  const bgColor = parseColor(bg);
  const bgSolid = bgColor[3] < 1 ? composite(bgColor, [255, 255, 255, 1]) : bgColor;
  const fgColor = parseColor(fg);
  const fgSolid = fgColor[3] < 1 ? composite(fgColor, bgSolid) : fgColor;
  const lumOf = (c: [number, number, number, number]): number => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lumOf(fgSolid);
  const b = lumOf(bgSolid);
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
    const hsl = rgbToHslOf(first.hex);
    if (hsl.s >= 0.12 && hsl.l >= 0.15 && hsl.l <= 0.82) {
      return first;
    }
  }
  let best: { hex: string } | null = null;
  let bestScore = -1;
  for (const c of colors) {
    const hsl = rgbToHslOf(c.hex);
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

/**
 * 把颜色推到与目标底色的对比度达标。
 * 方向自动判断: 底色偏暗就提亮, 偏亮就压暗 —— 深色主题的边框必须比底更亮,
 * 否则沿用"只压暗"的旧逻辑会得到一个几乎看不见的近黑线。
 */
function ensureContrast(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) >= target) {
    return fg;
  }
  const hsl = rgbToHslOf(fg);
  const bgIsDark = relativeLuminance(bg) < 0.18;
  const step = bgIsDark ? 0.01 : -0.01;
  let l = hsl.l;
  for (let i = 0; i < 100; i += 1) {
    l += step;
    if (l <= 0.02 || l >= 0.98) {
      break;
    }
    const next = hslToHex(hsl.h, hsl.s, l);
    if (contrastRatio(next, bg) >= target) {
      return next;
    }
  }
  return bgIsDark ? hslToHex(hsl.h, hsl.s, 0.96) : hslToHex(hsl.h, hsl.s, 0.12);
}

/**
 * 由"一个代表色 + 主题名"生成完整阅读色板(地域色彩 / 廿四节气共用)。
 *
 * 与预设主题共用同一套硬约束(2026-10 重构后):
 *   正文 fg / bg ≥ 11:1      次要 muted / chromeBg ≥ 4.5:1
 *   强调 accent / pageBg ≥ 4.5:1(作文字), accentFg / accent ≥ 4.5:1
 *   控件边框 borderStrong / chromeBg ≥ 3:1, 装饰线 chromeBorder / chromeBg ≈ 1.55:1
 *   危险色 danger / bg ≥ 4.5:1
 * 明度/饱和度全部锁定, 只借代表色的色相, 因此 58 套派生主题都能长时间阅读。
 */
function paintTheme(repHex: string, name: string, id: string): ThemeDef {
  const h = rgbToHslOf(repHex).h;
  // 三级背景台阶: 纸面 .925 → 侧栏 .895 → 留白 .830, 逐级变暗(约 1.07 / 1.18)
  const bg = hslToHex(h, 0.26, 0.925);
  const chromeBg = hslToHex(h, 0.24, 0.895);
  const pageBg = hslToHex(h, 0.3, 0.83);
  // 装饰线只负责分割; 结构性边框要过 3:1, 否则输入框/按钮边界等于不存在
  const chromeBorder = ensureContrast(hslToHex(h, 0.32, 0.76), chromeBg, 1.55);
  const borderStrong = ensureContrast(hslToHex(h, 0.3, 0.6), chromeBg, 3);
  // 正文与次要文字: 深色; muted 按更暗的 chromeBg 校准, 顺带覆盖纸面
  const fg = hslToHex(h, 0.32, 0.16);
  const muted = ensureContrast(hslToHex(h, 0.12, 0.44), chromeBg, 4.5);
  // 强调色: 代表色压深到"作文字压在留白区"仍达标 —— 这是所有文字型高亮的最差底色
  const accent = ensureContrast(repHex, pageBg, 4.5);
  const accentFg = contrastRatio("#ffffff", accent) >= 4.5 ? "#ffffff" : "#191919";
  const danger = ensureContrast("#b3261e", bg, 4.5);
  return {
    id,
    name,
    bg,
    fg,
    pageBg,
    chromeBg,
    chromeBorder,
    borderStrong,
    accent,
    accentFg,
    muted,
    panelHover: hslToHex(h, 0.18, 0.9),
    danger,
    shadow: "rgba(0,0,0,.13)",
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

// ---------------------------------------------------------------- 传统节日主题
//
// 分两支:
//   - 日景(18): 直接复用 paintTheme —— 只借主色色相, 明度/对比度由算法锁定,
//     与地域色彩 / 廿四节气走完全同一条规则, 不另写一套配色逻辑。
//   - 夜场(5): 走 paintFestivalNight —— 深色推导。夜场的"最差底色"是 chromeBg
//     (最亮的深色面, 侧栏/状态栏), 不是 bg: 文字压在面板上时对比度最低,
//     所以边框/次要文字/强调色一律按 chromeBg 校准。

/**
 * 夜场(深色)推导。
 *
 * 明度全部锁定, 只借主色色相; 强调色用 nightAccent(缺省 = 主色)并校准到 4.5:1。
 * 三级背景台阶: 纸面 .13 → 面板 .165(最亮) → 留白 .09(最深)。
 */
function paintFestivalNight(repHex: string, accentHex: string, name: string, id: string): ThemeDef {
  const h = rgbToHslOf(repHex).h;
  const bg = hslToHex(h, 0.2, 0.13); // 纸面
  const pageBg = hslToHex(h, 0.22, 0.09); // 留白(更深)
  const chromeBg = hslToHex(h, 0.18, 0.165); // 侧栏/面板(最亮, 作为校准基准)
  const chromeBorder = ensureContrast(hslToHex(h, 0.14, 0.28), chromeBg, 1.5);
  const borderStrong = ensureContrast(hslToHex(h, 0.1, 0.45), chromeBg, 3.0);
  const fg = hslToHex(h, 0.05, 0.86);
  const muted = ensureContrast(hslToHex(h, 0.08, 0.55), chromeBg, 4.5);
  const accent = ensureContrast(accentHex, chromeBg, 4.5);
  const accentFg = contrastRatio("#161310", accent) >= 4.5 ? "#161310" : "#ffffff";
  const danger = ensureContrast("#ff9d93", bg, 4.5);
  return {
    id,
    name,
    bg,
    fg,
    pageBg,
    chromeBg,
    chromeBorder,
    borderStrong,
    accent,
    accentFg,
    muted,
    panelHover: hslToHex(h, 0.12, 0.22),
    danger,
    shadow: "rgba(0,0,0,.55)",
    isDark: true,
  };
}

/** 传统节日主题: 日景复用 paintTheme, 夜场走深色推导 */
export function festivalTheme(id?: string): ThemeDef {
  const f =
    FESTIVALS.find((x) => x.id === id) ??
    FESTIVALS.find((x) => x.id === DEFAULT_FESTIVAL_ID) ??
    FESTIVALS[0];
  return f.night
    ? paintFestivalNight(f.main.hex, f.nightAccent ?? f.main.hex, f.name, f.id)
    : paintTheme(f.main.hex, f.name, f.id);
}

export function fontStackById(id: string): string {
  return (FONTS.find((f) => f.id === id) ?? FONTS[0]).stack;
}
