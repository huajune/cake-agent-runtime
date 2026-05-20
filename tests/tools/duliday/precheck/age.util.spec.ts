/**
 * age.util 直接覆盖。
 *
 * 历史上同一组函数 (parseAgeRange / parseCandidateAge / detectAgeBoundary) 已经被
 * tests/tools/tool/duliday-interview-precheck.age-boundary.spec.ts 通过 tool 文件的
 * re-export 间接测过；此处补一份直接从 util 导入的 spec，符合"每个新 .ts 必须有对应
 * spec.ts"的硬规则，且让 util 不再依赖 tool re-export 保持可测。
 */

import {
  AGE_BOUNDARY_HANDOFF_FLOOR,
  AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
  detectAgeBoundary,
  parseAgeRange,
  parseCandidateAge,
} from '@tools/duliday/precheck/age.util';

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

  describe('detectAgeBoundary', () => {
    it('flags 24 vs [25,50] as under_min handoff (badcase anchor)', () => {
      const signal = detectAgeBoundary({
        candidateAge: 24,
        range: { min: 25, max: 50 },
      });
      expect(signal).toEqual(
        expect.objectContaining({
          candidateAge: 24,
          requiredMin: 25,
          side: 'under_min',
        }),
      );
      expect(signal?.reason).toContain('24');
      expect(signal?.reason).toContain('25');
    });

    it('still flags at exactly AGE_BOUNDARY_HANDOFF_FLOOR (inclusive lower edge)', () => {
      const signal = detectAgeBoundary({
        candidateAge: AGE_BOUNDARY_HANDOFF_FLOOR,
        range: { min: 25, max: 50 },
      });
      expect(signal?.side).toBe('under_min');
    });

    it('does NOT flag below the handoff floor (strict reject preserved)', () => {
      expect(
        detectAgeBoundary({ candidateAge: AGE_BOUNDARY_HANDOFF_FLOOR - 1, range: { min: 25, max: 50 } }),
      ).toBeNull();
    });

    it('does NOT flag when candidate already meets the min', () => {
      expect(detectAgeBoundary({ candidateAge: 25, range: { min: 25, max: 50 } })).toBeNull();
    });

    it('flags over_max within UPPER_TOLERANCE_YEARS', () => {
      const signal = detectAgeBoundary({
        candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
        range: { min: 18, max: 50 },
      });
      expect(signal?.side).toBe('over_max');
    });

    it('does NOT flag over_max once exceeding UPPER_TOLERANCE_YEARS', () => {
      expect(
        detectAgeBoundary({
          candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS + 1,
          range: { min: 18, max: 50 },
        }),
      ).toBeNull();
    });

    it('returns null when either candidateAge or range is missing', () => {
      expect(detectAgeBoundary({ candidateAge: null, range: { min: 25, max: 50 } })).toBeNull();
      expect(detectAgeBoundary({ candidateAge: 24, range: null })).toBeNull();
    });

    it('handles one-sided ranges', () => {
      expect(
        detectAgeBoundary({ candidateAge: 24, range: { min: 25, max: null } })?.side,
      ).toBe('under_min');
      expect(
        detectAgeBoundary({ candidateAge: 51, range: { min: null, max: 50 } })?.side,
      ).toBe('over_max');
    });
  });
});
