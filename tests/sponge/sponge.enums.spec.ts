import {
  findSpongeEducationIdByLabel,
  findSpongeProvinceIdByName,
  getAvailableSpongeEducations,
  getSpongeHealthCertificateTypeLabels,
  getSpongeProvinceNameById,
  SPONGE_EDUCATION_MAPPING,
} from '@sponge/sponge.enums';

describe('sponge.enums', () => {
  describe('education helpers', () => {
    it('should expose collectable educations without 不限', () => {
      expect(getAvailableSpongeEducations()).not.toContain(SPONGE_EDUCATION_MAPPING[1]);
      expect(getAvailableSpongeEducations()).toContain('本科');
    });

    it('should find education id by label', () => {
      expect(findSpongeEducationIdByLabel('本科')).toBe(2);
      expect(findSpongeEducationIdByLabel('中专技校职高')).toBe(8);
      expect(findSpongeEducationIdByLabel('未知学历')).toBeNull();
    });
  });

  describe('province helpers', () => {
    it('should resolve province id by exact province name', () => {
      expect(findSpongeProvinceIdByName('北京市')).toBe(110000);
      expect(findSpongeProvinceIdByName('广东省')).toBe(440000);
      expect(getSpongeProvinceNameById(310000)).toBe('上海市');
    });

    it('should resolve province id by normalized province name without suffix', () => {
      expect(findSpongeProvinceIdByName('北京')).toBe(110000);
      expect(findSpongeProvinceIdByName('广西')).toBe(450000);
      expect(findSpongeProvinceIdByName('新疆')).toBe(650000);
      expect(findSpongeProvinceIdByName('香港')).toBe(810000);
    });

    it('should trim whitespace and return null when province does not exist', () => {
      expect(findSpongeProvinceIdByName('  上海市  ')).toBe(310000);
      expect(findSpongeProvinceIdByName('火星')).toBeNull();
    });
  });

  describe('health certificate helpers', () => {
    it('should map health certificate type ids and skip invalid ones', () => {
      expect(getSpongeHealthCertificateTypeLabels([1, 3, 999])).toEqual([
        '食品健康证',
        '其他健康证',
      ]);
      expect(getSpongeHealthCertificateTypeLabels()).toEqual([]);
    });
  });
});
