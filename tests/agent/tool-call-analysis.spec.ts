import { computeResultCount, computeToolCallStatus } from '@agent/tool-call-analysis';

describe('tool-call-analysis', () => {
  describe('computeResultCount', () => {
    it('returns undefined for null/undefined/non-object primitives', () => {
      expect(computeResultCount(undefined)).toBeUndefined();
      expect(computeResultCount(null)).toBeUndefined();
      expect(computeResultCount('text')).toBeUndefined();
      expect(computeResultCount(42)).toBeUndefined();
    });

    it('returns array length when result is an array', () => {
      expect(computeResultCount([])).toBe(0);
      expect(computeResultCount([{ a: 1 }, { a: 2 }])).toBe(2);
    });

    it('reads first matching array container key', () => {
      // 'items' takes precedence over 'data'
      expect(computeResultCount({ items: [1, 2, 3], data: [1] })).toBe(3);
      expect(computeResultCount({ jobs: [{}] })).toBe(1);
      expect(computeResultCount({ records: [] })).toBe(0);
    });

    it('falls back to total/count when no array container present', () => {
      expect(computeResultCount({ total: 7 })).toBe(7);
      expect(computeResultCount({ count: 3 })).toBe(3);
      // 'total' wins over 'count' (declaration order in helper).
      expect(computeResultCount({ total: 9, count: 1 })).toBe(9);
    });

    it('returns undefined when neither container nor numeric total present', () => {
      expect(computeResultCount({ message: 'ok' })).toBeUndefined();
      expect(computeResultCount({ total: 'not-a-number' })).toBeUndefined();
    });
  });

  describe('computeToolCallStatus', () => {
    it('returns error when errorText is non-empty', () => {
      expect(computeToolCallStatus({}, 5, 'boom')).toBe('error');
    });

    it('returns error when state hints failure', () => {
      expect(computeToolCallStatus({}, 5, undefined, 'tool-error')).toBe('error');
      expect(computeToolCallStatus({}, 5, undefined, 'partial-fail')).toBe('error');
    });

    it('returns error when result object carries an error field', () => {
      expect(computeToolCallStatus({ error: '岗位查询失败' }, undefined)).toBe('error');
    });

    it('treats result.error === false as not-error', () => {
      // Some tools intentionally return { error: false } as a "no error" sentinel.
      // We must not treat that as failure.
      expect(computeToolCallStatus({ error: false }, 3)).toBe('ok');
    });

    it('maps resultCount 0 → empty, 1 → narrow, ≥2 → ok', () => {
      expect(computeToolCallStatus({ items: [] }, 0)).toBe('empty');
      expect(computeToolCallStatus({ items: [{}] }, 1)).toBe('narrow');
      expect(computeToolCallStatus({ items: [{}, {}] }, 2)).toBe('ok');
    });

    it('returns unknown when resultCount cannot be inferred', () => {
      expect(computeToolCallStatus({ message: 'fine' }, undefined)).toBe('unknown');
    });
  });
});
