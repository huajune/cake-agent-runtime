import { getPrimaryJobIndustry, splitJobCategorySegments } from '@sponge/job-category.util';

describe('job-category.util', () => {
  describe('splitJobCategorySegments', () => {
    it('should split hierarchical category names and trim empty segments', () => {
      expect(splitJobCategorySegments(' 餐饮 / 中餐 / 普通服务员 ')).toEqual([
        '餐饮',
        '中餐',
        '普通服务员',
      ]);
    });

    it('should return empty array for empty input', () => {
      expect(splitJobCategorySegments(undefined)).toEqual([]);
      expect(splitJobCategorySegments(null)).toEqual([]);
      expect(splitJobCategorySegments('')).toEqual([]);
    });
  });

  describe('getPrimaryJobIndustry', () => {
    it('should resolve the first category segment when it is supported', () => {
      expect(getPrimaryJobIndustry('餐饮/中餐/普通服务员')).toBe('餐饮');
      expect(getPrimaryJobIndustry('零售/便利店/店员')).toBe('零售');
    });

    it('should return null for unsupported or malformed category names', () => {
      expect(getPrimaryJobIndustry('普通服务员')).toBeNull();
      expect(getPrimaryJobIndustry('家政/保洁')).toBeNull();
      expect(getPrimaryJobIndustry(undefined)).toBeNull();
    });
  });
});
