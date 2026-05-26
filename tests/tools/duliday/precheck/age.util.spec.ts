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
    // ── pass ──

    it('returns pass when candidate age meets the requirement', () => {
      expect(detectAgeBoundary({ candidateAge: 25, range: { min: 25, max: 50 } })).toEqual(
        expect.objectContaining({ severity: 'pass', candidateAge: 25 }),
      );
      expect(detectAgeBoundary({ candidateAge: 50, range: { min: 25, max: 50 } })).toEqual(
        expect.objectContaining({ severity: 'pass', candidateAge: 50 }),
      );
      expect(detectAgeBoundary({ candidateAge: 35, range: { min: 25, max: 50 } })).toEqual(
        expect.objectContaining({ severity: 'pass', candidateAge: 35 }),
      );
    });

    it('includes range info in pass reason', () => {
      const signal = detectAgeBoundary({ candidateAge: 30, range: { min: 25, max: 40 } });
      expect(signal.severity).toBe('pass');
      expect(signal.reason).toContain('30');
      expect(signal.reason).toContain('25-40');
    });

    // ── boundary ──

    it('flags 24 vs [25,50] as under_min boundary', () => {
      const signal = detectAgeBoundary({ candidateAge: 24, range: { min: 25, max: 50 } });
      expect(signal).toEqual(
        expect.objectContaining({ candidateAge: 24, requiredMin: 25, side: 'under_min', severity: 'boundary' }),
      );
    });

    it('flags at exactly AGE_BOUNDARY_HANDOFF_FLOOR as boundary', () => {
      const signal = detectAgeBoundary({ candidateAge: AGE_BOUNDARY_HANDOFF_FLOOR, range: { min: 25, max: 50 } });
      expect(signal.side).toBe('under_min');
      expect(signal.severity).toBe('boundary');
    });

    it('flags 23 vs [30,50] as under_min hard_reject (gap=7 exceeds LOWER_TOLERANCE)', () => {
      const signal = detectAgeBoundary({ candidateAge: 23, range: { min: 30, max: 50 } });
      expect(signal.side).toBe('under_min');
      expect(signal.severity).toBe('hard_reject');
    });

    it('flags over_max within UPPER_TOLERANCE_YEARS as boundary', () => {
      const signal = detectAgeBoundary({ candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS, range: { min: 18, max: 50 } });
      expect(signal.side).toBe('over_max');
      expect(signal.severity).toBe('boundary');
    });

    it('flags 42 vs [25,40] as over_max boundary', () => {
      const signal = detectAgeBoundary({ candidateAge: 42, range: { min: 25, max: 40 } });
      expect(signal).toEqual(
        expect.objectContaining({ candidateAge: 42, requiredMax: 40, side: 'over_max', severity: 'boundary' }),
      );
    });

    // ── hard_reject ──

    it('flags 48 vs [25,40] as over_max hard_reject (badcase: 通融式推荐)', () => {
      const signal = detectAgeBoundary({ candidateAge: 48, range: { min: 25, max: 40 } });
      expect(signal).toEqual(
        expect.objectContaining({ candidateAge: 48, requiredMax: 40, side: 'over_max', severity: 'hard_reject' }),
      );
      expect(signal.reason).toContain('拦截');
    });

    it('flags over_max exceeding UPPER_TOLERANCE_YEARS as hard_reject', () => {
      const signal = detectAgeBoundary({ candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS + 1, range: { min: 18, max: 50 } });
      expect(signal.side).toBe('over_max');
      expect(signal.severity).toBe('hard_reject');
    });

    it('flags under_min below AGE_BOUNDARY_HANDOFF_FLOOR as hard_reject', () => {
      const signal = detectAgeBoundary({ candidateAge: AGE_BOUNDARY_HANDOFF_FLOOR - 1, range: { min: 25, max: 50 } });
      expect(signal.side).toBe('under_min');
      expect(signal.severity).toBe('hard_reject');
    });

    it('flags 16 vs [25,50] as under_min hard_reject', () => {
      const signal = detectAgeBoundary({ candidateAge: 16, range: { min: 25, max: 50 } });
      expect(signal).toEqual(
        expect.objectContaining({ candidateAge: 16, requiredMin: 25, side: 'under_min', severity: 'hard_reject' }),
      );
    });

    // ── unknown ──

    it('returns unknown when candidate age is null', () => {
      const signal = detectAgeBoundary({ candidateAge: null, range: { min: 25, max: 50 } });
      expect(signal.severity).toBe('unknown');
      expect(signal.candidateAge).toBeNull();
      expect(signal.requiredMin).toBe(25);
      expect(signal.reason).toContain('年龄未知');
    });

    it('returns unknown when range is null', () => {
      const signal = detectAgeBoundary({ candidateAge: 24, range: null });
      expect(signal.severity).toBe('unknown');
      expect(signal.candidateAge).toBe(24);
      expect(signal.requiredMin).toBeNull();
      expect(signal.reason).toContain('年龄要求未知');
    });

    it('returns unknown when both are null', () => {
      const signal = detectAgeBoundary({ candidateAge: null, range: null });
      expect(signal.severity).toBe('unknown');
      expect(signal.reason).toContain('均未知');
    });

    // ── one-sided ranges ──

    it('handles single-sided range (only min set)', () => {
      expect(detectAgeBoundary({ candidateAge: 24, range: { min: 25, max: null } }).side).toBe('under_min');
      expect(detectAgeBoundary({ candidateAge: 60, range: { min: 25, max: null } }).severity).toBe('pass');
    });

    it('handles single-sided range (only max set)', () => {
      expect(detectAgeBoundary({ candidateAge: 51, range: { min: null, max: 50 } }).side).toBe('over_max');
      expect(detectAgeBoundary({ candidateAge: 18, range: { min: null, max: 50 } }).severity).toBe('pass');
    });
  });
});
