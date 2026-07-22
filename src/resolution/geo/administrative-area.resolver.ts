/**
 * 行政区解析（自 memory/facts/geo-mappings.ts 行为等价迁移，Phase 1）。
 *
 * resolveParentAdministrativeArea 为 §8.3 新增查询 API（替代直接读取
 * COUNTY_LEVEL_CITY_TO_PREFECTURE 数据表），语义与岗位工具边界的县级市
 * 兼容规则一致：允许兼容裸名称，因为调用方（cityNameList 等结构化参数）
 * 已表达明确语义；自由文本扫描仍只命中"延吉市"这种显式后缀。
 */

import type { GeoSignalConflictShadow, ParentAdministrativeArea } from './geo.types';
import { COUNTY_LEVEL_CITY_TO_PREFECTURE, DISTRICT_TO_CITY } from './administrative-division.data';
import { normalizeDistrictForLookup } from './geo-name.normalizer';
import { resolveCityFromLocation } from './place-alias.resolver';

/**
 * 单个 district 名 → 城市（命中白名单则返回 city，否则 null）。
 * 兼容 "青浦" 和 "青浦区" 两种形式（白名单只存归一化后的形式）。
 */
export function resolveCityFromDistrict(candidate: string): string | null {
  const normalized = normalizeDistrictForLookup(candidate);
  return DISTRICT_TO_CITY[candidate] ?? DISTRICT_TO_CITY[normalized] ?? null;
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
 * 未收录（含待 Phase 3 补录的余姚/慈溪类）返回 null，不猜父级。
 */
export function resolveParentAdministrativeArea(input: string): ParentAdministrativeArea | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const canonicalName = trimmed.endsWith('市') ? trimmed : `${trimmed}市`;
  const parentCity = COUNTY_LEVEL_CITY_TO_PREFECTURE[canonicalName];
  if (!parentCity) return null;
  return { input, canonicalName, level: 'county_level_city', parentCity };
}
