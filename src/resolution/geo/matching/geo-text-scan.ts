/**
 * 自由文本三轮扫描编排（方案 §8.4，自 memory/facts/high-confidence-facts.ts
 * 私有段平移，Phase 2；行为由 Phase 0 golden cases 锁定）。
 *
 * 编排顺序：显式城市 → 高置信区县 → 唯一地标 → 未覆盖段正则兜底，
 * 字符覆盖逐轮继承。扫哪张表、按什么顺序、覆盖如何继承，本身就是地理领域
 * 决策，唯一居所在此；memory 只消费扫描结果，决定如何写入 sessionFacts
 * （置信度生命周期仍归 memory）。
 */

import type { GeoTextScanCity, GeoTextScanResult, WhitelistScanResult } from '../geo.types';
import {
  DISTRICT_TO_CITY,
  MUNICIPALITIES,
  SUPPORTED_CITY_PREFIXES,
} from '../admin/administrative-division.data';
import { NATIONAL_CITY_SUFFIX_TO_CITY } from '../admin/explicit-city.data';
import { LOCATION_TO_CITY } from '../places/place-alias.data';
import { normalizeDistrictForLookup } from '../normalization/geo-name.normalizer';
import { matchInUncoveredSegments, scanWhitelistKeysByLongest } from './whitelist-scanner';

/**
 * 城市识别词典：直辖市 + 已支持城市前缀去重后的精确匹配集合。
 * 给 scanWhitelistKeysByLongest 作为 city 维度的输入。
 */
const CITY_DICT: Record<string, true> = Object.fromEntries(
  Array.from(new Set<string>([...MUNICIPALITIES, ...SUPPORTED_CITY_PREFIXES])).map((city) => [
    city,
    true,
  ]),
);

/** 正则兜底：在白名单未覆盖区间识别"白名单外的 raw district"（不补 city）。 */
const RAW_DISTRICT_PATTERN = /([一-龥]{2,10}(?:区|县|镇|街道|新区|开发区))/g;

/**
 * 三轮串联扫描 + city 推导（平移自 extractLocation 的白名单扫描段）。
 *
 * 返回三类命中（含位置）、推导 city（带 evidence）、归一化区县合集
 * （白名单命中 ∪ 未覆盖段 raw district，已剥前缀噪音、去重保序）与地标命中。
 * 位置分享 / "XX附近" 等消息形态相关的抽取不在本函数职责内，由 memory 侧补充。
 */
export function scanGeoSignalsFromText(message: string): GeoTextScanResult {
  // 三轮串联扫描，covered 区间逐轮累积，避免后轮再去消费前轮已认领的字符
  const cityScan = scanWhitelistKeysByLongest(message, CITY_DICT);
  const districtScan = scanWhitelistKeysByLongest(message, DISTRICT_TO_CITY, cityScan.covered);
  const locationScan = scanWhitelistKeysByLongest(message, LOCATION_TO_CITY, districtScan.covered);

  const city = resolveCity(message, cityScan, districtScan, locationScan);

  // district：白名单命中（归一化后） + 未覆盖区间正则兜底（白名单外，城市未知）
  const whitelistDistricts = districtScan.hits.map((hit) => normalizeDistrictForLookup(hit.key));
  const rawDistricts = matchInUncoveredSegments(
    message,
    locationScan.covered,
    RAW_DISTRICT_PATTERN,
  ).map(normalizeRawDistrict);
  const districts = Array.from(new Set([...whitelistDistricts, ...rawDistricts].filter(Boolean)));

  return {
    city,
    cityHits: cityScan.hits,
    districtHits: districtScan.hits,
    locationHits: locationScan.hits,
    districts,
    locations: locationScan.hits.map((hit) => hit.key),
  };
}

/**
 * 综合三轮扫描结果推导 city（带 evidence）。
 *
 * 优先级：白名单 city > district 反推 > location 反推 > 通用"XX市"正则兜底。
 *
 * evidence 细分：
 *   - `municipality_compact`：直辖市开头（start=0）且紧接 district 命中（"上海浦东"）
 *   - `explicit_city`：其他 city 白名单命中或全国显式"XX市"匹配
 *   - `unique_district_alias`：从 district 反推（无歧义区名）
 *   - `hotspot_alias`：从 location/商圈反推
 */
function resolveCity(
  message: string,
  cityScan: WhitelistScanResult,
  districtScan: WhitelistScanResult,
  locationScan: WhitelistScanResult,
): GeoTextScanCity | null {
  const cityHit = cityScan.hits[0];
  if (cityHit) {
    const isMunicipality = (MUNICIPALITIES as readonly string[]).includes(cityHit.key);
    const hasTightDistrict = districtScan.hits.some((d) => d.start === cityHit.end);
    const evidence =
      isMunicipality && cityHit.start === 0 && hasTightDistrict
        ? 'municipality_compact'
        : 'explicit_city';
    return { value: cityHit.key, evidence };
  }

  const districtHit = districtScan.hits[0];
  if (districtHit) {
    return {
      value: DISTRICT_TO_CITY[districtHit.key],
      evidence: 'unique_district_alias',
    };
  }

  const locationHit = locationScan.hits[0];
  if (locationHit) {
    return {
      value: LOCATION_TO_CITY[locationHit.key],
      evidence: 'hotspot_alias',
    };
  }

  // 全国城市名表兜底：只接受真实"XX市"行政区划名，避免"大超市/夜市"误提取。
  const nationalCityScan = scanWhitelistKeysByLongest(
    message,
    NATIONAL_CITY_SUFFIX_TO_CITY,
    locationScan.covered,
  );
  const nationalCityHit = nationalCityScan.hits[0];
  if (nationalCityHit) {
    return {
      value: NATIONAL_CITY_SUFFIX_TO_CITY[nationalCityHit.key],
      evidence: 'explicit_city',
    };
  }

  return null;
}

function normalizeRawDistrict(candidate: string): string {
  // 兜底场景：候选词来自"白名单未覆盖区间"。理论上不含已识别的区名，但仍可能整段
  // 被正则吃进来（如完全在白名单外的城市的区），所以复用旧版前缀剥离 + 后缀归一化
  // 作最后一层保险。
  const withoutPrefix = candidate
    .replace(/^[\u4e00-\u9fa5]{2,12}省/, '')
    .replace(/^[\u4e00-\u9fa5]{2,12}市/, '')
    .replace(/^(?:你好|您好|哈喽|嗨)/, '')
    .replace(/^(?:我在|人在|住在|我住|目前在|现在在|今天在|平时在|在)/, '');
  return normalizeDistrictForLookup(withoutPrefix);
}
