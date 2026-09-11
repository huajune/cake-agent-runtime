/**
 * 自由文本三轮扫描编排。
 *
 * 编排顺序：显式城市 → 高置信区县 → 唯一地标 → 未覆盖段正则兜底，
 * 字符覆盖逐轮继承。扫哪张表、按什么顺序、覆盖如何继承，本身就是地理领域
 * 决策，唯一居所在此；memory 只消费扫描结果，决定如何写入 sessionFacts
 * （置信度生命周期仍归 memory）。
 */

import type { GeoTextScanCity, GeoTextScanResult, WhitelistScanResult } from './geo.types';
import {
  UNIQUE_SUBDIVISION_TO_CITY,
  MUNICIPALITIES,
  HIGH_CONFIDENCE_BARE_LOCATION_ALIASES,
} from './administrative-division.data';
import { NATIONAL_DISTRICT_NAMES } from './administrative-division.generated';
import { NATIONAL_CITY_SUFFIX_TO_CITY } from './explicit-city.data';
import { UNIQUE_PLACE_ALIAS_TO_CITY } from './place-alias.data';
import { normalizeDistrictForLookup } from './geo-name.normalizer';
import { matchInUncoveredSegments, scanWhitelistKeysByLongest } from './whitelist-scanner';

/**
 * 城市识别词典：直辖市 + 已支持城市前缀去重后的精确匹配集合。
 * 给 scanWhitelistKeysByLongest 作为 city 维度的输入。
 */
const CITY_DICT: Record<string, true> = Object.fromEntries(
  Array.from(new Set<string>([...MUNICIPALITIES, ...HIGH_CONFIDENCE_BARE_LOCATION_ALIASES])).map(
    (city) => [city, true],
  ),
);

/**
 * 白名单外 raw district 的词典：全国区/县全名（含后缀）。
 *
 * 曾用正则 `[一-龥]{2,10}(?:区|县|镇|街道…)` 在未覆盖段兜底，贪婪回吃会把
 * 「嘉定区安亭镇」残段截成「区安亭」、把「查查钟楼区邹区」截成「查查钟楼区邹」，
 * 09-11 生产核对近 7 天 12% 会话的 district 带此类脏值。改为词典最长匹配后，
 * 只有数据集里真实存在且文本带后缀的区/县名才会入 district；镇/街道级地点
 * 交给白名单与地理编码，不再由代码猜。
 */
const NATIONAL_DISTRICT_DICT: Record<string, true> = Object.fromEntries(
  NATIONAL_DISTRICT_NAMES.map((name) => [name, true]),
);

/**
 * 镇/街道级地点不在全国区县数据集里，只在紧接白名单/词典命中的残段开头识别
 * （「浦东新区航头镇」→ 航头；「嘉定区安亭镇」→ 安亭）：残段开头允许一个 区/县/市
 * 残字，正文 2–4 字，后缀必须是 镇/街道。句中自由出现的镇名交给 LLM 轨与地理编码。
 */
const TOWN_AFTER_HIT_PATTERN = /^[区县市]?[一-龥]{2,4}(?=镇|街道)/u;

const SELF_INTRO_PREFIXES = [
  '你好，我是',
  '您好，我是',
  '你好我是',
  '您好我是',
  '我是',
  '我叫',
] as const;
const SELF_INTRO_VALUE_BOUNDARIES = [
  '\n',
  '\r',
  '，',
  ',',
  '。',
  '！',
  '!',
  '？',
  '?',
  '；',
  ';',
  ' ',
] as const;

/**
 * 加好友后的「我是 X / 我叫 X」首行是昵称自报，不是位置证据。
 * 只按封闭前缀与边界做字符遮罩，保持后续命中的原始下标不变。
 */
function maskSelfIntroductionValue(message: string): string {
  return message.split('\n').map(maskSelfIntroductionLine).join('\n');
}

function maskSelfIntroductionLine(line: string): string {
  const leadingSpaces = line.length - line.trimStart().length;
  const remainder = line.slice(leadingSpaces);
  const prefix = SELF_INTRO_PREFIXES.find((candidate) => remainder.startsWith(candidate));
  if (!prefix) return line;
  const valueStart = leadingSpaces + prefix.length;
  let valueEnd = line.length;
  for (const boundary of SELF_INTRO_VALUE_BOUNDARIES) {
    const index = line.indexOf(boundary, valueStart);
    if (index >= valueStart && index < valueEnd) valueEnd = index;
  }
  if (valueEnd <= valueStart) return line;
  return `${line.slice(0, valueStart)}${' '.repeat(valueEnd - valueStart)}${line.slice(valueEnd)}`;
}

/**
 * 三轮串联扫描 + city 推导（平移自 extractLocation 的白名单扫描段）。
 *
 * 返回三类命中（含位置）、推导 city（带 evidence）、归一化区县合集
 * （白名单命中 ∪ 未覆盖段 raw district，已剥前缀噪音、去重保序）与地标命中。
 * 位置分享 / "XX附近" 等消息形态相关的抽取不在本函数职责内，由 memory 侧补充。
 */
export function scanGeoSignalsFromText(message: string): GeoTextScanResult {
  const scannableMessage = maskSelfIntroductionValue(message);
  // 三轮串联扫描，covered 区间逐轮累积，避免后轮再去消费前轮已认领的字符
  // city / district 轮开启通名后缀拒绝："宝安公路"不再命中深圳宝安区、"上海路"不再
  // 命中上海（shadow 6/6 冲突样本的共同根因）。location 轮**不开**——
  // 地标专名与通名天然共生（"陆家嘴"/"望京"后接 站/广场 属正常形态）。
  const cityScan = scanWhitelistKeysByLongest(scannableMessage, CITY_DICT, undefined, {
    rejectPlaceFeatureSuffix: true,
  });
  const districtScan = scanWhitelistKeysByLongest(
    scannableMessage,
    UNIQUE_SUBDIVISION_TO_CITY,
    cityScan.covered,
    { rejectPlaceFeatureSuffix: true },
  );
  const locationScan = scanWhitelistKeysByLongest(
    scannableMessage,
    UNIQUE_PLACE_ALIAS_TO_CITY,
    districtScan.covered,
  );

  const city = resolveCity(scannableMessage, cityScan, districtScan, locationScan);

  // district：白名单命中（归一化后） + 未覆盖区间全国区/县词典扫描（白名单外，不补 city）
  const whitelistDistricts = districtScan.hits.map((hit) => normalizeDistrictForLookup(hit.key));
  const rawDistrictScan = scanWhitelistKeysByLongest(
    scannableMessage,
    NATIONAL_DISTRICT_DICT,
    locationScan.covered,
    { rejectPlaceFeatureSuffix: true },
  );
  const rawDistricts = rawDistrictScan.hits.map((hit) => normalizeDistrictForLookup(hit.key));
  const towns = matchInUncoveredSegments(
    scannableMessage,
    rawDistrictScan.covered,
    TOWN_AFTER_HIT_PATTERN,
  ).map((match) => match.replace(/^[区县市]/u, ''));
  const districts = Array.from(
    new Set([...whitelistDistricts, ...rawDistricts, ...towns].filter(Boolean)),
  );

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
      value: UNIQUE_SUBDIVISION_TO_CITY[districtHit.key],
      evidence: 'unique_district_alias',
    };
  }

  const locationHit = locationScan.hits[0];
  if (locationHit) {
    return {
      value: UNIQUE_PLACE_ALIAS_TO_CITY[locationHit.key],
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
