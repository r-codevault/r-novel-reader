/**
 * themePaint.ts — 阅读色板推导(纯函数, 无 vscode 依赖)
 *
 * 扩展主进程与 webview **共用这一份源码**:
 *  - 地域色彩 / 廿四节气: 色值构建期已知 -> vite 预计算注入(见 vite.config.mjs)
 *  - 自定义色: 运行时用户输入 -> 端上调用这里的 paintTheme 现算
 * 所以这里不能有任何 Node/vscode 专属依赖, 也不能有 side effect。
 *
 * 设计要点(为什么只借色相):
 * 省色/节气色/自定义色都是"取自实物或用户随手挑的原色", 直接当背景必然出现
 * 文字不可读。所以只用它推导**色相**, 明度一律由算法锁定:
 *   - 纸面/留白: 取该色相, 压到极浅(明度 0.85~0.925) -> 深色字始终清晰
 *   - 正文色: 同色相压到很深(明度 0.16) -> 与纸面对比度通常在 12:1 以上
 *   - 强调色: 原色若与纸面对比不足 4.5:1 则逐步压暗, 保证图标/当前章可辨认
 */

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

export function hexToRgbTriple(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    return [0, 0, 0];
  }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** rgb -> {h:0~360, s:0~1, l:0~1} */
export function rgbToHsl([r, g, b]: [number, number, number]): { h: number; s: number; l: number } {
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

export function hslToHex(h: number, s: number, l: number): string {
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

/** 把强调色压暗到与纸面对比度达标(默认 4.5:1, 正文级) */
export function ensureContrast(fg: string, bg: string, target: number): string {
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
 * 取一组颜色里的"代表色"作为色相来源。
 * 优先用首项(数据按"最具代表性"排序, 如北京=故宫红), 但首项若是近白/近黑
 * 则色相不可靠, 退而取饱和度最高且明度适中的那个。
 */
export function pickRepresentative(colors: { hex: string }[]): { hex: string } {
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

/** 归一化用户输入的颜色: 接受 #rgb / #rrggbb / rgb(r,g,b), 返回 #rrggbb; 非法返回 null */
export function normalizeHex(input: string): string | null {
  let raw = String(input || "").trim().toLowerCase();
  if (!raw) { return null; }
  // 允许省略 #(用户从别处粘贴常不带井号)
  if (/^[0-9a-f]{3}$/.test(raw)) {
    raw = "#" + raw;
  } else if (/^[0-9a-f]{6}$/.test(raw)) {
    raw = "#" + raw;
  }
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return "#" + raw[1] + raw[1] + raw[2] + raw[2] + raw[3] + raw[3];
  }
  if (/^#[0-9a-f]{6}$/.test(raw)) {
    return raw;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(raw);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((v) => Math.min(255, Math.max(0, Number(v) | 0)));
    if (parts.every((v) => Number.isFinite(v))) {
      return "#" + parts.map((v) => v.toString(16).padStart(2, "0")).join("");
    }
  }
  return null;
}

/**
 * 由"一个代表色 + 主题名"生成完整阅读色板。
 * 地域色彩 / 廿四节气 / 自定义色三者共用, 保证三者观感与可读性一致。
 */
export function paintTheme(repHex: string, name: string, id: string): ThemeDef {
  const h = rgbToHsl(hexToRgbTriple(repHex)).h;
  // 纸面/留白/面板: 同一色相不同明度(层次可辨), 饱和度取到"看得出色彩、又不喧宾夺主"
  // 注: 明度不能太高(>0.96 时不同色相在 8bit 下会被量化成同一个颜色, 主题之间就没区别了);
  //     辨识度主要由留白区(pageBg)承担, 纸面保持偏白的"纸感"
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

/**
 * 自定义主题色。
 * 刻意**不**让用户直接指定背景/文字色 —— 随手挑个深色或亮色会导致正文不可读。
 * 这里只收"一个代表色", 明度饱和度交给算法锁定, 与省色/节气色体验一致。
 */
export function customTheme(hex?: string): ThemeDef {
  const norm = hex ? normalizeHex(hex) : null;
  return paintTheme(norm ?? "#8A8A8A", "自定义色", "custom");
}