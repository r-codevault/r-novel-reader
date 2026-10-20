/**
 * festivals.ts — 传统节日色彩(手工整理)
 *
 * 与 provinceColors.ts / solarTerms.ts 同构: 纯数据, 不依赖 settings, 不引用 vscode。
 * 色值全部取自 china-color-palette 的 526 色库, 只作为"色相来源":
 * 阅读色板由 settings.ts 的 paintTheme / paintFestivalNight 统一推导,
 * 明度与对比度由算法锁定, 因此任意节日色都能保证正文可读。
 *
 * 分组:
 *  - 日景 18 项: 手动可选(设置面板第三个下拉), 走 paintTheme
 *  - 夜场 5 项: id 带 `-night` 后缀, 不进手动列表, 走 paintFestivalNight(深色推导)
 *
 * 注意: id 一旦发布不可变更(要落盘到 globalState)。
 */
export interface FestivalColor {
  /** 传统色名(取自 526 色库, 不得自造) */
  name: string;
  hex: string;
}

export interface FestivalDef {
  id: string;
  name: string;
  /** 农历日期描述, 仅用于 UI 展示 */
  date: string;
  /** 所属季节: 决定纸面明度的季相(本项目由主色色相推导, 季相只用于文案/分组) */
  season: '春' | '夏' | '秋' | '冬';
  /** 五行归属, 用于 UI 标签 */
  wuxing: '木' | '火' | '土' | '金' | '水';
  /** 主色: 只借色相, 明度由算法锁定 */
  main: FestivalColor;
  /** 辅色 / 点缀色: 只用于节日横幅、开屏, 不进阅读界面 */
  aux: FestivalColor;
  dot: FestivalColor;
  /** 一句话典故(UI 提示用) */
  slogan: string;
  /** 是否为夜场(深色推导) */
  night?: boolean;
  /** 夜场专用强调色(缺省用 main) */
  nightAccent?: string;
}

export const DEFAULT_FESTIVAL_ID = 'chunjie';

export const FESTIVALS: FestivalDef[] = [
  // ---- 日景(18)
  { id: 'chuxi', name: '除夕', date: '腊月三十', season: '冬', wuxing: '火',
    main: { name: '殷红', hex: '#82111F' }, aux: { name: '朱红', hex: '#ED5126' }, dot: { name: '金盏黄', hex: '#FCC307' },
    slogan: '爆竹声中一岁除' },
  { id: 'chunjie', name: '春节', date: '正月初一', season: '春', wuxing: '火',
    main: { name: '朱红', hex: '#ED5126' }, aux: { name: '金瓜黄', hex: '#FCD217' }, dot: { name: '汉白玉', hex: '#F8F4ED' },
    slogan: '正旦开元，万象更新' },
  { id: 'yuanxiao', name: '元宵', date: '正月十五', season: '春', wuxing: '火',
    main: { name: '金莺黄', hex: '#F4A83A' }, aux: { name: '群青', hex: '#1772B4' }, dot: { name: '春梅红', hex: '#F1939C' },
    slogan: '火树银花合' },
  { id: 'longtaitou', name: '龙抬头', date: '二月初二', season: '春', wuxing: '木',
    main: { name: '青矾绿', hex: '#2C9678' }, aux: { name: '雄黄', hex: '#FF9900' }, dot: { name: '月白', hex: '#EEF7F2' },
    slogan: '二月二，龙抬头' },
  { id: 'huazhao', name: '花朝', date: '二月十二', season: '春', wuxing: '木',
    main: { name: '藤萝紫', hex: '#8076A3' }, aux: { name: '春梅红', hex: '#F1939C' }, dot: { name: '艾背绿', hex: '#DFECD5' },
    slogan: '百花生日，扑蝶赏红' },
  { id: 'shangsi', name: '上巳', date: '三月初三', season: '春', wuxing: '水',
    main: { name: '嘉陵水绿', hex: '#ADD5A2' }, aux: { name: '碧青', hex: '#5CB3CC' }, dot: { name: '藕荷', hex: '#EDC3AE' },
    slogan: '曲水流觞，祓禊水滨' },
  { id: 'hanshi', name: '寒食', date: '清明前一二日', season: '春', wuxing: '土',
    main: { name: '银灰', hex: '#918072' }, aux: { name: '艾绿', hex: '#CAD3C3' }, dot: { name: '赭石', hex: '#862617' },
    slogan: '禁火三日，冷食插柳' },
  { id: 'qingming', name: '清明', date: '四月初', season: '春', wuxing: '木',
    main: { name: '明绿', hex: '#9ECCAB' }, aux: { name: '月白', hex: '#EEF7F2' }, dot: { name: '淡银灰', hex: '#C1B2A3' },
    slogan: '清明时节雨纷纷' },
  { id: 'duanwu', name: '端午', date: '五月初五', season: '夏', wuxing: '木',
    main: { name: '荷叶绿', hex: '#1A6840' }, aux: { name: '雄黄', hex: '#FF9900' }, dot: { name: '朱红', hex: '#ED5126' },
    slogan: '艾蒲悬门，龙舟竞渡' },
  { id: 'qixi', name: '七夕', date: '七月初七', season: '夏', wuxing: '水',
    main: { name: '群青', hex: '#1772B4' }, aux: { name: '藕荷', hex: '#EDC3AE' }, dot: { name: '银白', hex: '#F1F0ED' },
    slogan: '银汉迢迢，鹊桥暗度' },
  { id: 'zhongyuan', name: '中元', date: '七月十五', season: '秋', wuxing: '水',
    main: { name: '乌梅紫', hex: '#1E131D' }, aux: { name: '金莺黄', hex: '#F4A83A' }, dot: { name: '月白', hex: '#EEF7F2' },
    slogan: '河灯照夜，慎终追远' },
  { id: 'zhongqiu', name: '中秋', date: '八月十五', season: '秋', wuxing: '金',
    main: { name: '苍蓝', hex: '#134857' }, aux: { name: '汉白玉', hex: '#F8F4ED' }, dot: { name: '桂皮淡棕', hex: '#C09351' },
    slogan: '月满人圆' },
  { id: 'chongyang', name: '重阳', date: '九月初九', season: '秋', wuxing: '土',
    main: { name: '金盏黄', hex: '#FCC307' }, aux: { name: '赭石', hex: '#862617' }, dot: { name: '梧枝绿', hex: '#69A794' },
    slogan: '登高辞青，菊酒茱萸' },
  { id: 'hanyi', name: '寒衣', date: '十月初一', season: '冬', wuxing: '土',
    main: { name: '蟹壳灰', hex: '#695E45' }, aux: { name: '月影白', hex: '#C0C4C3' }, dot: { name: '殷红', hex: '#82111F' },
    slogan: '授衣送寒，寄与故人' },
  { id: 'xiayuan', name: '下元', date: '十月十五', season: '冬', wuxing: '水',
    main: { name: '靛青', hex: '#1661AB' }, aux: { name: '汉白玉', hex: '#F8F4ED' }, dot: { name: '金莺黄', hex: '#F4A83A' },
    slogan: '水官解厄，放灯渡厄' },
  { id: 'dongzhi', name: '冬至', date: '十一月', season: '冬', wuxing: '水',
    main: { name: '墨紫', hex: '#310F1B' }, aux: { name: '朱红', hex: '#ED5126' }, dot: { name: '雪白', hex: '#FFFEF9' },
    slogan: '冬至一阳生' },
  { id: 'laba', name: '腊八', date: '十二月初八', season: '冬', wuxing: '土',
    main: { name: '蜜黄', hex: '#FBB957' }, aux: { name: '枣红', hex: '#7C1823' }, dot: { name: '栗棕', hex: '#5C1E19' },
    slogan: '腊祭粥香' },
  { id: 'xiaonian', name: '小年', date: '腊月廿三', season: '冬', wuxing: '火',
    main: { name: '金莲花橙', hex: '#F86B1D' }, aux: { name: '麦芽糖黄', hex: '#F9D27D' }, dot: { name: '蟹壳灰', hex: '#695E45' },
    slogan: '祭灶糖瓜，扫尘迎新' },

  // ---- 夜场(5): id 后缀 -night, 手动列表不展示, 仅供自动切换/夜间开关
  { id: 'chuxi-night', name: '除夕 · 夜', date: '腊月三十', season: '冬', wuxing: '火', night: true,
    main: { name: '殷红', hex: '#82111F' }, aux: { name: '朱红', hex: '#ED5126' }, dot: { name: '金盏黄', hex: '#FCC307' },
    slogan: '守岁到天明', nightAccent: '#ED5126' },
  { id: 'yuanxiao-night', name: '元宵 · 灯', date: '正月十五', season: '春', wuxing: '火', night: true,
    main: { name: '金莺黄', hex: '#F4A83A' }, aux: { name: '群青', hex: '#1772B4' }, dot: { name: '春梅红', hex: '#F1939C' },
    slogan: '灯市如昼', nightAccent: '#F4A83A' },
  { id: 'zhongyuan-night', name: '中元 · 河灯', date: '七月十五', season: '秋', wuxing: '水', night: true,
    main: { name: '乌梅紫', hex: '#1E131D' }, aux: { name: '金莺黄', hex: '#F4A83A' }, dot: { name: '月白', hex: '#EEF7F2' },
    slogan: '一灯照水', nightAccent: '#EEF7F2' },
  { id: 'zhongqiu-night', name: '中秋 · 月', date: '八月十五', season: '秋', wuxing: '金', night: true,
    main: { name: '苍蓝', hex: '#134857' }, aux: { name: '汉白玉', hex: '#F8F4ED' }, dot: { name: '桂皮淡棕', hex: '#C09351' },
    slogan: '月在天心', nightAccent: '#FCC307' },
  { id: 'dongzhi-night', name: '冬至 · 长夜', date: '十一月', season: '冬', wuxing: '水', night: true,
    main: { name: '墨紫', hex: '#310F1B' }, aux: { name: '朱红', hex: '#ED5126' }, dot: { name: '雪白', hex: '#FFFEF9' },
    slogan: '长夜将尽', nightAccent: '#F86B1D' },
];

/** 手动可选(日景): 设置面板第三个下拉只渲染这一组, 夜场不出现在列表里 */
export const FESTIVALS_DAYLIGHT: FestivalDef[] = FESTIVALS.filter((f) => !f.night);
