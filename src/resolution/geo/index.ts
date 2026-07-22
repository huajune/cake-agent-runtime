/**
 * 地理解析域唯一出口（geo-domain-refactor-plan v3.1 §8.1）。
 *
 * 业务代码只从 `@resolution/geo` 导入；geo 内部使用相对路径，避免经由
 * barrel 自引发循环。零出向依赖：不 import memory/agent/tools/infra/sponge，
 * 也不 import resolution/brand（§12，ESLint no-restricted-imports 固化）。
 */

// —— 稳定 API（长期保留）——
export type {
  AdministrativeLevel,
  GeoResolution,
  GeoResolutionEvidence,
  GeoTextScanCity,
  GeoTextScanResult,
  ParentAdministrativeArea,
  WhitelistScanHit,
  WhitelistScanResult,
} from './geo.types';

export { normalizeCityName, normalizeDistrictForLookup } from './normalization/geo-name.normalizer';
export {
  detectGeoSignalConflict,
  resolveCityFromDistrict,
  resolveCityFromGeoSignals,
  resolveParentAdministrativeArea,
} from './admin/administrative-area.resolver';
export { resolveCityFromLocation } from './places/place-alias.resolver';
export { scanWhitelistKeysByLongest, matchInUncoveredSegments } from './matching/whitelist-scanner';
export { scanGeoSignalsFromText } from './matching/geo-text-scan';
export {
  hasGenericAmbiguousSuffix,
  GENERIC_AMBIGUOUS_SUFFIXES,
} from './policy/ambiguous-place.policy';

// —— 过渡期导出（消费者收口后随 Phase 5 删除）——
// Phase 1 门面必须兜住现存全部导入符号（§4 依赖清单），否则迁移首日即编译失败。
// 收口条件：三轮扫描编排迁入 scanGeoSignalsFromText（Phase 2）且岗位工具改用
// resolveParentAdministrativeArea（Phase 3）之后，全库不再有文件需要触碰底层 Record。
/** @deprecated 请改用 scanGeoSignalsFromText / resolveParentAdministrativeArea 等 API */
export {
  MUNICIPALITIES,
  SUPPORTED_CITY_PREFIXES,
  DISTRICT_TO_CITY,
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
} from './admin/administrative-division.data';
/** @deprecated 同上 */
export { NATIONAL_CITY_SUFFIX_TO_CITY } from './admin/explicit-city.data';
/** @deprecated 同上 */
export { LOCATION_TO_CITY } from './places/place-alias.data';
