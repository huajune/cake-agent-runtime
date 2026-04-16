import { normalizeCityName, normalizeDistrictForLookup } from '@memory/facts/geo-mappings';

describe('geo-mappings', () => {
  describe('normalizeDistrictForLookup', () => {
    it('keeps development zones and new districts intact', () => {
      expect(normalizeDistrictForLookup('亦庄开发区')).toBe('亦庄开发区');
      expect(normalizeDistrictForLookup('浦东新区')).toBe('浦东新区');
    });

    it('removes the street suffix but keeps the core name', () => {
      expect(normalizeDistrictForLookup('中南路街道')).toBe('中南路');
    });

    it('strips generic administrative suffixes for lookup fallback', () => {
      expect(normalizeDistrictForLookup('杨浦区')).toBe('杨浦');
      expect(normalizeDistrictForLookup('余姚市')).toBe('余姚市');
      expect(normalizeDistrictForLookup('崇阳县')).toBe('崇阳');
      expect(normalizeDistrictForLookup('白沙镇')).toBe('白沙');
      expect(normalizeDistrictForLookup('龙坪乡')).toBe('龙坪');
    });
  });

  describe('normalizeCityName', () => {
    it('trims whitespace and drops the city suffix', () => {
      expect(normalizeCityName(' 上海市 ')).toBe('上海');
      expect(normalizeCityName('南昌')).toBe('南昌');
    });

    it('returns null for emptyish values', () => {
      expect(normalizeCityName('   ')).toBeNull();
      expect(normalizeCityName(null)).toBeNull();
      expect(normalizeCityName(undefined)).toBeNull();
    });
  });
});
