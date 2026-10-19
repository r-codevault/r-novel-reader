/**
 * solarTerms.ts — 廿四节气色彩(手工整理)
 *
 * 每组 = 一个节气的代表色(传统色名 + 色值), 按春夏秋冬四季分组。
 * 说明: 这是依据节气的物候与传统色名整理的**策划色表**(如立春-新柳绿、白露-月白),
 *       不是官方标准色值; 如需换成其他数据源, 只改这个文件即可(色板推导逻辑不用动)。
 *
 * 色值只作为"色相来源", 阅读色板由 settings.ts 的 paintTheme 统一推导,
 * 明度对比度由算法锁定, 因此任意一色都能保证正文可读。
 */
export interface SolarTermDef {
  id: string;
  name: string;
  /** 传统色名(用于提示) */
  color: string;
  hex: string;
  /** 季节分组 */
  season: '春' | '夏' | '秋' | '冬';
}

export const SOLAR_TERMS: SolarTermDef[] = [
  // 春
  { id: 'lichun', name: '立春', color: '新柳绿', hex: '#A8C97F', season: '春' },
  { id: 'yushui', name: '雨水', color: '雨过天青', hex: '#A9C7C8', season: '春' },
  { id: 'jingzhe', name: '惊蛰', color: '桃夭', hex: '#E7A3B4', season: '春' },
  { id: 'chunfen', name: '春分', color: '樱草黄', hex: '#F2D07B', season: '春' },
  { id: 'qingming', name: '清明', color: '竹青', hex: '#6E8B57', season: '春' },
  { id: 'guyu', name: '谷雨', color: '牡丹粉', hex: '#D98BA0', season: '春' },
  // 夏
  { id: 'lixia', name: '立夏', color: '荷叶绿', hex: '#4C9A78', season: '夏' },
  { id: 'xiaoman', name: '小满', color: '麦黄', hex: '#E3C567', season: '夏' },
  { id: 'mangzhong', name: '芒种', color: '石榴红', hex: '#C0392B', season: '夏' },
  { id: 'xiazhi', name: '夏至', color: '天青蓝', hex: '#3E7BA6', season: '夏' },
  { id: 'xiaoshu', name: '小暑', color: '荷粉', hex: '#E58FA3', season: '夏' },
  { id: 'dashu', name: '大暑', color: '炎赤', hex: '#C1443A', season: '夏' },
  // 秋
  { id: 'liqiu', name: '立秋', color: '秋香色', hex: '#B7A96B', season: '秋' },
  { id: 'chushu', name: '处暑', color: '霁蓝', hex: '#3A6B8A', season: '秋' },
  { id: 'bailu', name: '白露', color: '月白', hex: '#D6E1E6', season: '秋' },
  { id: 'qiufen', name: '秋分', color: '蟹壳青', hex: '#7F9A8C', season: '秋' },
  { id: 'hanlu', name: '寒露', color: '枫红', hex: '#A63A2E', season: '秋' },
  { id: 'shuangjiang', name: '霜降', color: '霜柿橙', hex: '#D97B3F', season: '秋' },
  // 冬
  { id: 'lidong', name: '立冬', color: '玄青', hex: '#33404A', season: '冬' },
  { id: 'xiaoxue', name: '小雪', color: '素灰', hex: '#9AA0A6', season: '冬' },
  { id: 'daxue', name: '大雪', color: '雪白', hex: '#EDF1F3', season: '冬' },
  { id: 'dongzhi', name: '冬至', color: '朱砂', hex: '#9E2B22', season: '冬' },
  { id: 'xiaohan', name: '小寒', color: '蜡梅黄', hex: '#D9A93C', season: '冬' },
  { id: 'dahan', name: '大寒', color: '苍蓝', hex: '#2C4A5A', season: '冬' },
];

/** 默认节气(立春) */
export const DEFAULT_TERM_ID = 'lichun';
