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
import { normalizeDistrictForLookup } from './geo-name.normalizer';
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
 * 不参与任何行为决策；enforce 切换需 shadow 观测 1~2 周后人工决策（§17.4）。
 */
export function detectGeoSignalConflict(
  districts: readonly string[] | null | undefined,
  locations: readonly string[] | null | undefined,
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
  return { candidates, firstHitCity: candidates[0].city };
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
 * 文本是否以已知城市名开头、且后面还有更具体内容（"常州钟楼区" → true，"常州" → false）。
 *
 * 供 infra/geocoding 的查询分类器判断"文本自带城市线索、可走结构化地址"（§11.1 消费场景）。
 * 替代消费方直接拼接 HIGH_CONFIDENCE_BARE_LOCATION_ALIASES / NATIONAL_CITY_SUFFIX_TO_CITY 数据表
 * （§8.1 过渡期导出收口，Phase 5）。
 */
/**
 * 区名唯一映射的全量条目（district → city）只读视图。
 *
 * 供跨域消费方（brand 城市同形词门槛按城市索引区名后缀）建索引；Record 本身
 * 不作为公共 API（§8.1 终态原则：行政区关系一律通过 resolver 查询）。
 */
export function listUniqueDistrictCityEntries(): ReadonlyArray<readonly [string, string]> {
  return Object.entries(UNIQUE_SUBDIVISION_TO_CITY);
}

export function hasKnownCityPrefix(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KNOWN_CITY_NAMES.some((city) => trimmed.startsWith(city) && trimmed.length > city.length);
}
