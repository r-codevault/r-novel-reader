# 节日主题接入方案（Festival Theme Spec）

> **交付对象**：接手实现的开发者 / AI Agent
> **前置阅读**：`docs/color-refactor.md`（令牌模型与对比度契约）、`docs/festival-colors.html`（色谱视觉稿）
> **基线版本**：1.36.0（`ThemeDef` 已是 12 令牌，全部对比度契约已生效）
> **本文目标**：把 18 个传统节日 + 5 个夜场的色谱，接成阅读器的第 4 类主题（`preset / province / term / festival`），**不改动既有令牌模型**。

---

## 0. 一句话与交付边界

新增一类主题：`theme: "festival"` + `festival: "<festival-id>"`，色板由节日主色的**色相**推导，复用 `paintTheme` 的明度/对比度锁定规则；夜场（5 个）走深色推导。

**做**：数据文件、推导函数、`themeById` 分发、设置面板入口、自动切换（P1）、测试。
**不做**：不改 `ThemeDef` 字段；不改 `applyThemeVars` 的变量名；不做节日插画/开屏（那是另一个交付物）。

---

## 1. 接入点地图（现状）

| 层 | 文件 | 现状 |
|---|---|---|
| 数据 | `src/provinceColors.ts` / `src/solarTerms.ts` | 纯数据，不依赖 settings |
| 推导 | `src/settings.ts` → `paintTheme()`（私有） | `provinceTheme()` / `termTheme()` 调用它 |
| 分发 | `src/settings.ts` → `themeById(id, provinceCode?, termId?)` | 3 个分支：preset / province / term |
| 首帧 | `src/readerPanel.ts` → `_getHtml()` 的 `:root` 变量 | 需与 `applyThemeVars` 保持一致 |
| 运行时 | `webview/reader/store.ts` → `themeOf()` / `applyThemeVars()` | 从虚拟模块拿预计算色板 |
| 构建 | `vite.config.mjs` → `virtual:novel-constants` | 构建期把 `PROVINCE_THEMES` / `TERM_THEMES` 算好注入 |
| UI | `webview/reader/components/SettingsPanel.vue` | 6 个色点 + 省份/节气两个自绘下拉 |
| 测试 | `scripts/test-theme-presets.js` / `test-province-theme.js` / `test-term-theme.js` | 每个主题类型的对比度契约 |

**本次新增**：`src/festivals.ts`（数据 + 日历）、`festivalTheme()`（settings）、`FESTIVAL_THEMES`（vite）、第三个下拉（UI）、`test-festival-theme.js`（测试）。

### 1.1 实施顺序（建议 4 个 commit，可独立回滚）

| # | 内容 | 触碰文件 | 完成判据 |
|---|---|---|---|
| C1 | 数据 + 推导 + 分发 | `src/festivals.ts`（新）、`src/settings.ts`、`scripts/test-festival-theme.js`（新）、`package.json` | `npm test` 出现「节日主题契约通过 ✔」，23 套全达标 |
| C2 | 构建注入 + 运行时 | `vite.config.mjs`、`webview/reader/store.ts`、`src/readerPanel.ts` | dev 页面里手动 `theme=festival` 能正确上色 |
| C3 | 设置入口 | `SettingsPanel.vue`、`reader.css`、`smoke-reader-vue.js` | 面板出现第三个下拉，hover 预览/落盘正常 |
| C4 | 自动切换（P1） | `src/festivalCalendar.ts`（新）、`src/extension.ts`、日历测试 | 跨节日窗口自动切、手动选择不被抢 |

> 每个 commit 都必须能通过 `npm test`。C1 不依赖 UI，适合先做。

---

## 2. 数据层：`src/festivals.ts`

### 2.1 类型

```ts
export interface FestivalColor {
  /** 传统色名（取自 526 色库，不得自造） */
  name: string;
  hex: string;
}

export interface FestivalDef {
  id: string;
  name: string;
  /** 农历日期描述，仅用于 UI 展示 */
  date: string;
  /** 所属季节：决定纸面明度的季相（本项目由主色色相推导，季相只用于文案/分组） */
  season: "春" | "夏" | "秋" | "冬";
  /** 五行归属，用于 UI 标签 */
  wuxing: "木" | "火" | "土" | "金" | "水";
  /** 主色：只借色相，明度由算法锁定 */
  main: FestivalColor;
  /** 辅色 / 点缀色：只用于节日横幅、开屏，不进阅读界面 */
  aux: FestivalColor;
  dot: FestivalColor;
  /** 一句话典故（UI 提示用） */
  slogan: string;
  /** 是否为夜场（深色推导） */
  night?: boolean;
  /** 夜场专用强调色（缺省用 main） */
  nightAccent?: string;
}

export const DEFAULT_FESTIVAL_ID = "chunjie";
```

### 2.2 数据（可直接粘贴）

> 色值全部来自 `china-color-palette` 的 526 色库，**不要改 hex**；`id` 一旦发布不可变更（要落盘）。

```ts
export const FESTIVALS: FestivalDef[] = [
  // ---- 日景（18）
  { id: "chuxi", name: "除夕", date: "腊月三十", season: "冬", wuxing: "火",
    main: { name: "殷红", hex: "#82111F" }, aux: { name: "朱红", hex: "#ED5126" }, dot: { name: "金盏黄", hex: "#FCC307" },
    slogan: "爆竹声中一岁除" },
  { id: "chunjie", name: "春节", date: "正月初一", season: "春", wuxing: "火",
    main: { name: "朱红", hex: "#ED5126" }, aux: { name: "金瓜黄", hex: "#FCD217" }, dot: { name: "汉白玉", hex: "#F8F4ED" },
    slogan: "正旦开元，万象更新" },
  { id: "yuanxiao", name: "元宵", date: "正月十五", season: "春", wuxing: "火",
    main: { name: "金莺黄", hex: "#F4A83A" }, aux: { name: "群青", hex: "#1772B4" }, dot: { name: "春梅红", hex: "#F1939C" },
    slogan: "火树银花合" },
  { id: "longtaitou", name: "龙抬头", date: "二月初二", season: "春", wuxing: "木",
    main: { name: "青矾绿", hex: "#2C9678" }, aux: { name: "雄黄", hex: "#FF9900" }, dot: { name: "月白", hex: "#EEF7F2" },
    slogan: "二月二，龙抬头" },
  { id: "huazhao", name: "花朝", date: "二月十二", season: "春", wuxing: "木",
    main: { name: "藤萝紫", hex: "#8076A3" }, aux: { name: "春梅红", hex: "#F1939C" }, dot: { name: "艾背绿", hex: "#DFECD5" },
    slogan: "百花生日，扑蝶赏红" },
  { id: "shangsi", name: "上巳", date: "三月初三", season: "春", wuxing: "水",
    main: { name: "嘉陵水绿", hex: "#ADD5A2" }, aux: { name: "碧青", hex: "#5CB3CC" }, dot: { name: "藕荷", hex: "#EDC3AE" },
    slogan: "曲水流觞，祓禊水滨" },
  { id: "hanshi", name: "寒食", date: "清明前一二日", season: "春", wuxing: "土",
    main: { name: "银灰", hex: "#918072" }, aux: { name: "艾绿", hex: "#CAD3C3" }, dot: { name: "赭石", hex: "#862617" },
    slogan: "禁火三日，冷食插柳" },
  { id: "qingming", name: "清明", date: "四月初", season: "春", wuxing: "木",
    main: { name: "明绿", hex: "#9ECCAB" }, aux: { name: "月白", hex: "#EEF7F2" }, dot: { name: "淡银灰", hex: "#C1B2A3" },
    slogan: "清明时节雨纷纷" },
  { id: "duanwu", name: "端午", date: "五月初五", season: "夏", wuxing: "木",
    main: { name: "荷叶绿", hex: "#1A6840" }, aux: { name: "雄黄", hex: "#FF9900" }, dot: { name: "朱红", hex: "#ED5126" },
    slogan: "艾蒲悬门，龙舟竞渡" },
  { id: "qixi", name: "七夕", date: "七月初七", season: "夏", wuxing: "水",
    main: { name: "群青", hex: "#1772B4" }, aux: { name: "藕荷", hex: "#EDC3AE" }, dot: { name: "银白", hex: "#F1F0ED" },
    slogan: "银汉迢迢，鹊桥暗度" },
  { id: "zhongyuan", name: "中元", date: "七月十五", season: "秋", wuxing: "水",
    main: { name: "乌梅紫", hex: "#1E131D" }, aux: { name: "金莺黄", hex: "#F4A83A" }, dot: { name: "月白", hex: "#EEF7F2" },
    slogan: "河灯照夜，慎终追远" },
  { id: "zhongqiu", name: "中秋", date: "八月十五", season: "秋", wuxing: "金",
    main: { name: "苍蓝", hex: "#134857" }, aux: { name: "汉白玉", hex: "#F8F4ED" }, dot: { name: "桂皮淡棕", hex: "#C09351" },
    slogan: "月满人圆" },
  { id: "chongyang", name: "重阳", date: "九月初九", season: "秋", wuxing: "土",
    main: { name: "金盏黄", hex: "#FCC307" }, aux: { name: "赭石", hex: "#862617" }, dot: { name: "梧枝绿", hex: "#69A794" },
    slogan: "登高辞青，菊酒茱萸" },
  { id: "hanyi", name: "寒衣", date: "十月初一", season: "冬", wuxing: "土",
    main: { name: "蟹壳灰", hex: "#695E45" }, aux: { name: "月影白", hex: "#C0C4C3" }, dot: { name: "殷红", hex: "#82111F" },
    slogan: "授衣送寒，寄与故人" },
  { id: "xiayuan", name: "下元", date: "十月十五", season: "冬", wuxing: "水",
    main: { name: "靛青", hex: "#1661AB" }, aux: { name: "汉白玉", hex: "#F8F4ED" }, dot: { name: "金莺黄", hex: "#F4A83A" },
    slogan: "水官解厄，放灯渡厄" },
  { id: "dongzhi", name: "冬至", date: "十一月", season: "冬", wuxing: "水",
    main: { name: "墨紫", hex: "#310F1B" }, aux: { name: "朱红", hex: "#ED5126" }, dot: { name: "雪白", hex: "#FFFEF9" },
    slogan: "冬至一阳生" },
  { id: "laba", name: "腊八", date: "十二月初八", season: "冬", wuxing: "土",
    main: { name: "蜜黄", hex: "#FBB957" }, aux: { name: "枣红", hex: "#7C1823" }, dot: { name: "栗棕", hex: "#5C1E19" },
    slogan: "腊祭粥香" },
  { id: "xiaonian", name: "小年", date: "腊月廿三", season: "冬", wuxing: "火",
    main: { name: "金莲花橙", hex: "#F86B1D" }, aux: { name: "麦芽糖黄", hex: "#F9D27D" }, dot: { name: "蟹壳灰", hex: "#695E45" },
    slogan: "祭灶糖瓜，扫尘迎新" },

  // ---- 夜场（5）：id 后缀 -night，手动列表不展示，仅供自动切换/夜间开关
  { id: "chuxi-night", name: "除夕 · 夜", date: "腊月三十", season: "冬", wuxing: "火", night: true,
    main: { name: "殷红", hex: "#82111F" }, aux: { name: "朱红", hex: "#ED5126" }, dot: { name: "金盏黄", hex: "#FCC307" },
    slogan: "守岁到天明", nightAccent: "#ED5126" },
  { id: "yuanxiao-night", name: "元宵 · 灯", date: "正月十五", season: "春", wuxing: "火", night: true,
    main: { name: "金莺黄", hex: "#F4A83A" }, aux: { name: "群青", hex: "#1772B4" }, dot: { name: "春梅红", hex: "#F1939C" },
    slogan: "灯市如昼", nightAccent: "#F4A83A" },
  { id: "zhongyuan-night", name: "中元 · 河灯", date: "七月十五", season: "秋", wuxing: "水", night: true,
    main: { name: "乌梅紫", hex: "#1E131D" }, aux: { name: "金莺黄", hex: "#F4A83A" }, dot: { name: "月白", hex: "#EEF7F2" },
    slogan: "一灯照水", nightAccent: "#EEF7F2" },
  { id: "zhongqiu-night", name: "中秋 · 月", date: "八月十五", season: "秋", wuxing: "金", night: true,
    main: { name: "苍蓝", hex: "#134857" }, aux: { name: "汉白玉", hex: "#F8F4ED" }, dot: { name: "桂皮淡棕", hex: "#C09351" },
    slogan: "月在天心", nightAccent: "#FCC307" },
  { id: "dongzhi-night", name: "冬至 · 长夜", date: "十一月", season: "冬", wuxing: "水", night: true,
    main: { name: "墨紫", hex: "#310F1B" }, aux: { name: "朱红", hex: "#ED5126" }, dot: { name: "雪白", hex: "#FFFEF9" },
    slogan: "长夜将尽", nightAccent: "#F86B1D" },
];

/** 手动可选（日景） */
export const FESTIVALS_DAYLIGHT = FESTIVALS.filter((f) => !f.night);
```

---

## 3. 算法层：`src/settings.ts`

> 复用现有 `paintTheme()`。它已经是「只借色相 + 锁定明度 + 校准对比度」，**不要为节日另写一套配色逻辑**。
> 唯一新增：深色推导 `paintFestivalNight()`。

### 3.1 日景

```ts
export function festivalTheme(id?: string): ThemeDef {
  const f = FESTIVALS.find((x) => x.id === id)
    ?? FESTIVALS.find((x) => x.id === DEFAULT_FESTIVAL_ID)
    ?? FESTIVALS[0];
  return f.night
    ? paintFestivalNight(f.main.hex, f.nightAccent ?? f.main.hex, f.name, f.id)
    : paintTheme(f.main.hex, f.name, f.id);
}
```

### 3.2 夜场（深色推导）

夜场的"最差底色"是 **chromeBg（最亮的深色面）**，不是 bg —— 文字压在侧栏/状态栏上时对比度最低。

```ts
function paintFestivalNight(repHex: string, accentHex: string, name: string, id: string): ThemeDef {
  const h = rgbToHslOf(repHex).h;
  const bg = hslToHex(h, 0.20, 0.13);          // 纸面
  const pageBg = hslToHex(h, 0.22, 0.09);      // 留白（更深）
  const chromeBg = hslToHex(h, 0.18, 0.165);   // 侧栏/面板（最亮，作为校准基准）
  const chromeBorder = ensureContrast(hslToHex(h, 0.14, 0.28), chromeBg, 1.5);
  const borderStrong = ensureContrast(hslToHex(h, 0.10, 0.45), chromeBg, 3.0);
  const fg = hslToHex(h, 0.05, 0.86);
  const muted = ensureContrast(hslToHex(h, 0.08, 0.55), chromeBg, 4.5);
  const accent = ensureContrast(accentHex, chromeBg, 4.5);
  const accentFg = contrastRatio('#161310', accent) >= 4.5 ? '#161310' : '#ffffff';
  const danger = ensureContrast('#ff9d93', bg, 4.5);
  return {
    id, name, bg, fg, pageBg, chromeBg, chromeBorder, borderStrong, accent, accentFg, muted,
    panelHover: hslToHex(h, 0.12, 0.22),
    danger,
    shadow: 'rgba(0,0,0,.55)',
    isDark: true,
  };
}
```

### 3.3 分发

```ts
export function themeById(
  id: string,
  provinceCode?: string,
  termId?: string,
  festivalId?: string
): ThemeDef {
  if (id === "province") { return provinceTheme(provinceCode); }
  if (id === "term") { return termTheme(termId); }
  if (id === "festival") { return festivalTheme(festivalId); }
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
```

**注意**：`themeById` 增加第 4 个参数。现有 19 处调用（`readerPanel.ts` 的 `:root` 变量）都是 1 参调用，不受影响；但为了让首帧取到节日色，这 19 行需要统一改成四参（见 5.4 末尾）。

---

## 4. 取值基线（验收依据）

> 下表由上述算法输出，**实现后必须逐值一致**（允许 ±1 的 8bit 舍入）。
> `panelHover`：日景 `hsl(h,.18,.90)`、夜场 `hsl(h,.12,.22)`；`shadow`：日景 `rgba(0,0,0,.13)`、夜场 `rgba(0,0,0,.55)`。

### 4.1 十八套日景

| 主题 | `bg` | `fg` | `pageBg` | `chromeBg` | `chromeBorder` | `borderStrong` | `accent` | `accentFg` | `muted` | `danger` |
|---|---|---|---|---|---|---|---|---|---|---|
| 除夕 | `#f1e7e8` | `#361c1f` | `#e1c7ca` | `#ebdedf` | `#d3abb0` | `#b16d75` | `#82111F` | `#ffffff` | `#755c5f` | `#b3261e` |
| 春节 | `#f1e9e7` | `#36211c` | `#e1ccc7` | `#ebe1de` | `#d0aea4` | `#ac7363` | `#a42e0e` | `#ffffff` | `#735f5a` | `#b3261e` |
| 元宵 | `#f1ede7` | `#362b1c` | `#e1d6c7` | `#ebe5de` | `#cbb79a` | `#9c7f53` | `#835107` | `#ffffff` | `#706658` | `#b3261e` |
| 龙抬头 | `#e7f1ee` | `#1c362e` | `#c7e1d9` | `#deebe7` | `#90c5b6` | `#4c8f7c` | `#1f6b55` | `#ffffff` | `#566d66` | `#b3261e` |
| 花朝 | `#e9e7f1` | `#221c36` | `#ccc7e1` | `#e1deeb` | `#b7aed5` | `#8273b4` | `#595077` | `#ffffff` | `#645f78` | `#b3261e` |
| 上巳 | `#e9f1e7` | `#21361c` | `#cce1c7` | `#e1ebde` | `#9cc590` | `#5d924e` | `#3d6b30` | `#ffffff` | `#5b6d56` | `#b3261e` |
| 寒食 | `#f1ebe7` | `#36281c` | `#e1d2c7` | `#ebe4de` | `#ccb39d` | `#a37957` | `#675a50` | `#ffffff` | `#706258` | `#b3261e` |
| 清明 | `#e7f1ea` | `#1c3623` | `#c7e1ce` | `#deebe1` | `#93c7a2` | `#4e9262` | `#366844` | `#ffffff` | `#566d5c` | `#b3261e` |
| 端午 | `#e7f1ec` | `#1c3628` | `#c7e1d3` | `#deebe4` | `#93c7ac` | `#4e926f` | `#1A6840` | `#ffffff` | `#566d61` | `#b3261e` |
| 七夕 | `#e7edf1` | `#1c2b36` | `#c7d6e1` | `#dee5eb` | `#a1bbce` | `#5986a6` | `#135e94` | `#ffffff` | `#5a6873` | `#b3261e` |
| 中元 | `#f1e7f0` | `#361c33` | `#e1c7de` | `#ebdee9` | `#d2a7ce` | `#ad66a6` | `#1E131D` | `#ffffff` | `#755c73` | `#b3261e` |
| 中秋 | `#e7eff1` | `#1c3036` | `#c7dbe1` | `#dee8eb` | `#9ac1cb` | `#538c9c` | `#134857` | `#ffffff` | `#586a70` | `#b3261e` |
| 重阳 | `#f1efe7` | `#36301c` | `#e1dbc7` | `#ebe8de` | `#c7bb93` | `#92824e` | `#785c01` | `#ffffff` | `#6d6756` | `#b3261e` |
| 寒衣 | `#f1eee7` | `#362e1c` | `#e1d9c7` | `#ebe7de` | `#c9b996` | `#968050` | `#695E45` | `#ffffff` | `#6d6556` | `#b3261e` |
| 下元 | `#e7ecf1` | `#1c2936` | `#c7d4e1` | `#dee4eb` | `#a4bad0` | `#5f85aa` | `#155ca2` | `#ffffff` | `#5a6673` | `#b3261e` |
| 冬至 | `#f1e7ea` | `#361c25` | `#e1c7d0` | `#ebdee2` | `#d3abb9` | `#af6982` | `#310F1B` | `#ffffff` | `#755c65` | `#b3261e` |
| 腊八 | `#f1ede7` | `#362b1c` | `#e1d6c7` | `#ebe5de` | `#c9b596` | `#9c7f53` | `#834f03` | `#ffffff` | `#706658` | `#b3261e` |
| 小年 | `#f1eae7` | `#36251c` | `#e1d0c7` | `#ebe2de` | `#ceb1a1` | `#a8775c` | `#9b3a05` | `#ffffff` | `#73625a` | `#b3261e` |

### 4.2 五套夜场

| 主题 | `bg` | `fg` | `pageBg` | `chromeBg` | `chromeBorder` | `borderStrong` | `accent` | `accentFg` | `muted` | `danger` |
|---|---|---|---|---|---|---|---|---|---|---|
| 除夕·夜 | `#281b1c` | `#dddada` | `#1c1213` | `#322324` | `#543f42` | `#846c6f` | `#ef6039` | `#161310` | `#9c8b8d` | `#ff9d93` |
| 元宵·灯 | `#28221b` | `#dddcda` | `#1c1812` | `#322b23` | `#51493d` | `#7e7567` | `#F4A83A` | `#161310` | `#9a9388` | `#ff9d93` |
| 中元·河灯 | `#281b27` | `#dddadd` | `#1c121b` | `#322330` | `#513d50` | `#81697f` | `#EEF7F2` | `#161310` | `#9c8b9b` | `#ff9d93` |
| 中秋·月 | `#1b2528` | `#dadcdd` | `#121a1c` | `#232e32` | `#3d4d51` | `#67797e` | `#FCC307` | `#161310` | `#88969a` | `#ff9d93` |
| 冬至·长夜 | `#281b1f` | `#dddadb` | `#1c1215` | `#322328` | `#543f46` | `#846c74` | `#F86B1D` | `#161310` | `#9c8b92` | `#ff9d93` |

### 4.3 对比度实测（可作为测试快照）

| 主题 | 正文/bg | 次要/chromeBg | 强调/pageBg | 反白/accent | 控件边框 | 装饰线 | 危险色 |
|---|---|---|---|---|---|---|---|
| 除夕 | 12.91 | 4.65 | 6.45 | 10.25 | 3.02 | 1.57 | 5.40 |
| 春节 | 12.62 | 4.66 | 4.59 | 7.06 | 3.04 | 1.59 | 5.46 |
| 元宵 | 11.85 | 4.50 | 4.66 | 6.68 | 3.01 | 1.56 | 5.61 |
| 龙抬头 | 11.27 | 4.54 | 4.62 | 6.38 | 3.10 | 1.58 | 5.67 |
| 花朝 | 13.33 | 4.59 | 4.52 | 7.40 | 3.13 | 1.58 | 5.34 |
| 上巳 | 11.31 | 4.55 | 4.53 | 6.28 | 3.01 | 1.59 | 5.67 |
| 寒食 | 12.04 | 4.66 | 4.51 | 6.66 | 3.07 | 1.59 | 5.53 |
| 清明 | 11.35 | 4.57 | 4.69 | 6.52 | 3.04 | 1.56 | 5.65 |
| 端午 | 11.32 | 4.56 | 4.89 | 6.78 | 3.02 | 1.55 | 5.66 |
| 七夕 | 12.28 | 4.51 | 4.62 | 6.87 | 3.07 | 1.57 | 5.53 |
| 中元 | 12.71 | 4.57 | 11.51 | 18.01 | 3.09 | 1.59 | 5.42 |
| 中秋 | 11.81 | 4.54 | 7.00 | 10.04 | 3.01 | 1.55 | 5.61 |
| 重阳 | 11.43 | 4.60 | 4.55 | 6.31 | 3.10 | 1.56 | 5.68 |
| 寒衣 | 11.59 | 4.67 | 4.55 | 6.39 | 3.09 | 1.57 | 5.64 |
| 下元 | 12.44 | 4.58 | 4.52 | 6.81 | 3.03 | 1.56 | 5.50 |
| 冬至 | 12.86 | 4.63 | 10.93 | 17.29 | 3.11 | 1.56 | 5.40 |
| 腊八 | 11.85 | 4.50 | 4.75 | 6.81 | 3.01 | 1.59 | 5.61 |
| 小年 | 12.28 | 4.54 | 4.68 | 7.00 | 3.02 | 1.58 | 5.50 |
| 除夕·夜 | 11.96 | 4.63 | 5.59 | 5.64 | 3.11 | 1.55 | 8.31 |
| 元宵·灯 | 11.48 | 4.59 | 8.84 | 9.26 | 3.07 | 1.57 | 7.86 |
| 中元·河灯 | 11.87 | 4.64 | 16.69 | 16.94 | 3.00 | 1.50 | 8.22 |
| 中秋·月 | 11.37 | 4.56 | 10.88 | 11.41 | 3.06 | 1.58 | 7.82 |
| 冬至·长夜 | 11.94 | 4.64 | 6.20 | 6.27 | 3.11 | 1.55 | 8.29 |

> 最低值：正文 11.27、次要 4.50、强调 4.51、反白 5.64、边框 3.00 —— 全部贴着门槛但不越界。**若你的实现出现 4.49，说明校准方向或基准底色取错了。**

---

## 5. 设置与 UI

### 5.1 `ReadingSettings`

```ts
export interface ReadingSettings {
  // ...既有字段
  /** 节日主题：FESTIVALS 的 id（含 -night） */
  festival: string;
}

export const DEFAULT_SETTINGS: ReadingSettings = {
  // ...
  festival: DEFAULT_FESTIVAL_ID,
};
```

`SETTING_KEYS` 追加 `"festival"`；`sanitize()` 追加：

```ts
if (typeof s.festival === "string" && FESTIVALS.some((f) => f.id === s.festival)) {
  out.festival = s.festival;
}
```

主题白名单同步放行：

```ts
if (typeof s.theme === "string" &&
    (s.theme === "province" || s.theme === "term" || s.theme === "festival" ||
     THEMES.some((t) => t.id === s.theme))) {
  out.theme = s.theme;
}
```

> 这是历史踩坑点：白名单漏放行会导致"设置静默不生效"。

### 5.2 设置面板

在 `.sp-theme-extra` 里追加第三个选择器（与省份/节气同构），菜单 4 列：

```html
<div class="sp-province-picker" data-kind="festival">
  <button class="sp-province-btn" :class="{ open: festivalOpen }"
    @click.stop="festivalOpen = !festivalOpen; provinceOpen = false; termOpen = false">
    <span>{{ festivalName }}</span>
    <svg class="sp-caret" ...>...</svg>
  </button>
  <div v-if="festivalOpen" class="sp-province-menu sp-festival-menu" @mouseleave="endPreview()">
    <button v-for="f in FESTIVALS_DAYLIGHT" :key="f.id" class="sp-province-item"
      :class="{ active: settings.theme === 'festival' && settings.festival === f.id }"
      :style="{ borderLeftColor: f.main.hex }" :title="f.name + ' · ' + f.main.name"
      @mouseenter="previewFestival(f.id)" @mouseleave="endPreview()"
      @click="chooseFestival(f.id)">{{ f.name }}</button>
  </div>
</div>
```

CSS（`reader.css`，紧跟 `.sp-term-menu`）：

```css
.sp-festival-menu { grid-template-columns: repeat(4, auto); }   /* 18 项 = 4 列 5 行 */
```

- 按钮文案：未启用节日主题时显示「节日色彩」，启用后显示节日名。
- 悬浮预览复用 `previewTheme({ theme:'festival', festival:id })`，移出 `restoreTheme()`（与省份一致，不落盘）。
- 夜场 **不**进入手动列表。

### 5.3 构建期注入（`vite.config.mjs`）

```js
const festivals = require2(path.join(__dirname, 'dist', 'festivals.js'));
const FESTIVALS = festivals.FESTIVALS.map((f) => ({
  id: f.id, name: f.name, date: f.date, season: f.season, wuxing: f.wuxing,
  main: f.main, aux: f.aux, dot: f.dot, slogan: f.slogan, night: !!f.night,
}));
const FESTIVAL_THEMES = Object.fromEntries(
  festivals.FESTIVALS.map((f) => [f.id, settings.festivalTheme(f.id)])
);
// load() 里追加两行：
// 'export const FESTIVALS = ' + JSON.stringify(FESTIVALS) + ';',
// 'export const FESTIVAL_THEMES = ' + JSON.stringify(FESTIVAL_THEMES) + ';',
```

### 5.4 Webview 运行时（`store.ts`）

```ts
import { FESTIVALS, FESTIVAL_THEMES, ... } from 'virtual:novel-constants';

export function themeOf(id: string, province?: string, term?: string, festival?: string): ThemeDef {
  if (id === 'province') { return PROVINCE_THEMES[province || ''] || PROVINCE_THEMES['110000'] || THEMES[0]; }
  if (id === 'term') { return TERM_THEMES[term || ''] || TERM_THEMES['lichun'] || THEMES[0]; }
  if (id === 'festival') { return FESTIVAL_THEMES[festival || ''] || FESTIVAL_THEMES['chunjie'] || THEMES[0]; }
  for (const t of THEMES) { if (t.id === id) { return t; } }
  return THEMES[0];
}
// applyThemeVars 内：themeOf(s.theme, s.province, s.term, s.festival)
```

`src/readerPanel.ts` 的首帧 `:root` 变量同样要取节日色 —— 否则切到节日主题后首次打开会闪一帧默认色。

改动方式：在 `_getHtml()` 顶部抽一个局部常量，避免把 19 行都改成四参：

```ts
const t = themeById(settings.theme, settings.province, settings.term, settings.festival);
// 之后 19 行统一用 ${t.bg} / ${t.accent} ...（顺带消掉重复调用）
```

---

## 6. 自动切换（P1，可独立合并）

> 建议分两个 PR：**P0 = 手动可选**，**P1 = 自动切换**。P1 失败不影响 P0 交付。

### 6.1 农历解析（不引依赖）

```ts
/** 返回 { month: 1..12, day: 1..30, leap: boolean }；不支持时返回 null */
export function lunarParts(d: Date): { month: number; day: number; leap: boolean } | null {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
    const parts = fmt.formatToParts(d);
    const rawMonth = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = Number(parts.find((p) => p.type === 'day')?.value ?? 0);
    if (!day) { return null; }
    const leap = rawMonth.startsWith('闰');
    const name = leap ? rawMonth.slice(1) : rawMonth;
    const table: Record<string, number> = {
      正月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6,
      七月: 7, 八月: 8, 九月: 9, 十月: 10, 冬月: 11, 十一月: 11, 腊月: 12, 十二月: 12,
    };
    const month = table[name];
    return month ? { month, day, leap } : null;
  } catch {
    return null;
  }
}
```

> 已实测：Node 22 / Chromium 的 ICU 返回 `正月 / 二月 / … / 冬月 / 腊月`，`day` 为阿拉伯数字，闰月前缀「闰」。**不要自己写农历算法**。

### 6.2 节气日期表（只覆盖 2026–2040）

`清明` 与 `冬至` 是节气型节日，节日当天必须准。内置 15 年表，超出范围不自动切换（手动仍可用）：

```ts
export const SOLAR_FESTIVAL_DATES: Record<number, { qingming: string; dongzhi: string }> = {
  2026: { qingming: '2026-04-05', dongzhi: '2026-12-22' },
  2027: { qingming: '2027-04-05', dongzhi: '2027-12-22' },
  2028: { qingming: '2028-04-04', dongzhi: '2028-12-21' },
  2029: { qingming: '2029-04-04', dongzhi: '2029-12-21' },
  2030: { qingming: '2030-04-05', dongzhi: '2030-12-22' },
  2031: { qingming: '2031-04-05', dongzhi: '2031-12-22' },
  2032: { qingming: '2032-04-04', dongzhi: '2032-12-21' },
  2033: { qingming: '2033-04-04', dongzhi: '2033-12-21' },
  2034: { qingming: '2034-04-05', dongzhi: '2034-12-22' },
  2035: { qingming: '2035-04-05', dongzhi: '2035-12-22' },
  2036: { qingming: '2036-04-04', dongzhi: '2036-12-21' },
  2037: { qingming: '2037-04-04', dongzhi: '2037-12-21' },
  2038: { qingming: '2038-04-05', dongzhi: '2038-12-22' },
  2039: { qingming: '2039-04-05', dongzhi: '2039-12-22' },
  2040: { qingming: '2040-04-04', dongzhi: '2040-12-21' },
};
```

- 寒食 = 清明前 1 天。
- 除夕 = 正月初一的前 1 天（且必须落在腊月）。
- 小年按北方「腊月廿三」；不做南北切换（可在设置里留 TODO）。

### 6.3 窗口与优先级

```
生效窗口：节日前 7 天 00:00 → 节日后 3 天 23:59
夜场：仅当命中 5 个夜场对应节日，且本地时间 ∈ [20:00, 06:00)
重叠取舍：优先"节日当天"；同为当天时按 优先级表 取最高
优先级：除夕 > 春节 > 元宵 > 中秋 > 端午 > 七夕 > 重阳 > 中元 > 清明 > 冬至 > 其余
```

```ts
export function resolveActiveFestival(now: Date): string | null;
// 返回值：'chunjie' | 'zhongqiu-night' | ... | null
```

### 6.4 降级

- `lunarParts()` 返回 `null`（ICU 缺失）→ 关闭自动切换，仅保留手动选择，**不报错、不弹窗**。
- 年份超出节气表 → 该年只自动切换农历类节日。
- 用户手动改过主题 → 24 小时内不自动覆盖（记录 `lastManualThemeAt`），避免"我选的被系统抢走"。

---

## 7. 测试

### 7.1 新增 `scripts/test-festival-theme.js`

断言清单（可直接抄）：

```js
const { festivalTheme, themeById, contrastRatio } = require('../dist/settings');
const { FESTIVALS } = require('../dist/festivals');

assert.strictEqual(FESTIVALS.length, 23, '应为 18 日景 + 5 夜场');
assert.strictEqual(FESTIVALS.filter((f) => !f.night).length, 18);

for (const f of FESTIVALS) {
  const t = festivalTheme(f.id);
  assert.strictEqual(t.id, f.id);
  assert.strictEqual(t.name, f.name);
  // 契约（与预设/省份/节气完全一致）
  assert(contrastRatio(t.fg, t.bg) >= 7, `${f.name} 正文不足`);
  assert(contrastRatio(t.muted, t.chromeBg) >= 4.5, `${f.name} 次要文字不足`);
  assert(contrastRatio(t.accent, t.pageBg) >= 4.5, `${f.name} 强调色作文字不足`);
  assert(contrastRatio(t.accent, t.chromeBg) >= 4.5, `${f.name} 强调色作图标不足`);
  assert(contrastRatio(t.accentFg, t.accent) >= 4.5, `${f.name} 反白文字不足`);
  assert(contrastRatio(t.borderStrong, t.chromeBg) >= 3, `${f.name} 控件边框不足`);
  assert(contrastRatio(t.danger, t.bg) >= 4.5, `${f.name} 危险色不足`);
  assert(contrastRatio(t.bg, t.chromeBg) >= 1.05, `${f.name} 纸面/面板台阶不足`);
  assert(contrastRatio(t.chromeBg, t.pageBg) >= 1.08, `${f.name} 面板/留白台阶不足`);
  assert.strictEqual(!!t.isDark, !!f.night, `${f.name} isDark 标记错误`);
}

// 快照：与 4.3 表一致（浮点容差 0.01）
const sn = (id) => {
  const t = festivalTheme(id);
  return {
    body: +contrastRatio(t.fg, t.bg).toFixed(2),
    muted: +contrastRatio(t.muted, t.chromeBg).toFixed(2),
    accent: +contrastRatio(t.accent, t.pageBg).toFixed(2),
  };
};
assert.deepStrictEqual(sn('chunjie'), { body: 12.62, muted: 4.66, accent: 4.59 });
assert.deepStrictEqual(sn('zhongqiu-night'), { body: 11.37, muted: 4.56, accent: 10.88 });

// 未知 id 回退春节
assert.strictEqual(festivalTheme('nope').id, 'chunjie');
// 主题分发
assert.strictEqual(themeById('festival', undefined, undefined, 'duanwu').name, '端午');
```

**日历测试**（P1 才需要）：

```js
assert.strictEqual(resolveActiveFestival(new Date('2026-02-17T10:00:00+08:00')), 'chunjie');
assert.strictEqual(resolveActiveFestival(new Date('2026-02-16T10:00:00+08:00')), 'chuxi');
assert.strictEqual(resolveActiveFestival(new Date('2026-09-25T21:00:00+08:00')), 'zhongqiu-night'); // 夜场
assert.strictEqual(resolveActiveFestival(new Date('2026-09-25T10:00:00+08:00')), 'zhongqiu');       // 白天
assert.strictEqual(resolveActiveFestival(new Date('2026-06-01T10:00:00+08:00')), null);            // 窗口外
```

### 7.2 需要同步修改的既有测试

| 文件 | 改什么 |
|---|---|
| `scripts/test-theme-presets.js` | 无需改（只校验 6 套预设） |
| `scripts/smoke-reader-vue.js` | ① 设置面板多一个下拉，断言数量从 2 → 3；② 若断言 `.sp-theme-extra` 子元素数量需同步 |
| `package.json` | `test` 链路加 `node scripts/test-festival-theme.js` |

### 7.3 手动验收（`npm run dev`）

1. 打开设置 → 「阅读主题」行出现三个下拉：地域色彩 / 廿四节气 / 节日色彩。
2. 节日下拉 18 项、4 列排布、左侧有主色条、hover 实时预览、移出还原。
3. 选「端午」：纸面转淡绿、当前章与侧栏激活项变墨绿、进度条同步。
4. 选「中元」：纸面转淡紫、强调色近黑紫（这是色相决定的，不是 bug）。
5. 切到黑夜预设再切回节日：变量无残留。
6. 字号拉到 32px：三个下拉不换行溢出、按钮文案不截断。

---

## 8. 验收标准与回归清单

**验收（硬指标）**

- [ ] 23 套主题全部满足第 7.1 的 10 条对比度断言
- [ ] 生僻色相（中元紫、冬至墨、寒衣灰）纸面不发脏，正文可长时间阅读
- [ ] 手动可选 18 项，夜场不出现在列表里
- [ ] 设置落盘后重开窗口仍是该节日（`theme=festival` + `festival=id` 都写入）
- [ ] 首帧不闪白：`readerPanel._getHtml()` 与 `applyThemeVars` 取到同一套值

**回归（不能碰坏的）**

- [ ] 6 套预设、34 省、24 节气的既有测试仍全绿
- [ ] `themeById` 三参数旧调用不受影响
- [ ] 弹窗互斥、Esc 关闭、点外部关闭仍正常（新增下拉不吞事件：`@click.stop`）
- [ ] 悬浮预览不落盘（检查 `window.postedMessages` 无 updateSettings）
- [ ] 黑夜预设下，节日下拉的悬浮预览能正确还原

---

## 9. 明确不做（避免过度设计）

1. **不新增 ThemeDef 字段**。12 枚令牌够用；节日色板不引入"节日专属色"（如灯笼红），那属于插画层。
2. **不做节日插画/开屏**。本文只交付"阅读界面配色"；视觉稿见 `docs/festival-colors.html`，若要落地为海报/开屏是另一个任务。
3. **不做农历算法自研**。用 `Intl` + 15 年节气表；不引第三方农历库（体积/维护成本不划算）。
4. **不做南北小年分流**。默认腊月廿三，留 TODO。
5. **不把夜场做进色点**。6 个预设色点保持原样，节日入口只在下拉里。

---

## 附录 A：给实现者的三条排错提示

1. **强调色偏浅** → 检查 `ensureContrast(repHex, pageBg, 4.5)` 的第 2 个参数是不是误写成 `bg`（`bg` 更亮，会导致实际压在留白区时不足 4.5）。
2. **夜场文字发灰** → 检查 `muted` / `borderStrong` 是否按 `chromeBg` 校准。深色主题里 `chromeBg` 是**最亮**的深色面，也是对比度最差的基准。
3. **切换后颜色不生效** → 九成是 `sanitize()` 的 theme 白名单没放行 `"festival"`，或 `SETTING_KEYS` 漏了 `festival` 字段（VS Code 设置页同步时会丢）。
