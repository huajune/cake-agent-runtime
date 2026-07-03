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
  // ── pass ──

  it('returns pass when candidate already meets the min', () => {
    expect(detectAgeBoundary({ candidateAge: 25, range: { min: 25, max: 50 } }).severity).toBe(
      'pass',
    );
  });

  // ── boundary ──

  it('flags 24 vs [25,50] as under_min boundary', () => {
    const result = detectAgeBoundary({ candidateAge: 24, range: { min: 25, max: 50 } });
    expect(result).toEqual(
      expect.objectContaining({
        candidateAge: 24,
        requiredMin: 25,
        side: 'under_min',
        severity: 'boundary',
      }),
    );
  });

  it('flags 23 vs [25,50] as under_min boundary (anchor floor)', () => {
    const result = detectAgeBoundary({
      candidateAge: AGE_BOUNDARY_HANDOFF_FLOOR,
      range: { min: 25, max: 50 },
    });
    expect(result.side).toBe('under_min');
    expect(result.severity).toBe('boundary');
  });

  it('flags candidateAge = max + UPPER_TOLERANCE as over_max boundary', () => {
    const result = detectAgeBoundary({
      candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
      range: { min: 18, max: 50 },
    });
    expect(result.side).toBe('over_max');
    expect(result.severity).toBe('boundary');
  });

  // ── hard_reject ──

  it('flags 22 vs [25,50] as under_min hard_reject (below floor)', () => {
    const result = detectAgeBoundary({ candidateAge: 22, range: { min: 25, max: 50 } });
    expect(result).toEqual(expect.objectContaining({ side: 'under_min', severity: 'hard_reject' }));
  });

  it('flags candidateAge = max + UPPER_TOLERANCE + 1 as over_max hard_reject', () => {
    const result = detectAgeBoundary({
      candidateAge: 50 + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS + 1,
      range: { min: 18, max: 50 },
    });
    expect(result.side).toBe('over_max');
    expect(result.severity).toBe('hard_reject');
  });

  it('flags 48 vs [25,40] as over_max hard_reject (badcase: 通融式推荐)', () => {
    const result = detectAgeBoundary({ candidateAge: 48, range: { min: 25, max: 40 } });
    expect(result).toEqual(
      expect.objectContaining({
        candidateAge: 48,
        requiredMax: 40,
        side: 'over_max',
        severity: 'hard_reject',
      }),
    );
  });

  // ── unknown ──

  it('returns unknown when candidate age is null', () => {
    const result = detectAgeBoundary({ candidateAge: null, range: { min: 25, max: 50 } });
    expect(result.severity).toBe('unknown');
    expect(result.reason).toContain('年龄未知');
  });

  it('returns unknown when range is null', () => {
    const result = detectAgeBoundary({ candidateAge: 24, range: null });
    expect(result.severity).toBe('unknown');
  });

  // ── one-sided ranges ──

  it('handles single-sided range (only min set)', () => {
    expect(detectAgeBoundary({ candidateAge: 24, range: { min: 25, max: null } }).side).toBe(
      'under_min',
    );
  });

  it('handles single-sided range (only max set)', () => {
    expect(detectAgeBoundary({ candidateAge: 51, range: { min: null, max: 50 } }).side).toBe(
      'over_max',
    );
  });
});
