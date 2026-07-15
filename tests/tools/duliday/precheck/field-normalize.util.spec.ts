import {
  dedupeStrings,
  formatConstraintText,
  inferIdentityFromAge,
  isUnrestrictedGenderRequirement,
  normalizeArrayText,
  normalizeEducationValue,
  normalizeGenderValue,
  normalizeHealthCertificateValue,
  normalizeIdentityText,
  normalizeNumberText,
  normalizeTextValue,
} from '@tools/duliday/precheck/field-normalize.util';

describe('field-normalize.util', () => {
  describe('isUnrestrictedGenderRequirement', () => {
    it('treats empty / null / 不限 / both-genders text as unrestricted', () => {
      expect(isUnrestrictedGenderRequirement(null)).toBe(true);
      expect(isUnrestrictedGenderRequirement('')).toBe(true);
      expect(isUnrestrictedGenderRequirement('不限')).toBe(true);
      expect(isUnrestrictedGenderRequirement('男女不限')).toBe(true);
      expect(isUnrestrictedGenderRequirement('男 女')).toBe(true);
      expect(isUnrestrictedGenderRequirement('女男')).toBe(true);
    });

    it('flags single-gender as restricted', () => {
      expect(isUnrestrictedGenderRequirement('男')).toBe(false);
      expect(isUnrestrictedGenderRequirement('仅限女性')).toBe(false);
    });
  });

  describe('formatConstraintText', () => {
    it('returns null for empty input', () => {
      expect(formatConstraintText(null)).toBeNull();
      expect(formatConstraintText('')).toBeNull();
    });

    it('replaces slashes / pipes with、', () => {
      expect(formatConstraintText('男/女')).toBe('男、女');
      expect(formatConstraintText('小学|初中｜高中')).toBe('小学、初中、高中');
    });
  });

  describe('dedupeStrings', () => {
    it('removes duplicates and falsy', () => {
      expect(dedupeStrings(['a', 'a', 'b', '', 'c'])).toEqual(['a', 'b', 'c']);
    });
  });

  describe('normalizeGenderValue', () => {
    it('returns null when both genders appear (treated as unrestricted)', () => {
      expect(normalizeGenderValue('男女')).toBeNull();
      expect(normalizeGenderValue('男女不限')).toBeNull();
    });

    it('detects standalone 男 even with prefix', () => {
      expect(normalizeGenderValue('限男')).toBe('男');
      expect(normalizeGenderValue('男')).toBe('男');
    });

    it('detects 女 without standalone 男', () => {
      expect(normalizeGenderValue('女')).toBe('女');
    });

    it('returns null when empty', () => {
      expect(normalizeGenderValue('')).toBeNull();
      expect(normalizeGenderValue(undefined)).toBeNull();
    });
  });

  describe('normalizeHealthCertificateValue', () => {
    it('returns null for foreign / non-local hint', () => {
      expect(normalizeHealthCertificateValue('健康证非本地')).toBeNull();
      expect(normalizeHealthCertificateValue('外地的健康证')).toBeNull();
    });

    it('maps 有 / 有健康证 to "有"', () => {
      expect(normalizeHealthCertificateValue('有')).toBe('有');
      expect(normalizeHealthCertificateValue('有健康证')).toBe('有');
      expect(normalizeHealthCertificateValue('上海本地健康证')).toBe('有');
    });

    it('captures explicit refusal as "无且不接受办理健康证"', () => {
      expect(normalizeHealthCertificateValue('不接受办理')).toBe('无且不接受办理健康证');
      expect(normalizeHealthCertificateValue('不办健康证')).toBe('无且不接受办理健康证');
    });

    it('captures willing-to-process as "无但接受办理健康证"', () => {
      expect(normalizeHealthCertificateValue('可以办健康证')).toBe('无但接受办理健康证');
      expect(normalizeHealthCertificateValue('接受办理')).toBe('无但接受办理健康证');
      expect(normalizeHealthCertificateValue('接受办健康证')).toBe('无但接受办理健康证');
    });

    it('defaults bare 无 / 没健康证 / 无健康证 to willing-to-process per two-step ask consensus', () => {
      expect(normalizeHealthCertificateValue('无')).toBe('无但接受办理健康证');
      expect(normalizeHealthCertificateValue('没健康证')).toBe('无但接受办理健康证');
      expect(normalizeHealthCertificateValue('无健康证')).toBe('无但接受办理健康证');
    });

    it('returns null for empty', () => {
      expect(normalizeHealthCertificateValue('')).toBeNull();
    });
  });

  describe('normalizeEducationValue', () => {
    it('returns null for empty', () => {
      expect(normalizeEducationValue(null)).toBeNull();
    });

    it('passes through unknown labels (upper layer decides)', () => {
      // 当前实现：能识别就返回；不识别也原文返回（容忍）
      expect(normalizeEducationValue('博士后')).toBe('博士后');
    });
  });

  describe('normalizeIdentityText / inferIdentityFromAge', () => {
    it('maps booleans to 学生 / 社会人士', () => {
      expect(normalizeIdentityText(true)).toBe('学生');
      expect(normalizeIdentityText(false)).toBe('社会人士');
      expect(normalizeIdentityText(null)).toBeNull();
      expect(normalizeIdentityText(undefined)).toBeNull();
    });

    it('infers 社会人士 when age ≥ 25', () => {
      expect(inferIdentityFromAge('25岁')).toBe('社会人士');
      expect(inferIdentityFromAge('30')).toBe('社会人士');
    });

    it('returns null for age < 25 (cannot determine identity)', () => {
      expect(inferIdentityFromAge('24')).toBeNull();
      expect(inferIdentityFromAge('20岁')).toBeNull();
    });

    it('returns null for unparsable age', () => {
      expect(inferIdentityFromAge('')).toBeNull();
      expect(inferIdentityFromAge(null)).toBeNull();
      expect(inferIdentityFromAge('未填')).toBeNull();
    });
  });

  describe('normalize{Text,Number,Array}Value', () => {
    it('normalizeTextValue returns trimmed string or null', () => {
      expect(normalizeTextValue('  hello  ')).toBe('hello');
      expect(normalizeTextValue('')).toBeNull();
      expect(normalizeTextValue(42)).toBeNull();
      expect(normalizeTextValue(null)).toBeNull();
    });

    it('normalizeNumberText coerces number and trims strings', () => {
      expect(normalizeNumberText(170)).toBe('170');
      expect(normalizeNumberText('170cm')).toBe('170cm');
      expect(normalizeNumberText('')).toBeNull();
      expect(normalizeNumberText(Number.NaN)).toBeNull();
      expect(normalizeNumberText(null)).toBeNull();
    });

    it('normalizeArrayText joins with、and filters falsy', () => {
      expect(normalizeArrayText(['食品类', '公共场所'])).toBe('食品类、公共场所');
      expect(normalizeArrayText([])).toBeNull();
      expect(normalizeArrayText('not array')).toBeNull();
    });
  });
});
