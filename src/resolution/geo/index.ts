/**
 * 地理解析域唯一出口（docs/architecture/geo-resolution.md §3）。
 *
 * 业务代码只从 `@resolution/geo` 导入；geo 内部使用相对路径，避免经由
 * barrel 自引发循环。零出向依赖：不 import memory/agent/tools/infra/sponge，
 * 也不 import resolution/brand（§12，ESLint no-restricted-imports 固化）。
 */

// —— 稳定 API（长期保留）——
export type {
  AdministrativeLevel,
  GeoTextScanCity,
  GeoTextScanResult,
  ParentAdministrativeArea,
  WhitelistScanHit,
  WhitelistScanResult,
} from './geo.types';

export { normalizeCityName, normalizeDistrictForLookup } from './geo-name.normalizer';
export {
  detectGeoSignalConflict,
  hasKnownCityPrefix,
  isKnownCanonicalAdministrativeAreaName,
  isRecognizedCityName,
  listUniqueDistrictCityEntries,
  resolveCityFromDistrict,
  resolveCityFromGeoSignals,
  resolveParentAdministrativeArea,
} from './administrative-area.resolver';
export { resolveCityFromLocation } from './place-alias.resolver';
export { scanWhitelistKeysByLongest, matchInUncoveredSegments } from './whitelist-scanner';
export { scanGeoSignalsFromText } from './geo-text-scan';
export { hasGenericAmbiguousSuffix, GENERIC_AMBIGUOUS_SUFFIXES } from './ambiguous-place.policy';
export { NATIONAL_CITY_BARE_NAMES } from './explicit-city.data';

// 过渡期数据表导出已随 Phase 5 收口删除（§8.1）：行政区关系一律通过 resolver 查询，
// 数据常量不是公共 API。域内测试需要断言数据现状时，直接从数据模块相对导入。
