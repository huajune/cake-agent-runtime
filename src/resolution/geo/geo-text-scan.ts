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

/** 正则兜底：在白名单未覆盖区间识别"白名单外的 raw district"（不补 city）。 */
const RAW_DISTRICT_PATTERN = /([一-龥]{2,10}(?:区|县|镇|街道|新区|开发区))/g;

/**
 * 正则兜底吃到的"区名"里含这些字/词就不是地名：候选人说"没有固定区，都可以"
 * "也可以跑其他区"，兜底会把"区"前整段话截成区名写进 preferences.district
 * （生产 09-02 核对到 2 例）。这里只列地名里绝不出现的虚词、否定词与泛指词；
 * "都/有/无"等在真实区县名里会出现（花都、都昌、有…），只以短语形式收。
 */
const RAW_DISTRICT_STOP_WORDS =
  /没有|没固定|不固定|不限|都可以|都行|都能|可以|随便|其他|其它|任何|哪里|哪儿|哪个|什么|这个|那个|固定|方便|就近|附近|周边|以外|之外|所有|每个|各个|[的吗呢吧了也还就要想找去到在是]/u;

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

  // district：白名单命中（归一化后） + 未覆盖区间正则兜底（白名单外，城市未知）
  const whitelistDistricts = districtScan.hits.map((hit) => normalizeDistrictForLookup(hit.key));
  const rawDistricts = matchInUncoveredSegments(
    scannableMessage,
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

function normalizeRawDistrict(candidate: string): string {
  // 兜底场景：候选词来自"白名单未覆盖区间"。理论上不含已识别的区名，但仍可能整段
  // 被正则吃进来（如完全在白名单外的城市的区），所以复用旧版前缀剥离 + 后缀归一化
  // 作最后一层保险。
  const withoutPrefix = candidate
    .replace(/^[\u4e00-\u9fa5]{2,12}省/, '')
    .replace(/^[\u4e00-\u9fa5]{2,12}市/, '')
    .replace(/^(?:你好|您好|哈喽|嗨)/, '')
    .replace(/^(?:我在|人在|住在|我住|目前在|现在在|今天在|平时在|在)/, '');
  if (RAW_DISTRICT_STOP_WORDS.test(withoutPrefix)) return '';
  return normalizeDistrictForLookup(withoutPrefix);
}
