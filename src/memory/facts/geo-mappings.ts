/**
 * 地理归一化映射表（统一数据源）
 *
 * 历史上分散在 high-confidence-facts 和 LocationCityResolver 两处，
 * 现统一为单一真相源：fact extractor 基于这些表做"地点信号 → 城市"推导。
 */

/** 直辖市（前缀识别：用户常用"上海浦东"这种省略"市"字的紧凑表达） */
export const MUNICIPALITIES = ['北京', '上海', '天津', '重庆'] as const;

/** 显式城市名（用于"北京/上海/武汉…"开头识别） */
export const SUPPORTED_CITY_PREFIXES = [
  '北京',
  '上海',
  '天津',
  '重庆',
  '武汉',
  '南京',
  '宁波',
  '恩施',
  '宜昌',
  '荆州',
  '黄冈',
  '襄阳',
  '南昌',
  '赣州',
  '江西',
] as const;

/**
 * 全国"显式城市名"表：仅用于替代 high-confidence extractor 里原先的通用
 * `/([一-龥]{2,8})市/` 兜底。
 *
 * 口径：基于县以上行政区划数据中名称以"市"结尾的地级市 + 县级市。这里不把
 * "苏州/昆山"这类裸名称加入 CITY_DICT，避免在任意长句里把品牌名、门店名、
 * 普通词误当城市；只有用户原话出现"苏州市/昆山市"这种显式城市后缀时才命中。
 *
 * 生成来源：lcn data/cities.json + data/areas.json（民政部县以上行政区划数据的
 * 开源整理），取 name 以"市"结尾的唯一值，按中文排序。
 */
const NATIONAL_CITY_NAMES_WITH_SUFFIX = `
阿尔山市 阿克苏市 阿拉尔市 阿拉山口市 阿勒泰市 阿图什市 安达市 安国市
安康市 安陆市 安宁市 安庆市 安丘市 安顺市 安阳市 鞍山市
巴彦淖尔市 巴中市 霸州市 白城市 白山市 白杨市 白银市 百色市
蚌埠市 包头市 宝鸡市 保定市 保山市 北安市 北海市 北京市
北流市 北票市 北屯市 北镇市 本溪市 毕节市 彬州市 滨州市
亳州市 博乐市 沧州市 岑溪市 昌都市 昌吉市 昌邑市 常德市
常宁市 常熟市 常州市 巢湖市 朝阳市 潮州市 郴州市 成都市
承德市 澄江市 池州市 赤壁市 赤峰市 赤水市 重庆市 崇州市
崇左市 滁州市 楚雄市 慈溪市 错那市 达州市 大安市 大理市
大连市 大庆市 大石桥市 大同市 大冶市 丹东市 丹江口市 丹阳市
儋州市 当阳市 德惠市 德令哈市 德兴市 德阳市 德州市 灯塔市
登封市 邓州市 调兵山市 定西市 定州市 东方市 东港市 东莞市
东宁市 东台市 东兴市 东阳市 东营市 都江堰市 都匀市 敦化市
敦煌市 峨眉山市 额尔古纳市 鄂尔多斯市 鄂州市 恩平市 恩施市 二连浩特市
防城港市 肥城市 汾阳市 丰城市 丰镇市 凤城市 佛山市 扶余市
福安市 福鼎市 福清市 福泉市 福州市 抚顺市 抚远市 抚州市
阜康市 阜新市 阜阳市 富锦市 盖州市 赣州市 高安市 高碑店市
高密市 高平市 高邮市 高州市 格尔木市 个旧市 根河市 公主岭市
巩义市 共青城市 古交市 固原市 广安市 广德市 广汉市 广水市
广元市 广州市 贵港市 贵溪市 贵阳市 桂林市 桂平市 哈尔滨市
哈密市 海安市 海城市 海东市 海口市 海林市 海伦市 海宁市
海阳市 邯郸市 韩城市 汉川市 汉中市 杭州市 合肥市 合山市
合作市 和龙市 和田市 河池市 河间市 河津市 河源市 菏泽市
贺州市 鹤壁市 鹤岗市 鹤山市 黑河市 横州市 衡水市 衡阳市
洪湖市 洪江市 侯马市 呼和浩特市 呼伦贝尔市 胡杨河市 湖州市 葫芦岛市
虎林市 华亭市 华阴市 华蓥市 化州市 桦甸市 怀化市 怀仁市
淮安市 淮北市 淮南市 黄冈市 黄骅市 黄山市 黄石市 辉县市
会理市 惠州市 珲春市 霍尔果斯市 霍林郭勒市 霍州市 鸡西市 吉安市
吉林市 吉首市 集安市 济南市 济宁市 济源市 佳木斯市 嘉兴市
嘉峪关市 监利市 简阳市 建德市 建瓯市 江门市 江山市 江阴市
江油市 胶州市 焦作市 蛟河市 揭阳市 介休市 界首市 金昌市
金华市 津市市 锦州市 晋城市 晋江市 晋中市 晋州市 京山市
荆门市 荆州市 井冈山市 景德镇市 景洪市 靖江市 靖西市 九江市
酒泉市 句容市 喀什市 开封市 开平市 开原市 开远市 凯里市
康定市 可克达拉市 克拉玛依市 库车市 库尔勒市 奎屯市 昆明市 昆山市
昆玉市 拉萨市 来宾市 莱西市 莱阳市 莱州市 兰溪市 兰州市
廊坊市 阆中市 老河口市 乐昌市 乐陵市 乐平市 乐清市 乐山市
雷州市 耒阳市 冷水江市 醴陵市 丽江市 丽水市 利川市 荔浦市
溧阳市 连云港市 连州市 涟源市 廉江市 辽阳市 辽源市 聊城市
林芝市 林州市 临沧市 临汾市 临海市 临江市 临清市 临夏市
临湘市 临沂市 灵宝市 灵武市 凌海市 凌源市 浏阳市 柳州市
六安市 六盘水市 龙港市 龙井市 龙口市 龙南市 龙泉市 龙岩市
隆昌市 陇南市 娄底市 庐山市 泸水市 泸州市 陆丰市 禄丰市
吕梁市 滦州市 罗定市 洛阳市 漯河市 麻城市 马鞍山市 马尔康市
满洲里市 芒市 茫崖市 茂名市 眉山市 梅河口市 梅州市 蒙自市
孟州市 弥勒市 米林市 汨罗市 密山市 绵阳市 绵竹市 明光市
漠河市 牡丹江市 穆棱市 那曲市 南安市 南昌市 南充市 南宫市
南京市 南宁市 南平市 南通市 南雄市 南阳市 讷河市 内江市
嫩江市 宁安市 宁波市 宁德市 宁国市 宁乡市 攀枝花市 盘锦市
盘州市 磐石市 彭州市 邳州市 平顶山市 平度市 平果市 平湖市
平凉市 平泉市 凭祥市 萍乡市 泊头市 莆田市 濮阳市 普洱市
普宁市 七台河市 栖霞市 祁阳市 齐齐哈尔市 启东市 迁安市 潜江市
潜山市 黔西市 钦州市 秦皇岛市 沁阳市 青岛市 青铜峡市 青州市
清远市 清镇市 庆阳市 邛崃市 琼海市 曲阜市 曲靖市 衢州市
泉州市 仁怀市 任丘市 日喀则市 日照市 荣成市 如皋市 汝州市
乳山市 瑞安市 瑞昌市 瑞金市 瑞丽市 三河市 三门峡市 三明市
三沙市 三亚市 沙河市 沙湾市 厦门市 山南市 汕头市 汕尾市
商洛市 商丘市 上海市 上饶市 尚志市 韶关市 韶山市 邵东市
邵武市 邵阳市 绍兴市 射洪市 深圳市 深州市 什邡市 神木市
沈阳市 嵊州市 十堰市 石河子市 石家庄市 石狮市 石首市 石嘴山市
寿光市 舒兰市 双河市 双辽市 双鸭山市 水富市 朔州市 四会市
四平市 松原市 松滋市 苏州市 宿迁市 宿州市 绥芬河市 绥化市
随州市 遂宁市 塔城市 台山市 台州市 太仓市 太原市 泰安市
泰兴市 泰州市 唐山市 洮南市 腾冲市 滕州市 天津市 天门市
天水市 天长市 铁力市 铁岭市 铁门关市 通化市 通辽市 同江市
同仁市 桐城市 桐乡市 铜川市 铜陵市 铜仁市 图们市 图木舒克市
吐鲁番市 瓦房店市 万宁市 万源市 威海市 潍坊市 卫辉市 渭南市
温岭市 温州市 文昌市 文山市 乌海市 乌兰察布市 乌兰浩特市 乌鲁木齐市
乌苏市 无为市 无锡市 吴川市 吴忠市 芜湖市 梧州市 五常市
五大连池市 五家渠市 五指山市 武安市 武冈市 武汉市 武威市 武穴市
武夷山市 舞钢市 西安市 西昌市 西宁市 锡林浩特市 仙桃市 咸宁市
咸阳市 香格里拉市 湘潭市 湘乡市 襄阳市 项城市 孝感市 孝义市
忻州市 辛集市 新乐市 新密市 新民市 新泰市 新乡市 新星市
新沂市 新余市 新郑市 信阳市 信宜市 邢台市 荥阳市 兴城市
兴化市 兴宁市 兴平市 兴仁市 兴义市 徐州市 许昌市 宣城市
宣威市 旬阳市 牙克石市 雅安市 烟台市 延安市 延吉市 盐城市
扬中市 扬州市 阳春市 阳江市 阳泉市 伊春市 伊宁市 仪征市
宜宾市 宜昌市 宜城市 宜春市 宜都市 宜兴市 义马市 义乌市
益阳市 银川市 应城市 英德市 鹰潭市 营口市 永安市 永城市
永济市 永康市 永州市 余姚市 榆林市 榆树市 禹城市 禹州市
玉环市 玉林市 玉门市 玉树市 玉溪市 沅江市 原平市 岳阳市
云浮市 运城市 枣阳市 枣庄市 扎兰屯市 湛江市 张家港市 张家界市
张家口市 张掖市 漳平市 漳州市 樟树市 长春市 长葛市 长沙市
长垣市 长治市 招远市 昭通市 肇东市 肇庆市 镇江市 郑州市
枝江市 中山市 中卫市 钟祥市 舟山市 周口市 株洲市 珠海市
诸城市 诸暨市 驻马店市 庄河市 涿州市 资兴市 资阳市 淄博市
子长市 自贡市 邹城市 邹平市 遵化市 遵义市
`
  .trim()
  .split(/\s+/);

function normalizeExplicitCityWithSuffix(cityName: string): string {
  // "芒市"是完整行政区划名，不是"芒"+"市"。
  if (cityName === '芒市') return cityName;
  return cityName.replace(/市$/, '');
}

export const NATIONAL_CITY_SUFFIX_TO_CITY: Record<string, string> = Object.fromEntries(
  NATIONAL_CITY_NAMES_WITH_SUFFIX.map((cityName) => [
    cityName,
    normalizeExplicitCityWithSuffix(cityName),
  ]),
);

/**
 * 海绵按“地级 city + 县级 region”存储的县级市映射。
 *
 * 消息扫描只使用带“市”后缀的完整名称，避免裸“延吉/珲春”等道路、门店名误命中；
 * cityNameList 这类语义明确的工具参数可在边界层兼容裸名称。
 */
export const COUNTY_LEVEL_CITY_TO_PREFECTURE: Record<string, string> = {
  延吉市: '延边朝鲜族自治州',
  图们市: '延边朝鲜族自治州',
  敦化市: '延边朝鲜族自治州',
  珲春市: '延边朝鲜族自治州',
  龙井市: '延边朝鲜族自治州',
  和龙市: '延边朝鲜族自治州',
};

/**
 * 县级行政区（区/县/县级市）→ 所属地级城市
 *
 * 仅收录高置信度、无歧义的区名（多个城市共享的区名必须排除，避免误判）。
 * extractor 对本轮消息里抽到的区直接走这张表推导城市。
 */
export const DISTRICT_TO_CITY: Record<string, string> = {
  // 北京
  东城: '北京',
  西城: '北京',
  朝阳: '北京',
  海淀: '北京',
  丰台: '北京',
  石景山: '北京',
  门头沟: '北京',
  房山: '北京',
  通州: '北京',
  顺义: '北京',
  昌平: '北京',
  大兴: '北京',
  怀柔: '北京',
  平谷: '北京',
  密云: '北京',
  延庆: '北京',
  // 上海
  黄浦: '上海',
  徐汇: '上海',
  长宁: '上海',
  静安: '上海',
  普陀: '上海',
  虹口: '上海',
  杨浦: '上海',
  浦东: '上海',
  浦东新区: '上海',
  闵行: '上海',
  宝山: '上海',
  嘉定: '上海',
  金山: '上海',
  松江: '上海',
  青浦: '上海',
  奉贤: '上海',
  崇明: '上海',
  // 南京
  栖霞: '南京',
  六合: '南京',
  // 武汉
  江岸: '武汉',
  江汉: '武汉',
  硚口: '武汉',
  汉阳: '武汉',
  武昌: '武汉',
  青山: '武汉',
  洪山: '武汉',
  东西湖: '武汉',
  汉南: '武汉',
  蔡甸: '武汉',
  江夏: '武汉',
  黄陂: '武汉',
  新洲: '武汉',
  东湖高新区: '武汉',
  光谷: '武汉',
  // 宁波
  海曙: '宁波',
  江北: '宁波',
  镇海: '宁波',
  北仑: '宁波',
  鄞州: '宁波',
  奉化: '宁波',
  余姚: '宁波',
  慈溪: '宁波',
  宁海: '宁波',
  象山: '宁波',
  // 南昌
  东湖: '南昌',
  西湖: '南昌',
  青云谱: '南昌',
  青山湖: '南昌',
  新建: '南昌',
  红谷滩: '南昌',
  南昌县: '南昌',
  南昌: '南昌',
  安义: '南昌',
  进贤: '南昌',
  湾里: '南昌',
  // 宜昌
  西陵: '宜昌',
  伍家岗: '宜昌',
  点军: '宜昌',
  猇亭: '宜昌',
  夷陵: '宜昌',
  宜都: '宜昌',
  当阳: '宜昌',
  枝江: '宜昌',
  远安: '宜昌',
  兴山: '宜昌',
  秭归: '宜昌',
  长阳: '宜昌',
  五峰: '宜昌',
  // 荆州
  荆州: '荆州',
  沙市: '荆州',
  公安: '荆州',
  石首: '荆州',
  洪湖: '荆州',
  松滋: '荆州',
  监利: '荆州',
  江陵: '荆州',
  // 黄冈
  黄州: '黄冈',
  团风: '黄冈',
  红安: '黄冈',
  麻城: '黄冈',
  罗田: '黄冈',
  英山: '黄冈',
  浠水: '黄冈',
  蕲春: '黄冈',
  黄梅: '黄冈',
  武穴: '黄冈',
  // 襄阳
  襄城: '襄阳',
  樊城: '襄阳',
  襄州: '襄阳',
  南漳: '襄阳',
  谷城: '襄阳',
  保康: '襄阳',
  老河口: '襄阳',
  枣阳: '襄阳',
  宜城: '襄阳',
  // 赣州
  章贡: '赣州',
  南康: '赣州',
  赣县: '赣州',
  信丰: '赣州',
  大余: '赣州',
  上犹: '赣州',
  崇义: '赣州',
  安远: '赣州',
  定南: '赣州',
  全南: '赣州',
  宁都: '赣州',
  于都: '赣州',
  兴国: '赣州',
  会昌: '赣州',
  寻乌: '赣州',
  石城: '赣州',
  瑞金: '赣州',
  龙南: '赣州',
  // 恩施
  恩施: '恩施',
  利川: '恩施',
  建始: '恩施',
  巴东: '恩施',
  宣恩: '恩施',
  咸丰: '恩施',
  来凤: '恩施',
  鹤峰: '恩施',
  ...COUNTY_LEVEL_CITY_TO_PREFECTURE,
};

/**
 * 热门地点/商圈/地标 → 城市
 *
 * 仅收录高置信度、跨城市唯一的名称。
 */
export const LOCATION_TO_CITY: Record<string, string> = {
  // 上海
  陆家嘴: '上海',
  徐家汇: '上海',
  五角场: '上海',
  张江: '上海',
  九亭: '上海',
  七宝: '上海',
  莘庄: '上海',
  虹桥火车站: '上海',
  世纪公园: '上海',
  迪士尼: '上海',
  临港: '上海',
  外滩: '上海',
  // 武汉
  光谷: '武汉',
  江汉路: '武汉',
  楚河汉街: '武汉',
  街道口: '武汉',
  王家湾: '武汉',
  徐东: '武汉',
  藏龙岛: '武汉',
  沌口: '武汉',
  武广: '武汉',
  汉口火车站: '武汉',
  武昌火车站: '武汉',
  武汉天地: '武汉',
  // 宁波
  天一广场: '宁波',
  南塘老街: '宁波',
  东部新城: '宁波',
  老外滩: '宁波',
  东钱湖: '宁波',
  宁波大学: '宁波',
  宁波站: '宁波',
  // 北京
  望京: '北京',
  中关村: '北京',
  西二旗: '北京',
  三里屯: '北京',
  回龙观: '北京',
  天通苑: '北京',
  亦庄: '北京',
  五道口: '北京',
  后厂村: '北京',
  国贸: '北京',
  亦庄开发区: '北京',
  // 南昌
  红谷滩: '南昌',
  八一广场: '南昌',
  瑶湖: '南昌',
  秋水广场: '南昌',
  万寿宫: '南昌',
  滕王阁: '南昌',
  // 恩施
  女儿城: '恩施',
  土司城: '恩施',
  恩施广场: '恩施',
  // 宜昌
  夷陵广场: '宜昌',
  水悦城: '宜昌',
  万达广场宜昌: '宜昌',
  宜昌东站: '宜昌',
  // 荆州
  沙市: '荆州',
  吾悦广场荆州: '荆州',
  荆州万达: '荆州',
  // 黄冈
  黄州: '黄冈',
  遗爱湖: '黄冈',
  黄冈万达: '黄冈',
  // 襄阳
  襄城: '襄阳',
  樊城: '襄阳',
  唐城: '襄阳',
  襄阳东站: '襄阳',
  // 赣州
  南门口: '赣州',
  万象城赣州: '赣州',
  九方: '赣州',
  郁孤台: '赣州',
};

/**
 * 跨城同名的"通用后缀"——命中即视为高歧义地名。
 *
 * 这类地名（万达广场、火车站、人民公园 …）在多个城市都有同名 POI，
 * 仅凭 LLM 通识根本无法唯一对应某城市。geocode 工具命中这条黑名单时
 * 强制 Agent 先反问候选人城市，禁止凭通识补 city。
 *
 * 与"白名单 + 通识"的分工：白名单（DISTRICT_TO_CITY / LOCATION_TO_CITY）
 * 是高置信唯一对应；本黑名单是高置信非唯一。两者之间的灰区交给
 * LLM 通识 + geocode 多候选验证。
 *
 * 维护原则：
 * - 严格的"以此结尾或完整等于"匹配，避免误伤"川沙百联购物中心"这种实际唯一的 POI
 * - 仅收录确实跨城同名 ≥3 个城市的后缀
 * - 交通站点后缀（火车站/地铁站 等）带 ≥2 字专名前缀时不视为歧义（"漕宝路地铁站"
 *   "上海火车站"的前缀本身就是专名），交给 geocode 全国搜索 + 多城三态收敛兜真歧义；
 *   连锁商业体（万达广场/天街 等）的前缀多为跨城重复的区片名，维持整体命中
 */
export const GENERIC_AMBIGUOUS_SUFFIXES = [
  // 连锁商业地产（跨城同名重灾区）
  '万达广场',
  '万象城',
  '吾悦广场',
  '银泰',
  '天街',
  '印象城',
  '砂之船',
  '大悦城',
  // 通用商业类型词
  '购物中心',
  '商场',
  '广场',
  '步行街',
  '商业街',
  '美食街',
  // 交通枢纽（带专名前缀时由 hasGenericAmbiguousSuffix 放行）
  '火车站',
  '高铁站',
  '汽车站',
  '客运站',
  '地铁站',
  // 公共设施
  '大学',
  '学院',
  '医院',
  '人民公园',
  '人民广场',
  '中心医院',
] as const;

/**
 * 交通站点类后缀。"X地铁站/X火车站"的前缀 X 是站点专名（漕宝路/虹桥），
 * 与连锁商业体的"区片名前缀"不同，专名前缀足以让高德唯一定位或暴露真歧义。
 */
const TRANSPORT_STATION_SUFFIXES: ReadonlySet<string> = new Set([
  '火车站',
  '高铁站',
  '汽车站',
  '客运站',
  '地铁站',
]);

/** 交通站点后缀放行所需的最短专名前缀字数（"南地铁站"仍视为歧义，"漕宝路地铁站"放行）。 */
const MIN_STATION_PREFIX_LENGTH = 2;

/** 站点前缀本身仍是通名的情况（"长途汽车站""中心客运站"），照旧按跨城歧义处理。 */
const GENERIC_STATION_PREFIXES: ReadonlySet<string> = new Set([
  '长途',
  '公交',
  '旅游',
  '中心',
  '汽车',
  '客运',
  '城际',
  '轨道',
  '高速',
]);

/**
 * 判定地名是否命中"通用后缀黑名单"。
 *
 * 匹配规则：完整等于 / 以后缀结尾。不做"包含"匹配，防止误伤
 * "万达广场店"" 万达广场南门" 这类本地化别称（这些通常是单点 POI）。
 *
 * 例外：交通站点后缀带 ≥2 字专名前缀（"漕宝路地铁站"）不算命中——
 * 这类名字不是跨城通名，强制反问城市会闹出"候选人报了地标还被问在哪个城市"
 * 的倒退体验；放给 geocode 全国搜索，真撞名（如"体育中心地铁站"）由
 * 多城 ambiguous 路径列清单反问。
 */
export function hasGenericAmbiguousSuffix(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return GENERIC_AMBIGUOUS_SUFFIXES.some((suffix) => {
    if (trimmed !== suffix && !trimmed.endsWith(suffix)) return false;
    if (TRANSPORT_STATION_SUFFIXES.has(suffix)) {
      const prefix = trimmed.slice(0, trimmed.length - suffix.length);
      return prefix.length < MIN_STATION_PREFIX_LENGTH || GENERIC_STATION_PREFIXES.has(prefix);
    }
    return true;
  });
}

/**
 * 归一化后可去掉的后缀（"区/县/镇"等）。
 * extractor 在查找 DISTRICT_TO_CITY 前会用这个规则再试一次。
 */
export function normalizeDistrictForLookup(district: string): string {
  if (district.endsWith('开发区') || district.endsWith('新区')) return district;
  if (district.endsWith('街道')) return district.replace(/街道$/, '');
  return district.replace(/[区县镇乡]$/, '');
}

/** 把城市名归一化（去掉"市"后缀）。 */
export function normalizeCityName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/市$/, '');
  return normalized || null;
}

/**
 * 单个 district 名 → 城市（命中白名单则返回 city，否则 null）。
 * 兼容 "青浦" 和 "青浦区" 两种形式（白名单只存归一化后的形式）。
 */
export function resolveCityFromDistrict(candidate: string): string | null {
  const normalized = normalizeDistrictForLookup(candidate);
  return DISTRICT_TO_CITY[candidate] ?? DISTRICT_TO_CITY[normalized] ?? null;
}

export interface WhitelistScanHit {
  /** 命中的白名单 key */
  key: string;
  /** key 在消息中起始位置（0-based） */
  start: number;
  /** key 在消息中结束位置（exclusive） */
  end: number;
}

export interface WhitelistScanResult {
  hits: WhitelistScanHit[];
  /** 字符级覆盖标记，长度 === message.length，供后续扫描复用以避免重叠匹配 */
  covered: boolean[];
}

/**
 * "白名单驱动 + 最长优先"扫描器：给定消息与字典，按 key 长度降序找出所有非重叠命中。
 *
 * 这是地理识别的核心机制——把"贪婪正则吞整段 → 事后清洗"反过来：
 * 先用白名单做最长精确匹配（数据驱动，扩白名单即扩能力），未覆盖的字符段交给
 * 正则兜底（识别白名单外的"XX区/镇/街道"，但不补 city，留给 LLM 处理）。
 *
 * 设计要点：
 * - 按 key 长度降序遍历，确保 "浦东新区" 先于 "浦东" 被消费，不会被 "浦东" 提前占用
 * - 通过 `preCovered` 串联多轮扫描（city → district → location），后续轮次不会
 *   再去吃前面已认领的字符段，天然避免歧义
 * - hits 按 start 升序返回，方便上游"开头紧凑表达"的判定
 */
export function scanWhitelistKeysByLongest(
  message: string,
  dict: Readonly<Record<string, unknown>>,
  preCovered?: readonly boolean[],
): WhitelistScanResult {
  const len = message.length;
  const covered: boolean[] = preCovered
    ? Array.from({ length: len }, (_, i) => preCovered[i] ?? false)
    : new Array(len).fill(false);

  const hits: WhitelistScanHit[] = [];
  const sortedKeys = Object.keys(dict)
    .filter((key) => key.length > 0 && key.length <= len)
    .sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    let from = 0;
    while (from <= len - key.length) {
      const idx = message.indexOf(key, from);
      if (idx < 0) break;
      const end = idx + key.length;
      let collides = false;
      for (let i = idx; i < end; i++) {
        if (covered[i]) {
          collides = true;
          break;
        }
      }
      if (collides) {
        from = idx + 1;
        continue;
      }
      hits.push({ key, start: idx, end });
      for (let i = idx; i < end; i++) covered[i] = true;
      from = end;
    }
  }

  hits.sort((a, b) => a.start - b.start);
  return { hits, covered };
}

/**
 * 在指定字符级覆盖之外的连续区间上跑一次正则匹配，用于"白名单兜底"。
 *
 * 调用者通常已经先跑完 city/district/location 三轮白名单扫描，未覆盖的字符段
 * 才是真正"白名单未识别"的部分；这里在这些段上跑 [一-龥]+(?:区|县|镇|街道|新区|开发区)
 * 之类的正则去捕获白名单外的 raw district——但仅作为 district 标注，不补 city。
 */
export function matchInUncoveredSegments(
  message: string,
  covered: readonly boolean[],
  pattern: RegExp,
): string[] {
  const segments: string[] = [];
  let buf = '';
  for (let i = 0; i < message.length; i++) {
    if (covered[i]) {
      if (buf) {
        segments.push(buf);
        buf = '';
      }
    } else {
      buf += message[i];
    }
  }
  if (buf) segments.push(buf);

  const matches: string[] = [];
  for (const segment of segments) {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const globalPattern = new RegExp(pattern.source, flags);
    for (const m of segment.matchAll(globalPattern)) {
      if (m[1] !== undefined) matches.push(m[1]);
      else if (m[0]) matches.push(m[0]);
    }
  }
  return matches;
}

/** 单个 location/商圈名 → 城市（命中白名单则返回 city，否则 null）。 */
export function resolveCityFromLocation(candidate: string): string | null {
  const normalized = candidate.replace(/\s+/g, '');
  return LOCATION_TO_CITY[candidate] ?? LOCATION_TO_CITY[normalized] ?? null;
}

/**
 * 从 district / location 列表里查白名单，命中后返回带证据的 city。
 *
 * 这是"代码白名单作为城市识别唯一真相源"的入口：上游的 LLM session 提取按 prompt
 * 要求对单独的"区/镇/街道"留 null city（防跨城同名），但白名单恰好已经把跨城同名
 * 排除，剩下的（青浦/浦东/朝阳/海淀…）应当无歧义地补出来。此函数让确定性兜底逻
 * 辑覆盖 LLM 的保守留空，避免"高置信明明能识别，sessionFacts 却 city=null"的尴尬。
 */
export function resolveCityFromGeoSignals(
  districts: readonly string[] | null | undefined,
  locations: readonly string[] | null | undefined,
): { value: string; evidence: 'unique_district_alias' | 'hotspot_alias' } | null {
  for (const district of districts ?? []) {
    const city = resolveCityFromDistrict(district);
    if (city) return { value: city, evidence: 'unique_district_alias' };
  }
  for (const location of locations ?? []) {
    const city = resolveCityFromLocation(location);
    if (city) return { value: city, evidence: 'hotspot_alias' };
  }
  return null;
}
