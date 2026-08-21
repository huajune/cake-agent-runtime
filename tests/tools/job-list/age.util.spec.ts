import { parseAgeRange, parseCandidateAge } from '@tools/job-list/age.util';

describe('age.util', () => {
  describe('parseCandidateAge', () => {
    it('extracts the first integer from candidate text', () => {
      expect(parseCandidateAge('24岁')).toBe(24);
      expect(parseCandidateAge('24')).toBe(24);
      expect(parseCandidateAge('我今年30')).toBe(30);
    });

    it('returns null for missing / unparsable input', () => {
      expect(parseCandidateAge(null)).toBeNull();
      expect(parseCandidateAge(undefined)).toBeNull();
      expect(parseCandidateAge('')).toBeNull();
      expect(parseCandidateAge('abc')).toBeNull();
    });
  });

  describe('parseAgeRange', () => {
    it('parses "25-50岁" and tolerates whitespace', () => {
      expect(parseAgeRange('25-50岁')).toEqual({ min: 25, max: 50 });
      expect(parseAgeRange('25 - 50岁')).toEqual({ min: 25, max: 50 });
    });

    it('returns null when ageRequirement is "不限" / empty / nullish', () => {
      expect(parseAgeRange('不限')).toBeNull();
      expect(parseAgeRange(null)).toBeNull();
      expect(parseAgeRange(undefined)).toBeNull();
      expect(parseAgeRange('')).toBeNull();
    });

    it('keeps one-sided "不限-50岁" / "25-不限岁" as null on the open side', () => {
      expect(parseAgeRange('不限-50岁')).toEqual({ min: null, max: 50 });
      expect(parseAgeRange('25-不限岁')).toEqual({ min: 25, max: null });
    });

    it('returns null for unrecognized format', () => {
      expect(parseAgeRange('25岁以上')).toBeNull();
    });
  });
});
