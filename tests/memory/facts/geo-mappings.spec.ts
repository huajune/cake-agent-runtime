import * as legacyEntry from '@memory/facts/geo-mappings';
import * as geoEntry from '@resolution/geo';

/**
 * Phase 1 门面等价性（geo-domain-refactor-plan v3.1 §13 Phase 1 完成标准：
 * "新旧入口测试结果完全一致"）。
 *
 * 原基线测试已按 §15.1 迁至 tests/resolution/geo/（Phase 0 golden cases 全量平移）。
 * 本文件专门锁定旧路径门面：§4 依赖清单里现存的每一个导入符号都必须经
 * `export * from '@resolution/geo'` 原样透出——运行时符号是**同一引用**，
 * 新旧入口的任何调用结果必然一致，无需重复跑两遍用例。
 */
describe('memory/facts/geo-mappings 兼容门面（Phase 1）', () => {
  const RUNTIME_SYMBOLS = [
    // 数据表（§8.1 过渡期导出）
    'MUNICIPALITIES',
    'SUPPORTED_CITY_PREFIXES',
    'DISTRICT_TO_CITY',
    'COUNTY_LEVEL_CITY_TO_PREFECTURE',
    'NATIONAL_CITY_SUFFIX_TO_CITY',
    'LOCATION_TO_CITY',
    'GENERIC_AMBIGUOUS_SUFFIXES',
    // 函数（稳定 API）
    'normalizeCityName',
    'normalizeDistrictForLookup',
    'hasGenericAmbiguousSuffix',
    'resolveCityFromDistrict',
    'resolveCityFromLocation',
    'resolveCityFromGeoSignals',
    'resolveParentAdministrativeArea',
    'scanWhitelistKeysByLongest',
    'matchInUncoveredSegments',
  ] as const;

  it('§4 依赖清单的全部运行时符号经门面透出，且与 @resolution/geo 同一引用', () => {
    for (const symbol of RUNTIME_SYMBOLS) {
      const legacyValue = (legacyEntry as Record<string, unknown>)[symbol];
      const geoValue = (geoEntry as Record<string, unknown>)[symbol];
      expect(legacyValue).toBeDefined();
      expect(Object.is(legacyValue, geoValue)).toBe(true);
    }
  });

  it('旧入口冒烟：核心调用与既有行为一致（延吉/朝阳/航头镇/万达广场）', () => {
    expect(legacyEntry.resolveCityFromDistrict('延吉市')).toBe('延边朝鲜族自治州');
    expect(legacyEntry.resolveCityFromDistrict('朝阳区')).toBe('北京');
    expect(legacyEntry.hasGenericAmbiguousSuffix('万达广场')).toBe(true);
    expect(legacyEntry.hasGenericAmbiguousSuffix('漕宝路地铁站')).toBe(false);
    expect(
      legacyEntry.scanWhitelistKeysByLongest('浦东新区航头镇', legacyEntry.DISTRICT_TO_CITY).hits,
    ).toEqual([{ key: '浦东新区', start: 0, end: 4 }]);
    // 类型透出冒烟：WhitelistScanResult 形状可被消费（high-confidence-facts 依赖）
    const scan: legacyEntry.WhitelistScanResult = legacyEntry.scanWhitelistKeysByLongest(
      '上海',
      { 上海: '上海' },
    );
    expect(scan.covered).toHaveLength(2);
  });
});
