import {
  buildSideEffectBlockNotice,
  buildToolCallLimitNotice,
  collectCalledToolNames,
  computeResultCount,
  computeToolCallStatus,
  countToolCallsByName,
  findSucceededSideEffectTools,
  findToolsExceedingLimit,
  MAX_SAME_TOOL_CALLS_PER_TURN,
  SIDE_EFFECT_TOOLS,
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

    it('prefers explicit resultCount field over other heuristics', () => {
      // duliday_job_list 自报口径：{ markdown, queryMeta, resultCount }
      expect(computeResultCount({ resultCount: 5, items: [1] })).toBe(5);
      expect(computeResultCount({ resultCount: 0, markdown: '# 在招岗位（共 0 个）' })).toBe(0);
    });

    it('infers count from geocode resolution shape', () => {
      expect(computeResultCount({ resolution: 'unique', result: { city: '北京市' } })).toBe(1);
      expect(computeResultCount({ resolution: 'ambiguous', candidates: [{}, {}, {}] })).toBe(3);
    });

    it('reads candidates array container', () => {
      expect(computeResultCount({ candidates: [{}, {}] })).toBe(2);
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

    it('maps resultCount 0 → empty, ≥2 → ok', () => {
      expect(computeToolCallStatus({ items: [] }, 0)).toBe('empty');
      expect(computeToolCallStatus({ items: [{}, {}] }, 2)).toBe('ok');
    });

    it('narrow only applies to search tools; single result elsewhere is ok', () => {
      expect(
        computeToolCallStatus({ resultCount: 1 }, 1, undefined, undefined, 'duliday_job_list'),
      ).toBe('narrow');
      // geocode unique 命中 1 条是正常形态，不应标 narrow
      expect(
        computeToolCallStatus({ resolution: 'unique' }, 1, undefined, undefined, 'geocode'),
      ).toBe('ok');
      // 未传 toolName 时保守不标 narrow
      expect(computeToolCallStatus({ items: [{}] }, 1)).toBe('ok');
    });

    it('detects buildToolError shape as error', () => {
      // buildToolError: { [successKey]: false, errorType, _replyInstruction }
      expect(
        computeToolCallStatus(
          { success: false, errorType: 'precheck.job_not_found', _replyInstruction: '...' },
          undefined,
        ),
      ).toBe('error');
      expect(
        computeToolCallStatus({ accepted: false, errorType: 'invite.no_group' }, undefined),
      ).toBe('error');
      expect(computeToolCallStatus({ errorType: 'geocode.unresolved_address' }, undefined)).toBe(
        'error',
      );
    });

    it('maps success flags to ok when count is not inferable', () => {
      expect(
        computeToolCallStatus({ success: true, newStage: 'job_consultation' }, undefined),
      ).toBe('ok');
      expect(computeToolCallStatus({ accepted: true, code: null }, undefined)).toBe('ok');
      expect(computeToolCallStatus({ skipped: true, reason: '纯确认词' }, undefined)).toBe('ok');
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
      const steps = [{}, { toolCalls: [{ toolName: '' }, { toolName: 'skip_reply' }] }];
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

  describe('findSucceededSideEffectTools', () => {
    it('returns empty when no side-effect tools were called', () => {
      const steps = [
        { toolResults: [{ toolName: 'duliday_job_list', output: { resultCount: 3 } }] },
      ];
      expect(findSucceededSideEffectTools(steps)).toEqual([]);
    });

    it('returns side-effect tools that succeeded', () => {
      const steps = [
        {
          toolResults: [
            { toolName: 'duliday_interview_booking', output: { success: true, workOrderId: 1 } },
          ],
        },
      ];
      expect(findSucceededSideEffectTools(steps)).toEqual(['duliday_interview_booking']);
    });

    it('does not block retry after a failed side-effect call', () => {
      // buildToolError 形态：失败调用允许模型修正参数后重试
      const steps = [
        {
          toolResults: [
            {
              toolName: 'duliday_interview_booking',
              output: { success: false, errorType: 'booking.missing_fields' },
            },
          ],
        },
      ];
      expect(findSucceededSideEffectTools(steps)).toEqual([]);
    });

    it('does not block when result status is unknown or empty (conservative retry)', () => {
      const steps = [
        // 结构不可识别 → unknown：不视为成功，放行重试
        { toolResults: [{ toolName: 'duliday_interview_booking', output: { foo: 'bar' } }] },
        // resultCount 0 → empty：同样不视为副作用已生效
        { toolResults: [{ toolName: 'invite_to_group', output: { resultCount: 0 } }] },
      ];
      expect(findSucceededSideEffectTools(steps)).toEqual([]);
    });

    it('dedupes across steps and covers all registered side-effect tools', () => {
      const steps = [
        { toolResults: [{ toolName: 'invite_to_group', output: { accepted: true } }] },
        { toolResults: [{ toolName: 'invite_to_group', output: { accepted: true } }] },
      ];
      expect(findSucceededSideEffectTools(steps)).toEqual(['invite_to_group']);
      expect(SIDE_EFFECT_TOOLS.has('duliday_cancel_work_order')).toBe(true);
      expect(SIDE_EFFECT_TOOLS.has('duliday_modify_interview_time')).toBe(true);
    });
  });

  describe('buildSideEffectBlockNotice', () => {
    it('returns empty string when nothing blocked', () => {
      expect(buildSideEffectBlockNotice([])).toBe('');
    });

    it('renders one line per blocked tool', () => {
      const notice = buildSideEffectBlockNotice(['duliday_interview_booking']);
      expect(notice).toContain('duliday_interview_booking');
      expect(notice).toContain('不可重复调用');
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
