import { extractHardRequirements } from '@tools/duliday/job-list/hard-requirements.util';

describe('extractHardRequirements', () => {
  describe('gender', () => {
    it.each([
      ['女', 'female'],
      ['女性', 'female'],
      ['限女性', 'female'],
      ['只招女', 'female'],
      ['仅女性', 'female'],
      ['男', 'male'],
      ['限男性', 'male'],
      ['只要男生', 'male'],
      ['不限', 'any'],
      ['男女不限', 'any'],
      // 海绵真实取值：逗号串表达多选，两种顺序都代表不限。
      ['男性,女性', 'any'],
      ['女性,男性', 'any'],
      ['', 'unspecified'],
      ['未填写', 'unspecified'],
    ])('classifies "%s" as %s', (input, expected) => {
      const result = extractHardRequirements({ hiringRequirement: { basicPersonalRequirements: { genderRequirement: input } } });
      expect(result.gender).toBe(expected);
    });

    it('returns unspecified when hiringRequirement missing', () => {
      expect(extractHardRequirements(null).gender).toBe('unspecified');
      expect(extractHardRequirements(undefined).gender).toBe('unspecified');
      expect(extractHardRequirements({}).gender).toBe('unspecified');
    });
  });

  describe('household (badcase p9a7a70l)', () => {
    it('parses 不要 X 籍 → exclude', () => {
      const result = extractHardRequirements({
        hiringRequirement: {
          requirementsForHometown: {
            nativePlaceRequirementType: '不要',
            nativePlaces: ['天津', '东三省'],
          },
        },
      });
      expect(result.household).toEqual({ mode: 'exclude', regions: ['天津', '东三省'] });
    });

    it('parses 限 X → include', () => {
      const result = extractHardRequirements({
        hiringRequirement: {
          requirementsForHometown: {
            nativePlaceRequirementType: '限',
            nativePlaces: ['上海本地'],
          },
        },
      });
      expect(result.household).toEqual({ mode: 'include', regions: ['上海本地'] });
    });

    it('returns null when type=不限', () => {
      const result = extractHardRequirements({
        hiringRequirement: {
          requirementsForHometown: { nativePlaceRequirementType: '不限', nativePlaces: [] },
        },
      });
      expect(result.household).toBeNull();
    });

    it('returns null when places empty even with type set', () => {
      const result = extractHardRequirements({
        hiringRequirement: {
          requirementsForHometown: { nativePlaceRequirementType: '不要', nativePlaces: [] },
        },
      });
      expect(result.household).toBeNull();
    });

    it('returns null when hometown block missing', () => {
      expect(extractHardRequirements({ hiringRequirement: {} }).household).toBeNull();
    });
  });

  describe('healthCert', () => {
    it('maps explicit gate before_interview', () => {
      const result = extractHardRequirements({
        _policy: { normalizedRequirements: { healthCertGate: 'before_interview' } },
      });
      expect(result.healthCert).toBe('required_before_interview');
    });

    it('maps explicit gate before_onboard', () => {
      const result = extractHardRequirements({
        _policy: { normalizedRequirements: { healthCertGate: 'before_onboard' } },
      });
      expect(result.healthCert).toBe('required_before_onboard');
    });

    it('infers required_before_interview from text "面试前必须有健康证"', () => {
      const result = extractHardRequirements({
        _policy: {
          normalizedRequirements: { healthCertificateRequirement: '面试前必须有健康证' },
        },
      });
      expect(result.healthCert).toBe('required_before_interview');
    });

    it('infers required_before_onboard from text "入职前办好就行"', () => {
      const result = extractHardRequirements({
        _policy: {
          normalizedRequirements: { healthCertificateRequirement: '入职前办好就行' },
        },
      });
      expect(result.healthCert).toBe('required_before_onboard');
    });

    it('infers not_required from text "不需要健康证"', () => {
      const result = extractHardRequirements({
        _policy: { normalizedRequirements: { healthCertificateRequirement: '不需要健康证' } },
      });
      expect(result.healthCert).toBe('not_required');
    });

    it('falls back to before_onboard when text mentions 健康证 without timing', () => {
      const result = extractHardRequirements({
        _policy: { normalizedRequirements: { healthCertificateRequirement: '要食品健康证' } },
      });
      expect(result.healthCert).toBe('required_before_onboard');
    });

    it('returns unspecified when text is "未明确要求"', () => {
      const result = extractHardRequirements({
        _policy: { normalizedRequirements: { healthCertificateRequirement: '未明确要求' } },
      });
      expect(result.healthCert).toBe('unspecified');
    });

    it('returns unspecified when no policy data', () => {
      expect(extractHardRequirements({}).healthCert).toBe('unspecified');
    });
  });

  describe('integration', () => {
    it('extracts all three fields from a complete raw job', () => {
      const result = extractHardRequirements({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '女' },
          requirementsForHometown: {
            nativePlaceRequirementType: '不要',
            nativePlaces: ['东三省'],
          },
        },
        _policy: { normalizedRequirements: { healthCertGate: 'before_onboard' } },
      });

      expect(result).toEqual({
        gender: 'female',
        household: { mode: 'exclude', regions: ['东三省'] },
        healthCert: 'required_before_onboard',
      });
    });
  });
});
