/**
 * 行政区解析（自 memory/facts/geo-mappings.ts 行为等价迁移，Phase 1）。
 *
 * resolveParentAdministrativeArea 为 §8.3 新增查询 API（替代直接读取
 * COUNTY_LEVEL_CITY_TO_PREFECTURE 数据表），语义与岗位工具边界的县级市
 * 兼容规则一致：允许兼容裸名称，因为调用方（cityNameList 等结构化参数）
 * 已表达明确语义；自由文本扫描仍只命中"延吉市"这种显式后缀。
 */

import type { GeoSignalConflictShadow, ParentAdministrativeArea } from './geo.types';
import {
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
  UNIQUE_SUBDIVISION_TO_CITY,
  HIGH_CONFIDENCE_BARE_LOCATION_ALIASES,
} from './administrative-division.data';
import { NATIONAL_CITY_SUFFIX_TO_CITY } from './explicit-city.data';
import { NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE } from './administrative-division.generated';
import { normalizeCityName, normalizeDistrictForLookup } from './geo-name.normalizer';
import { resolveCityFromLocation } from './place-alias.resolver';

/**
 * 全国县级市映射灰度开关（方案 §17.2，Phase 4 短期开关，收敛后删除）。
 *
 * geo 域零依赖、非 Nest module，无法走 ConfigService；直接读 process.env
 * 是方案预期内的短期形态。每次调用实时读取（不缓存），便于测试与运维即改即生效。
 */
function isNationalCountyMappingEnabled(): boolean {
  return process.env.GEO_NATIONAL_COUNTY_MAPPING_ENABLED === 'true';
}

/** 已知城市名全集：业务高置信裸地名别名 + 全国显式城市表的标准名（去重）。 */
const KNOWN_CITY_NAMES: readonly string[] = [
  ...HIGH_CONFIDENCE_BARE_LOCATION_ALIASES,
  ...new Set(Object.values(NATIONAL_CITY_SUFFIX_TO_CITY)),
];

/**
 * 仓库行政区数据中的 canonical 城市/地级行政区名称。
 *
 * 供结构化字段做成员判定；自由文本仍必须走 scanGeoSignalsFromText，不能用本集合
 * 做裸词扫描。集合留在 geo 域内，避免消费方依赖生成数据表实现细节。
 */
const KNOWN_CANONICAL_ADMINISTRATIVE_AREA_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(NATIONAL_CITY_SUFFIX_TO_CITY),
  ...Object.values(NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE),
]);

export function isKnownCanonicalAdministrativeAreaName(input: string): boolean {
  return KNOWN_CANONICAL_ADMINISTRATIVE_AREA_NAMES.has(input.trim());
}

/** 民族自治地方的通名后缀——这类 canonical 名在结构化字段里常被写成去族名的简称。 */
const MULTI_ETHNIC_AREA_SUFFIX = /(?:自治州|自治区|地区|盟)$/u;

/**
 * 民族自治地方 canonical 名的前缀索引（长度 ≥2）。
 *
 * "巴音郭楞" 指的就是 "巴音郭楞蒙古自治州"，但简称本身不在 canonical 集合里。
 * 族名部分写法不定（蒙古/朝鲜族/柯尔克孜…），与其枚举族名不如索引前缀。
 * 只对民族自治地方建索引：地级市走 canonical 精确命中即可，全表建前缀会把
 * "呼和""石家" 这类残缺串也认成合法城市。
 */
const MULTI_ETHNIC_AREA_NAME_PREFIXES: ReadonlySet<string> = (() => {
  const prefixes = new Set<string>();
  for (const name of KNOWN_CANONICAL_ADMINISTRATIVE_AREA_NAMES) {
    if (!MULTI_ETHNIC_AREA_SUFFIX.test(name)) continue;
    for (let length = 2; length < name.length; length += 1) {
      prefixes.add(name.slice(0, length));
    }
  }
  return prefixes;
})();

/**
 * 结构化字段里的"城市值"能否被行政区数据认领（会话事实写入门 + geocode 冲突门共用）。
 *
 * 判定口径是"这是不是一个城市"，不是"这是不是一个地名"：区/镇/街道一律判否——
 * 它们的归属地由 resolveCityFromDistrict / resolveCityFromGeoSignals 另行解析，
 * 占着 pref.city 只会让城市门拿到错误结论。
 *
 * 存在的原因（2026-08-06 生产观测）：抽取污染把 `hello` / `null` / `只晚班` /
 * `我是应聘的` 这类短串写进 pref.city，纯形状门（长度 + 标点 + 疑问尾词）对它们
 * 全部放行，下游 geocode 据此发出"你现在是在上海市这边找工作吗"的多余反问。
 * 短串靠形状分辨不了真假城市，只能靠数据表认领。
 */
export function isRecognizedCityName(value: string | null | undefined): boolean {
  const bare = normalizeCityName(value);
  if (!bare || bare.length < 2) return false;
  if (isKnownCanonicalAdministrativeAreaName(bare)) return true;
  return MULTI_ETHNIC_AREA_NAME_PREFIXES.has(bare);
}

/**
 * 单个 district 名 → 城市（命中白名单则返回 city，否则 null）。
 * 兼容 "青浦" 和 "青浦区" 两种形式（白名单只存归一化后的形式）。
 */
export function resolveCityFromDistrict(candidate: string): string | null {
  const normalized = normalizeDistrictForLookup(candidate);
  return UNIQUE_SUBDIVISION_TO_CITY[candidate] ?? UNIQUE_SUBDIVISION_TO_CITY[normalized] ?? null;
}

/**
 * 从 district / location 列表里查白名单，命中后返回带证据的 city。
 *
 * 这是"代码白名单作为城市识别唯一真相源"的入口：上游的 LLM session 提取按 prompt
 * 要求对单独的"区/镇/街道"留 null city（防跨城同名），但白名单恰好已经把跨城同名
 * 排除，剩下的（青浦/浦东/朝阳/海淀…）应当无歧义地补出来。此函数让确定性兜底逻
 * 辑覆盖 LLM 的保守留空，避免"高置信明明能识别，sessionFacts 却 city=null"的尴尬。
 *
 * 现状语义 = 先命中先赢（先区县后地标，命中即返回）。多信号指向不同城市时的
 * 冲突出口按方案 §8.2/Phase 3 以 shadow 档另行落地，本函数迁移期行为不变
 * （Phase 0 golden case 锁定）。
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

/**
 * 地理信号冲突检测——shadow 档（§8.2 / Phase 3 第 6 步）。
 *
 * 与 resolveCityFromGeoSignals 的先命中先赢不同，本函数扫描**全部**信号并
 * 收集去重后的城市候选；≥2 个不同城市即"本应 ambiguous"（现网实证：
 * badcase xnp1u820 "成都的 + 静安区"、i2vljy1u）。仅供观测落 GeoQueryMeta，
 * 不参与任何行为决策；**enforce 已于 2026-08-14 终审 no-go，不再是待办**——3 周生产
 * shadow（约 22,800 回合）累计 25 起样本，逐条分类后真冲突 0 起，噪音全部是地标别名
 * 与跨层级同形地名（长阳、宝山中街），详见 docs/architecture/geo-resolution.md §9.3。
 * 本函数保留为排障线索（判断城市判错是否源于别名误命中），不要再按"待决策"推动。
 */
export function detectGeoSignalConflict(
  districts: readonly string[] | null | undefined,
  locations: readonly string[] | null | undefined,
  options?: {
    /**
     * 会话内已确立的城市。给出且命中某个候选时，判定为"已被已知城市裁决"——
     * 返回值带 `adjudicatedByKnownCity`，消费方须视为**非真冲突**（见 §17.4.1）。
     *
     * 注意作用域：enforce 的落点 `backfillCityFromWhitelist` 仅在 city 为空时才运行，
     * 那里天然拿不到已知城市，故本参数**对 enforce 无效**，只服务岗位工具侧的
     * shadow 观测降噪。真正降低 enforce 误伤面的是脏别名清表
     * （DIRTY_ALIAS_EXCLUSIONS + geo:validate 检查项 8）。
     */
    knownCity?: string | null;
  },
): GeoSignalConflictShadow | null {
  const candidates: GeoSignalConflictShadow['candidates'] = [];
  const seenCities = new Set<string>();
  const push = (
    city: string | null,
    evidence: 'unique_district_alias' | 'hotspot_alias',
    matchedText: string,
  ) => {
    if (!city || seenCities.has(city)) return;
    seenCities.add(city);
    candidates.push({ city, evidence, matchedText });
  };
  for (const district of districts ?? []) {
    push(resolveCityFromDistrict(district), 'unique_district_alias', district);
  }
  for (const location of locations ?? []) {
    push(resolveCityFromLocation(location), 'hotspot_alias', location);
  }
  if (candidates.length < 2) return null;

  const knownCity = normalizeCityName(options?.knownCity);
  const adjudicated = knownCity
    ? candidates.find((candidate) => normalizeCityName(candidate.city) === knownCity)
    : undefined;

  return {
    candidates,
    firstHitCity: candidates[0].city,
    ...(adjudicated ? { adjudicatedByKnownCity: adjudicated.city } : {}),
  };
}

/**
 * 县级行政区 → 上级地级行政区查询（§8.3）。
 *
 * resolveParentAdministrativeArea('延吉') →
 *   { input:'延吉', canonicalName:'延吉市', level:'county_level_city', parentCity:'延边朝鲜族自治州' }
 *
 * 查询顺序：人工策展表（COUNTY_LEVEL_CITY_TO_PREFECTURE，海绵口径逐条实证）始终
 * 优先；未命中且 GEO_NATIONAL_COUNTY_MAPPING_ENABLED=true 时回退全国生成表
 * （administrative-division.generated.ts，Phase 4 灰度接入）。开关关闭时未收录
 * 条目（含待补录的余姚/慈溪类）返回 null，不猜父级。
 */
export function resolveParentAdministrativeArea(input: string): ParentAdministrativeArea | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const canonicalName = trimmed.endsWith('市') ? trimmed : `${trimmed}市`;
  const curatedParent = COUNTY_LEVEL_CITY_TO_PREFECTURE[canonicalName];
  if (curatedParent) {
    return { input, canonicalName, level: 'county_level_city', parentCity: curatedParent };
  }
  if (isNationalCountyMappingEnabled()) {
    const nationalParent = NATIONAL_COUNTY_LEVEL_CITY_TO_PREFECTURE[canonicalName];
    if (nationalParent) {
      return { input, canonicalName, level: 'county_level_city', parentCity: nationalParent };
    }
  }
  return null;
}

/**
 * 区名唯一映射的全量条目（district → city）只读视图。
 *
 * 供跨域消费方（brand 城市同形词门槛按城市索引区名后缀）建索引；Record 本身
 * 不作为公共 API（§8.1 终态原则：行政区关系一律通过 resolver 查询）。
 */
export function listUniqueDistrictCityEntries(): ReadonlyArray<readonly [string, string]> {
  return Object.entries(UNIQUE_SUBDIVISION_TO_CITY);
}

/**
 * 文本是否以已知城市名开头、且后面还有更具体内容（"常州钟楼区" → true，"常州" → false）。
 *
 * 供 infra/geocoding 的查询分类器判断"文本自带城市线索、可走结构化地址"（§11.1 消费场景）。
 * 替代消费方直接拼接 HIGH_CONFIDENCE_BARE_LOCATION_ALIASES / NATIONAL_CITY_SUFFIX_TO_CITY 数据表
 * （§8.1 过渡期导出收口，Phase 5）。
 */
export function hasKnownCityPrefix(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KNOWN_CITY_NAMES.some((city) => trimmed.startsWith(city) && trimmed.length > city.length);
}
