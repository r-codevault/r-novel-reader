/**
 * provinceColors.ts — 地域色彩数据(自动生成, 请勿手改)
 *
 * 来源: media/地域色彩-cncolor.json(34 个省级区域, 190 个颜色)
 * 生成: node scripts/gen-province-colors.js
 *
 * 用途: 阅读主题「地域色彩」按省份取色推导色板(见 settings.ts provinceTheme)
 */
export interface ProvinceColor {
  name: string;
  hex: string;
  category: string;
}

export interface ProvinceDef {
  code: string;
  name: string;
  slogan: string;
  colors: ProvinceColor[];
}

export const PROVINCES: ProvinceDef[] = [
  {
    code: "110000",
    name: "北京",
    slogan: "紫禁城里的中国色",
    colors: [
      { name: "故宫红", hex: "#9D2933", category: "建筑" },
      { name: "琉璃黄", hex: "#F3C13C", category: "建筑" },
      { name: "天坛蓝", hex: "#3A5F7A", category: "建筑" },
      { name: "烤鸭枣红", hex: "#A52A2A", category: "美食" },
      { name: "京白", hex: "#F5F5F5", category: "非遗" },
      { name: "鸽哨灰", hex: "#7A7A7A", category: "自然" },
    ],
  },
  {
    code: "120000",
    name: "天津",
    slogan: "津门码头的烟火色",
    colors: [
      { name: "泥人红", hex: "#C83C3C", category: "非遗" },
      { name: "狗不理白", hex: "#F5F5DC", category: "美食" },
      { name: "海河蓝", hex: "#4A90A4", category: "自然" },
      { name: "杨柳青年画绿", hex: "#6B8E23", category: "非遗" },
      { name: "小洋楼灰", hex: "#808080", category: "建筑" },
    ],
  },
  {
    code: "130000",
    name: "河北",
    slogan: "燕赵大地的雄健色",
    colors: [
      { name: "赵州桥灰", hex: "#708090", category: "建筑" },
      { name: "避暑山庄绿", hex: "#556B2F", category: "建筑" },
      { name: "沧州铁狮黑", hex: "#2F2F2F", category: "器物" },
      { name: "驴肉火烧黄", hex: "#D2B48C", category: "美食" },
      { name: "白洋淀青", hex: "#5F9EA0", category: "自然" },
    ],
  },
  {
    code: "140000",
    name: "山西",
    slogan: "晋商大院的砖红色",
    colors: [
      { name: "大院红", hex: "#A0522D", category: "建筑" },
      { name: "平遥城墙灰", hex: "#696969", category: "建筑" },
      { name: "老陈醋棕", hex: "#3D2B1F", category: "美食" },
      { name: "云冈石窟黄", hex: "#D3B48C", category: "建筑" },
      { name: "晋祠古柏绿", hex: "#4A5D23", category: "自然" },
    ],
  },
  {
    code: "150000",
    name: "内蒙古",
    slogan: "草原长调的天际色",
    colors: [
      { name: "草原绿", hex: "#228B22", category: "自然" },
      { name: "蒙古包白", hex: "#F6F5DC", category: "建筑" },
      { name: "哈达蓝", hex: "#1E90FF", category: "服饰" },
      { name: "马奶酒乳白", hex: "#FFF8E7", category: "美食" },
      { name: "大漠金沙", hex: "#DAA520", category: "自然" },
      { name: "马头琴棕", hex: "#8B4513", category: "器物" },
    ],
  },
  {
    code: "210000",
    name: "辽宁",
    slogan: "关东黑土的工业色",
    colors: [
      { name: "沈阳故宫红", hex: "#B22222", category: "建筑" },
      { name: "岫岩玉绿", hex: "#2E8B57", category: "器物" },
      { name: "钢都灰", hex: "#718090", category: "器物" },
      { name: "红海滩红", hex: "#C93C3C", category: "自然" },
      { name: "辽参褐", hex: "#654321", category: "美食" },
    ],
  },
  {
    code: "220000",
    name: "吉林",
    slogan: "长白雪域的净白色",
    colors: [
      { name: "长白山白", hex: "#FFFAFA", category: "自然" },
      { name: "雾凇银", hex: "#C0C0C0", category: "自然" },
      { name: "人参黄", hex: "#DBA520", category: "特产" },
      { name: "朝鲜族白", hex: "#F6F5F5", category: "服饰" },
      { name: "梅花鹿棕", hex: "#8C4513", category: "动物" },
    ],
  },
  {
    code: "230000",
    name: "黑龙江",
    slogan: "北国冰雪的极白色",
    colors: [
      { name: "冰雪白", hex: "#F0F8FF", category: "自然" },
      { name: "黑土黑", hex: "#1C1C1C", category: "自然" },
      { name: "松花江蓝", hex: "#4682B4", category: "自然" },
      { name: "红肠红", hex: "#A62A2A", category: "美食" },
      { name: "丹顶鹤白", hex: "#FFFFFF", category: "动物" },
    ],
  },
  {
    code: "310000",
    name: "上海",
    slogan: "魔都霓虹的摩登色",
    colors: [
      { name: "石库门红", hex: "#A42A2A", category: "建筑" },
      { name: "外滩灰", hex: "#6C6C6C", category: "建筑" },
      { name: "东方明珠粉", hex: "#F4A7B9", category: "建筑" },
      { name: "生煎金黄", hex: "#D9A520", category: "美食" },
      { name: "旗袍绿", hex: "#006400", category: "服饰" },
      { name: "黄浦江蓝", hex: "#191970", category: "自然" },
    ],
  },
  {
    code: "320000",
    name: "江苏",
    slogan: "江南园林的文人色",
    colors: [
      { name: "园林绿", hex: "#6C8E23", category: "建筑" },
      { name: "南京城墙灰", hex: "#818080", category: "建筑" },
      { name: "苏绣粉", hex: "#FFB6C1", category: "非遗" },
      { name: "雨花石红", hex: "#C73C3C", category: "器物" },
      { name: "阳澄湖青", hex: "#609EA0", category: "自然" },
      { name: "淮扬菜白", hex: "#FFFAF0", category: "美食" },
    ],
  },
  {
    code: "330000",
    name: "浙江",
    slogan: "山水浙江的青花色",
    colors: [
      { name: "西湖绿", hex: "#6A8E23", category: "自然" },
      { name: "龙泉青瓷青", hex: "#5E9EA0", category: "器物" },
      { name: "龙井茶绿", hex: "#566B2F", category: "美食" },
      { name: "丝绸白", hex: "#FEF8E7", category: "器物" },
      { name: "乌镇蓝印花", hex: "#1F90FF", category: "非遗" },
      { name: "普陀山金", hex: "#FFD700", category: "建筑" },
    ],
  },
  {
    code: "340000",
    name: "安徽",
    slogan: "徽派山水的黑白灰",
    colors: [
      { name: "徽派白", hex: "#F4F5F5", category: "建筑" },
      { name: "黄山松绿", hex: "#546B2F", category: "自然" },
      { name: "文房黑", hex: "#302F2F", category: "器物" },
      { name: "宣纸米", hex: "#FAF0E6", category: "器物" },
      { name: "歙砚青", hex: "#2F4F4F", category: "器物" },
      { name: "毛峰茶绿", hex: "#6B8F23", category: "美食" },
    ],
  },
  {
    code: "350000",
    name: "福建",
    slogan: "八闽山海的多彩色",
    colors: [
      { name: "土楼红", hex: "#A1522D", category: "建筑" },
      { name: "武夷绿", hex: "#238B22", category: "自然" },
      { name: "铁观音茶绿", hex: "#4F7942", category: "美食" },
      { name: "漆器黑", hex: "#1D1C1C", category: "器物" },
      { name: "惠安女蓝", hex: "#4169E1", category: "服饰" },
      { name: "三坊七巷灰", hex: "#6A6969", category: "建筑" },
    ],
  },
  {
    code: "360000",
    name: "江西",
    slogan: "瓷都青花的蓝白色",
    colors: [
      { name: "青花蓝", hex: "#1D90FF", category: "器物" },
      { name: "瓷白", hex: "#F1F8FF", category: "器物" },
      { name: "庐山雾白", hex: "#F5F6F5", category: "自然" },
      { name: "婺源油菜黄", hex: "#FED700", category: "自然" },
      { name: "赣南脐橙橙", hex: "#FF8C00", category: "美食" },
    ],
  },
  {
    code: "370000",
    name: "山东",
    slogan: "齐鲁大地的礼乐色",
    colors: [
      { name: "泰山青", hex: "#304F4F", category: "自然" },
      { name: "孔庙红", hex: "#B32222", category: "建筑" },
      { name: "青岛海蓝", hex: "#1E91FF", category: "自然" },
      { name: "煎饼黄", hex: "#D1B48C", category: "美食" },
      { name: "胶东花馍粉", hex: "#FEB6C1", category: "美食" },
      { name: "泰山石褐", hex: "#8A4513", category: "自然" },
    ],
  },
  {
    code: "410000",
    name: "河南",
    slogan: "中原文明的厚重色",
    colors: [
      { name: "龙门石窟灰", hex: "#7F8080", category: "建筑" },
      { name: "少林僧衣棕", hex: "#8B4613", category: "服饰" },
      { name: "洛阳牡丹红", hex: "#C71585", category: "自然" },
      { name: "钧瓷紫", hex: "#9370DB", category: "器物" },
      { name: "胡辣汤棕", hex: "#664321", category: "美食" },
      { name: "殷墟土黄", hex: "#D2B58C", category: "建筑" },
    ],
  },
  {
    code: "420000",
    name: "湖北",
    slogan: "荆楚风云的编钟色",
    colors: [
      { name: "黄鹤楼黄", hex: "#FFD800", category: "建筑" },
      { name: "武当绿", hex: "#6B8D23", category: "自然" },
      { name: "编钟青", hex: "#5F9FA0", category: "器物" },
      { name: "洪湖莲红", hex: "#DC143C", category: "自然" },
      { name: "热干面黄", hex: "#DAA620", category: "美食" },
      { name: "三峡江灰", hex: "#6F8090", category: "自然" },
    ],
  },
  {
    code: "430000",
    name: "湖南",
    slogan: "潇湘大地的辣椒红",
    colors: [
      { name: "岳麓红", hex: "#B12222", category: "自然" },
      { name: "湘绣红", hex: "#DD143C", category: "非遗" },
      { name: "张家界白", hex: "#F4F5DC", category: "自然" },
      { name: "剁椒红", hex: "#C83D3C", category: "美食" },
      { name: "凤凰古城青", hex: "#2E4F4F", category: "建筑" },
      { name: "安化黑茶褐", hex: "#3E2B1F", category: "美食" },
    ],
  },
  {
    code: "440000",
    name: "广东",
    slogan: "岭南风物的繁彩色",
    colors: [
      { name: "岭南红", hex: "#C83B3C", category: "建筑" },
      { name: "醒狮黄", hex: "#FFD600", category: "非遗" },
      { name: "广绣金", hex: "#DAA420", category: "非遗" },
      { name: "早茶白", hex: "#F5F6DC", category: "美食" },
      { name: "珠江夜游蓝", hex: "#1A1970", category: "自然" },
      { name: "骑楼灰", hex: "#808180", category: "建筑" },
    ],
  },
  {
    code: "450000",
    name: "广西",
    slogan: "桂北山水的喀斯特色",
    colors: [
      { name: "桂林山水绿", hex: "#6B8E24", category: "自然" },
      { name: "壮锦蓝", hex: "#4269E1", category: "非遗" },
      { name: "螺蛳粉棕", hex: "#8B4413", category: "美食" },
      { name: "龙脊梯田金", hex: "#DAA521", category: "自然" },
      { name: "北海银滩白", hex: "#F5F4F5", category: "自然" },
      { name: "铜鼓青", hex: "#2F504F", category: "器物" },
    ],
  },
  {
    code: "460000",
    name: "海南",
    slogan: "热带海岛的椰风色",
    colors: [
      { name: "椰树绿", hex: "#6B8E22", category: "自然" },
      { name: "沙滩黄", hex: "#F5DEB3", category: "自然" },
      { name: "海洋蓝", hex: "#00BFFF", category: "自然" },
      { name: "槟榔红", hex: "#C83C3D", category: "特产" },
      { name: "黎锦彩", hex: "#FF6347", category: "非遗" },
    ],
  },
  {
    code: "500000",
    name: "重庆",
    slogan: "山城雾都的火锅红",
    colors: [
      { name: "火锅红", hex: "#C91F37", category: "美食" },
      { name: "山城雾灰", hex: "#B0B0B0", category: "自然" },
      { name: "吊脚楼棕", hex: "#8B4514", category: "建筑" },
      { name: "小面黄", hex: "#DAA51F", category: "美食" },
      { name: "武隆绿", hex: "#6D8E23", category: "自然" },
    ],
  },
  {
    code: "510000",
    name: "四川",
    slogan: "巴山蜀水的锦绣色",
    colors: [
      { name: "熊猫黑白", hex: "#000000", category: "动物" },
      { name: "辣椒红", hex: "#CA1F37", category: "美食" },
      { name: "蜀绣彩", hex: "#C81585", category: "非遗" },
      { name: "竹海绿", hex: "#218B22", category: "自然" },
      { name: "峨眉金", hex: "#FFD701", category: "自然" },
      { name: "盖碗茶褐", hex: "#8B4512", category: "美食" },
    ],
  },
  {
    code: "520000",
    name: "贵州",
    slogan: "苗岭高原的蜡染蓝",
    colors: [
      { name: "苗绣蓝", hex: "#4069E1", category: "非遗" },
      { name: "黄果树白", hex: "#EFF8FF", category: "自然" },
      { name: "茅台酱褐", hex: "#8D4513", category: "美食" },
      { name: "侗寨青", hex: "#2F4E4F", category: "建筑" },
      { name: "杜鹃花红", hex: "#C83C3B", category: "自然" },
      { name: "刺梨黄", hex: "#FDD700", category: "美食" },
    ],
  },
  {
    code: "530000",
    name: "云南",
    slogan: "彩云之南的孔雀色",
    colors: [
      { name: "孔雀蓝", hex: "#00CED1", category: "动物" },
      { name: "普洱茶褐", hex: "#644321", category: "美食" },
      { name: "扎染蓝", hex: "#1E8FFF", category: "非遗" },
      { name: "红土地红", hex: "#B22322", category: "自然" },
      { name: "鲜花粉", hex: "#FF69B4", category: "自然" },
      { name: "玉龙雪山白", hex: "#FEFAFA", category: "自然" },
    ],
  },
  {
    code: "540000",
    name: "西藏",
    slogan: "雪域高原的圣洁色",
    colors: [
      { name: "布达拉宫红", hex: "#B22122", category: "建筑" },
      { name: "哈达白", hex: "#FEFFFF", category: "服饰" },
      { name: "高原蓝", hex: "#1E90FE", category: "自然" },
      { name: "经幡五彩", hex: "#416AE1", category: "非遗" },
      { name: "唐卡金", hex: "#FFD900", category: "非遗" },
      { name: "牦牛黑", hex: "#1B1C1C", category: "动物" },
    ],
  },
  {
    code: "610000",
    name: "陕西",
    slogan: "三秦大地的黄土色",
    colors: [
      { name: "兵马俑土黄", hex: "#D2B38C", category: "器物" },
      { name: "西安城墙灰", hex: "#686969", category: "建筑" },
      { name: "华山石青", hex: "#2F4F50", category: "自然" },
      { name: "肉夹馍褐", hex: "#894513", category: "美食" },
      { name: "安塞剪纸红", hex: "#CA3C3C", category: "非遗" },
      { name: "秦岭绿", hex: "#228C22", category: "自然" },
    ],
  },
  {
    code: "620000",
    name: "甘肃",
    slogan: "丝路敦煌的壁画色",
    colors: [
      { name: "敦煌土黄", hex: "#D2B48D", category: "建筑" },
      { name: "莫高窟红", hex: "#9F522D", category: "建筑" },
      { name: "祁连雪白", hex: "#FFFBFA", category: "自然" },
      { name: "飞天青绿", hex: "#5F9DA0", category: "非遗" },
      { name: "兰州拉面黄", hex: "#DCA520", category: "美食" },
      { name: "麦积山烟霞", hex: "#C1C0C0", category: "自然" },
    ],
  },
  {
    code: "630000",
    name: "青海",
    slogan: "青藏高原的湖蓝色",
    colors: [
      { name: "青海湖蓝", hex: "#2090FF", category: "自然" },
      { name: "塔尔寺金", hex: "#FFD500", category: "建筑" },
      { name: "盐湖白", hex: "#FFFEFF", category: "自然" },
      { name: "藏毯红", hex: "#C63C3C", category: "非遗" },
      { name: "青稞金黄", hex: "#D8A520", category: "美食" },
    ],
  },
  {
    code: "640000",
    name: "宁夏",
    slogan: "塞上江南的枸杞红",
    colors: [
      { name: "枸杞红", hex: "#B22223", category: "美食" },
      { name: "西夏王陵黄", hex: "#D2B48B", category: "建筑" },
      { name: "贺兰山红", hex: "#A0532D", category: "自然" },
      { name: "滩羊皮白", hex: "#F5F5F6", category: "器物" },
      { name: "沙湖青", hex: "#5F9EA1", category: "自然" },
    ],
  },
  {
    code: "650000",
    name: "新疆",
    slogan: "西域丝路的绚烂色",
    colors: [
      { name: "天山雪白", hex: "#FFF9FA", category: "自然" },
      { name: "沙漠金", hex: "#D4B48C", category: "自然" },
      { name: "葡萄紫", hex: "#800080", category: "美食" },
      { name: "艾德莱斯彩", hex: "#FF1493", category: "非遗" },
      { name: "和田玉青", hex: "#5F9E9F", category: "器物" },
      { name: "胡杨金黄", hex: "#DAA720", category: "自然" },
    ],
  },
  {
    code: "710000",
    name: "中国台湾",
    slogan: "宝岛东岸的山海色",
    colors: [
      { name: "阿里山红桧", hex: "#A0512D", category: "自然" },
      { name: "太平洋蓝", hex: "#1C90FF", category: "自然" },
      { name: "夜市霓虹彩", hex: "#FE1493", category: "美食" },
      { name: "乌龙茶青", hex: "#698E23", category: "美食" },
      { name: "垦丁沙白", hex: "#F5F4DC", category: "自然" },
    ],
  },
  {
    code: "810000",
    name: "中国香港",
    slogan: "东方之珠的霓虹色",
    colors: [
      { name: "维港蓝", hex: "#181970", category: "自然" },
      { name: "霓虹红", hex: "#FF0000", category: "建筑" },
      { name: "茶餐厅绿", hex: "#016400", category: "美食" },
      { name: "港式奶茶棕", hex: "#8B4713", category: "美食" },
      { name: "中环灰", hex: "#696A69", category: "建筑" },
    ],
  },
  {
    code: "820000",
    name: "中国澳门",
    slogan: "濠江葡韵的瓷砖色",
    colors: [
      { name: "大三巴金", hex: "#FFD702", category: "建筑" },
      { name: "葡式瓷砖蓝", hex: "#4168E1", category: "建筑" },
      { name: "赌场红", hex: "#B22221", category: "建筑" },
      { name: "杏仁饼黄", hex: "#D0B48C", category: "美食" },
      { name: "妈阁庙绿", hex: "#6B9023", category: "建筑" },
    ],
  },
];

/** 默认地域(北京): 未选择时的兜底 */
export const DEFAULT_PROVINCE_CODE = "110000";
