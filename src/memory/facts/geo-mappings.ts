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
 * 区/县名 → 所属城市
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
  // 交通枢纽
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
 * 判定地名是否命中"通用后缀黑名单"。
 *
 * 匹配规则：完整等于 / 以后缀结尾。不做"包含"匹配，防止误伤
 * "万达广场店"" 万达广场南门" 这类本地化别称（这些通常是单点 POI）。
 */
export function hasGenericAmbiguousSuffix(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return GENERIC_AMBIGUOUS_SUFFIXES.some(
    (suffix) => trimmed === suffix || trimmed.endsWith(suffix),
  );
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
