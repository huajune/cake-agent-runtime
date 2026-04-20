import {
  buildToolCallLimitNotice,
  collectCalledToolNames,
  computeResultCount,
  computeToolCallStatus,
  countToolCallsByName,
  findToolsExceedingLimit,
  MAX_SAME_TOOL_CALLS_PER_TURN,
} from '@agent/tool-call-analysis';

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

  describe('countToolCallsByName', () => {
    it('returns empty map when steps array is empty', () => {
      expect(countToolCallsByName([])).toEqual(new Map());
    });

    it('skips steps without toolCalls or with non-array toolCalls', () => {
      const steps = [
        {},
        { toolCalls: undefined },
        { toolCalls: 'not-an-array' as unknown as Array<{ toolName: string }> },
      ];
      expect(countToolCallsByName(steps)).toEqual(new Map());
    });

    it('aggregates counts across steps and skips invalid entries', () => {
      const steps = [
        { toolCalls: [{ toolName: 'duliday_job_list' }, { toolName: 'geocode' }] },
        { toolCalls: [{ toolName: 'duliday_job_list' }] },
        // invalid entries: missing toolName, empty string, wrong type
        { toolCalls: [{} as unknown as { toolName: string }] },
        { toolCalls: [{ toolName: '' }] },
        { toolCalls: [{ toolName: 42 as unknown as string }] },
      ];

      const counts = countToolCallsByName(steps);
      expect(counts.get('duliday_job_list')).toBe(2);
      expect(counts.get('geocode')).toBe(1);
      expect(counts.size).toBe(2);
    });
  });

  describe('collectCalledToolNames', () => {
    it('returns empty set when no steps', () => {
      expect(collectCalledToolNames([])).toEqual(new Set());
    });

    it('dedupes tool names across steps', () => {
      const steps = [
        { toolCalls: [{ toolName: 'duliday_job_list' }, { toolName: 'geocode' }] },
        { toolCalls: [{ toolName: 'duliday_job_list' }] },
      ];
      expect(collectCalledToolNames(steps)).toEqual(new Set(['duliday_job_list', 'geocode']));
    });

    it('ignores steps without toolCalls and invalid entries', () => {
      const steps = [
        {},
        { toolCalls: [{ toolName: '' }, { toolName: 'skip_reply' }] },
      ];
      expect(collectCalledToolNames(steps)).toEqual(new Set(['skip_reply']));
    });
  });

  describe('findToolsExceedingLimit', () => {
    const callStep = (name: string) => ({ toolCalls: [{ toolName: name }] });

    it('returns empty when no tool reaches the limit', () => {
      const steps = [callStep('a'), callStep('a'), callStep('b')];
      expect(findToolsExceedingLimit(steps, MAX_SAME_TOOL_CALLS_PER_TURN)).toEqual([]);
    });

    it('returns names that meet or exceed the limit', () => {
      const steps = [
        callStep('a'),
        callStep('a'),
        callStep('a'), // a == 3
        callStep('b'),
      ];
      expect(findToolsExceedingLimit(steps, 3).sort()).toEqual(['a']);
    });

    it('respects custom limit override', () => {
      const steps = [callStep('a'), callStep('a')];
      expect(findToolsExceedingLimit(steps, 2)).toEqual(['a']);
      expect(findToolsExceedingLimit(steps, 3)).toEqual([]);
    });

    it('defaults to MAX_SAME_TOOL_CALLS_PER_TURN', () => {
      const steps = Array.from({ length: MAX_SAME_TOOL_CALLS_PER_TURN }, () => callStep('x'));
      expect(findToolsExceedingLimit(steps)).toEqual(['x']);
    });
  });

  describe('buildToolCallLimitNotice', () => {
    it('returns empty string when no tools blocked', () => {
      expect(buildToolCallLimitNotice([])).toBe('');
    });

    it('renders one line per blocked tool with the limit number', () => {
      const notice = buildToolCallLimitNotice(['duliday_job_list', 'geocode'], 3);
      const lines = notice.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('duliday_job_list');
      expect(lines[0]).toContain('3');
      expect(lines[1]).toContain('geocode');
    });

    it('uses default limit when not provided', () => {
      const notice = buildToolCallLimitNotice(['a']);
      expect(notice).toContain(String(MAX_SAME_TOOL_CALLS_PER_TURN));
    });
  });
});
