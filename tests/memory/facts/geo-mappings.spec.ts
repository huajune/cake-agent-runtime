import {
  GENERIC_AMBIGUOUS_SUFFIXES,
  hasGenericAmbiguousSuffix,
  normalizeCityName,
  normalizeDistrictForLookup,
} from '@memory/facts/geo-mappings';

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

  describe('hasGenericAmbiguousSuffix', () => {
    it('完整等于黑名单条目时命中', () => {
      expect(hasGenericAmbiguousSuffix('万达广场')).toBe(true);
      expect(hasGenericAmbiguousSuffix('火车站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('人民广场')).toBe(true);
    });

    it('以黑名单条目结尾时命中（连锁商业体/公共设施）', () => {
      expect(hasGenericAmbiguousSuffix('合肥万达广场')).toBe(true);
      expect(hasGenericAmbiguousSuffix('龙湖天街')).toBe(true);
      expect(hasGenericAmbiguousSuffix('交通大学')).toBe(true);
    });

    it('交通站点带 ≥2 字专名前缀时不命中（badcase: 漕宝路地铁报站名被反问城市）', () => {
      expect(hasGenericAmbiguousSuffix('漕宝路地铁站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('上海火车站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('北京西站火车站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('虹桥高铁站')).toBe(false);
    });

    it('交通站点前缀过短或本身仍是通名时照旧命中', () => {
      expect(hasGenericAmbiguousSuffix('南地铁站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('长途汽车站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('中心客运站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('汽车客运站')).toBe(true);
    });

    it('前后有空白时仍能匹配（自动 trim）', () => {
      expect(hasGenericAmbiguousSuffix('  万达广场  ')).toBe(true);
    });

    it('唯一对应某城市的非黑名单地名不命中（让 LLM 通识可用）', () => {
      expect(hasGenericAmbiguousSuffix('马陆')).toBe(false);
      expect(hasGenericAmbiguousSuffix('陆家嘴')).toBe(false);
      expect(hasGenericAmbiguousSuffix('光谷')).toBe(false);
      expect(hasGenericAmbiguousSuffix('中关村')).toBe(false);
    });

    it('空字符串 / 空白 / 不在黑名单的普通地名不命中', () => {
      expect(hasGenericAmbiguousSuffix('')).toBe(false);
      expect(hasGenericAmbiguousSuffix('   ')).toBe(false);
      expect(hasGenericAmbiguousSuffix('人民路 123 号')).toBe(false);
    });

    it('黑名单常量本身的每一项都自命中', () => {
      for (const suffix of GENERIC_AMBIGUOUS_SUFFIXES) {
        expect(hasGenericAmbiguousSuffix(suffix)).toBe(true);
      }
    });
  });
});
