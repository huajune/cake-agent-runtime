import {
  AGE_BOUNDARY_HANDOFF_FLOOR,
  AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
  detectAgeBoundary,
  parseAgeRange,
  parseCandidateAge,
} from '@tools/duliday-interview-precheck.tool';

describe('parseAgeRange', () => {
  it('parses standard "25-50岁" format', () => {
    expect(parseAgeRange('25-50岁')).toEqual({ min: 25, max: 50 });
  });

  it('parses with space tolerance', () => {
    expect(parseAgeRange('25 - 50岁')).toEqual({ min: 25, max: 50 });
  });

  it('returns null for "不限"', () => {
    expect(parseAgeRange('不限')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(parseAgeRange(null)).toBeNull();
    expect(parseAgeRange(undefined)).toBeNull();
    expect(parseAgeRange('')).toBeNull();
  });

  it('handles one-sided "不限-50岁"', () => {
    expect(parseAgeRange('不限-50岁')).toEqual({ min: null, max: 50 });
  });

  it('handles one-sided "25-不限岁"', () => {
    expect(parseAgeRange('25-不限岁')).toEqual({ min: 25, max: null });
  });
});

describe('parseCandidateAge', () => {
  it('parses "24岁"', () => {
    expect(parseCandidateAge('24岁')).toBe(24);
  });
  it('parses bare "24"', () => {
    expect(parseCandidateAge('24')).toBe(24);
  });
  it('returns null for empty/unknown', () => {
    expect(parseCandidateAge('')).toBeNull();
    expect(parseCandidateAge(null)).toBeNull();
    expect(parseCandidateAge('abc')).toBeNull();
  });
});

describe('detectAgeBoundary', () => {
  it('flags 24 vs [25,50] as under_min handoff (badcase zmp4egzr)', () => {
    const result = detectAgeBoundary({
      candidateAge: 24,
      range: { min: 25, max: 50 },
    });
    expect(result).toEqual(
      expect.objectContaining({
        candidateAge: 24,
        requiredMin: 25,
        side: 'under_min',
      }),
    );
    expect(result?.reason).toContain('24');
    expect(result?.reason).toContain('25');
  });

  it('flags 23 vs [25,50] as under_min handoff (anchor floor)', () => {
    const result = detectAgeBoundary({
      candidateAge: AGE_BOUNDARY_HANDOFF_FLOOR,
      range: { min: 25, max: 50 },
    });
    expect(result?.side).toBe('under_min');
  });

  it('does NOT flag 22 vs [25,50] (below floor — strict reject preserved)', () => {
    const result = detectAgeBoundary({
      candidateAge: 22,
      range: { min: 25, max: 50 },
    });
    expect(result).toBeNull();
  });

  it('does NOT flag 25 vs [25,50] (already meets min)', () => {
    expect(
      detectAgeBoundary({ candidateAge: 25, range: { min: 25, max: 50 } }),
    ).toBeNull();
  });

  it('flags candidateAge = max + UPPER_TOLERANCE as over_max handoff', () => {
    const result = detectAgeBoundary({
      candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
      range: { min: 18, max: 50 },
    });
    expect(result?.side).toBe('over_max');
  });

  it('does NOT flag candidateAge = max + UPPER_TOLERANCE + 1 (over tolerance)', () => {
    const result = detectAgeBoundary({
      candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS + 1,
      range: { min: 18, max: 50 },
    });
    expect(result).toBeNull();
  });

  it('returns null when candidate age unknown', () => {
    expect(detectAgeBoundary({ candidateAge: null, range: { min: 25, max: 50 } })).toBeNull();
  });

  it('returns null when range unknown', () => {
    expect(detectAgeBoundary({ candidateAge: 24, range: null })).toBeNull();
  });

  it('handles single-sided range (only min set, no upper handoff)', () => {
    const result = detectAgeBoundary({
      candidateAge: 24,
      range: { min: 25, max: null },
    });
    expect(result?.side).toBe('under_min');
  });

  it('handles single-sided range (only max set, no lower handoff)', () => {
    const result = detectAgeBoundary({
      candidateAge: 51,
      range: { min: null, max: 50 },
    });
    expect(result?.side).toBe('over_max');
  });
});
