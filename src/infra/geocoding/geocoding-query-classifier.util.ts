import {
  hasGenericAmbiguousSuffix,
  NATIONAL_CITY_SUFFIX_TO_CITY,
  SUPPORTED_CITY_PREFIXES,
} from '@memory/facts/geo-mappings';
import type { GeocodeQueryKind } from './geocoding.types';

const METRO_STATION_PATTERN = /(?:地铁站|地铁|站)$/;
const ROAD_PATTERN = /[一-龥0-9A-Za-z]{2,}(?:路|街|大道|道|巷|弄)$/;
const ADMIN_AREA_PATTERN = /[一-龥]{2,}(?:省|市|区|县|镇|乡|街道)$/;
const SPECIFIC_POI_PATTERN =
  /(?:广场|商场|购物中心|公园|小区|大厦|中心|商圈|市场|酒店|学校|医院|湾|坊)$/;
const EXPLICIT_ADMIN_CONTEXT_PATTERN = /(?:省|市|自治州|地区)/;
const EMBEDDED_CITY_PREFIXES = [
  ...SUPPORTED_CITY_PREFIXES,
  ...new Set(Object.values(NATIONAL_CITY_SUFFIX_TO_CITY)),
];

/**
 * 将候选人给出的地点线索先粗分类型，再决定该走 POI、结构化地址，还是两者合并。
 * 这里只做低成本文本分类，不做城市推断。
 */
export function classifyGeocodeQuery(address: string): GeocodeQueryKind {
  const trimmed = address.trim();
  if (!trimmed) return 'unknown';

  if (hasGenericAmbiguousSuffix(trimmed)) return 'generic_poi';
  if (METRO_STATION_PATTERN.test(trimmed)) return 'metro_station';
  if (SPECIFIC_POI_PATTERN.test(trimmed)) return 'specific_poi';
  if (ADMIN_AREA_PATTERN.test(trimmed)) return 'admin_area';
  if (ROAD_PATTERN.test(trimmed)) return 'road';

  return 'unknown';
}

export function shouldTryStructuredGeocode(kind: GeocodeQueryKind, city?: string | null): boolean {
  if (!city?.trim()) return false;
  return kind === 'road' || kind === 'admin_area' || kind === 'metro_station';
}

/**
 * 文本本身已经带城市/省份线索时，即使调用方没有单独传 city，也可以走结构化地址。
 * 例："常州钟楼区"、"南京六合"、"上海浦东新区航头镇"。
 */
export function hasEmbeddedCityHint(address: string): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  if (EXPLICIT_ADMIN_CONTEXT_PATTERN.test(trimmed)) return true;
  return EMBEDDED_CITY_PREFIXES.some(
    (city) => trimmed.startsWith(city) && trimmed.length > city.length,
  );
}

/**
 * "万达广场/天街"这类裸通名必须反问城市；但 city 已知且前缀足够具体时，
 * 如"宝山宝龙广场"、"浦口江北天街"，可在 POI 为空时再尝试结构化地址兜底。
 */
export function hasContextualGenericPoiPrefix(address: string): boolean {
  const trimmed = address.trim();
  if (!hasGenericAmbiguousSuffix(trimmed)) return false;

  const suffix = [
    '万达广场',
    '万象城',
    '吾悦广场',
    '银泰',
    '天街',
    '印象城',
    '砂之船',
    '大悦城',
    '购物中心',
    '商场',
    '广场',
  ].find((item) => trimmed.endsWith(item));
  if (!suffix) return false;

  const prefix = trimmed.slice(0, trimmed.length - suffix.length);
  return prefix.length >= 2;
}
