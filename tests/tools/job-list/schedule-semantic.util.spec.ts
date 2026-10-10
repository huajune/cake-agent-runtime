import {
  classifyScheduleSemantic,
  matchScheduleConstraint,
  ScheduleSemantic,
} from '@tools/job-list/schedule-semantic.util';

describe('classifyScheduleSemantic', () => {
  it.each([
    ['requires_full_week', '每天 05:00-23:00 固定排班'],
    ['mandatory_weekend_days', '周六周日都要给班'],
    ['weekend_only_compatible', '可只做周末'],
  ] satisfies Array<[ScheduleSemantic, string]>)('detects %s', (semantic, workTimeText) => {
    expect(classifyScheduleSemantic({ workTimeText })).toEqual(expect.arrayContaining([semantic]));
  });

  it('returns unknown when no schedule text exists', () => {
    expect(classifyScheduleSemantic({ workTimeText: null })).toEqual(['unknown']);
  });

  it('does not treat duplicate same-day pairs as mandatory weekend coverage', () => {
    expect(classifyScheduleSemantic({ workTimeText: '周六周六可排，其他时间待定' })).not.toContain(
      'mandatory_weekend_days',
    );
  });

  it('derives requires_full_week from weekAndMonthWorkTime.perWeekWorkDays >= 5 (做六休一)', () => {
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: {
        weekMonthArrangementMode: '做几休几',
        perWeekWorkDays: 6,
        perWeekRestDays: 1,
      },
      dayWorkTime: { arrangementType: '灵活排班' },
    });

    expect(classifyScheduleSemantic({ workTimeText })).toEqual(
      expect.arrayContaining(['requires_full_week']),
    );
  });

  it('derives requires_full_week from 至少上岗 N 天 (onWorkTime/onWorkLimitType)', () => {
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: {
        onWorkLimitType: '至少上岗',
        onWorkTimeUnit: '天',
        onWorkTime: 5,
      },
    });

    expect(classifyScheduleSemantic({ workTimeText })).toEqual(
      expect.arrayContaining(['requires_full_week']),
    );
  });

  it('does not mark low per-week days as full week', () => {
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: { perWeekWorkDays: 3, perWeekRestDays: 4 },
    });

    expect(classifyScheduleSemantic({ workTimeText })).not.toContain('requires_full_week');
  });

  it('derives low weekly frequency, not time flexibility, from perWeekWorkDays <= 2', () => {
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: { perWeekWorkDays: 2, perWeekRestDays: 5 },
    });

    const semantics = classifyScheduleSemantic({ workTimeText });
    expect(semantics).toContain('low_weekly_frequency');
    expect(semantics).not.toContain('flexible');
  });

  it('做一休一 (perWeekWorkDays 1 + perWeekRestDays 1) is a rotation, not a 1-day-per-week job', () => {
    // 哈根达斯南丰城新店：做一休一被当成每周 1 天 → 判成低频岗放给只做周末的候选人
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: { perWeekWorkDays: 1, perWeekRestDays: 1 },
    });

    const semantics = classifyScheduleSemantic({ workTimeText });
    expect(semantics).not.toContain('low_weekly_frequency');
    expect(matchScheduleConstraint(semantics, { onlyWeekends: true }).matched).toBe(false);
  });

  it('badcase id4zx7q9: 固定排班 label with 每周至少 2 天 has low weekly frequency', () => {
    // 哈根达斯又一城：排班类型「固定排班」+ 每周至少上岗 2 天，周末可做，
    // 曾被 /固定排班/ 文本判据误判 requires_full_week 致"只周末"候选人被告知无岗。
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: {
        onWorkLimitType: '至少上岗',
        onWorkTimeUnit: '天',
        onWorkTime: 2,
      },
      dayWorkTime: {
        arrangementType: '固定排班',
        combinedArrangement: [
          { combinedArrangementStartTime: '09:30', combinedArrangementEndTime: '22:30' },
        ],
      },
    });

    const semantics = classifyScheduleSemantic({ workTimeText });
    expect(semantics).not.toContain('requires_full_week');
    expect(semantics).not.toContain('flexible');
    expect(semantics).toContain('low_weekly_frequency');
    expect(matchScheduleConstraint(semantics, { onlyWeekends: true })).toEqual({ matched: true });
  });

  it('固定排班 label alone (no weekly-days data) is not full week', () => {
    const workTimeText = JSON.stringify({ dayWorkTime: { arrangementType: '固定排班' } });

    expect(classifyScheduleSemantic({ workTimeText })).not.toContain('requires_full_week');
  });

  it('explicit full-week text still wins over low weekly-days structure', () => {
    const workTimeText = JSON.stringify({
      weekAndMonthWorkTime: { onWorkLimitType: '至少上岗', onWorkTimeUnit: '天', onWorkTime: 2 },
      dayWorkTime: { workTimeRemark: '做六休一' },
    });

    const semantics = classifyScheduleSemantic({ workTimeText });
    expect(semantics).toContain('requires_full_week');
    expect(matchScheduleConstraint(semantics, { onlyWeekends: true }).matched).toBe(false);
  });

  it('also reads interview and requirement remarks', () => {
    expect(
      classifyScheduleSemantic({
        workTimeText: '',
        interviewRemark: '门店要求周末必到',
        requirementRemark: '候选人可选时段',
      }),
    ).toEqual(expect.arrayContaining(['mandatory_weekend_days']));
  });
});

describe('matchScheduleConstraint', () => {
  it('matches when no candidate constraint is provided', () => {
    expect(matchScheduleConstraint(['requires_full_week'], undefined)).toEqual({ matched: true });
  });

  describe('onlyWeekends', () => {
    it.each([
      [['weekend_only_compatible'], true, undefined],
      [['low_weekly_frequency'], true, undefined],
      [['requires_full_week'], false, '岗位是全周强排班，与"只做周末"冲突'],
      [['mandatory_weekend_days'], false, '岗位除周末外还要工作日给班，与"只做周末"冲突'],
      [['unknown'], false, '岗位排班未明确允许只做周末'],
    ] satisfies Array<[ScheduleSemantic[], boolean, string | undefined]>)(
      'handles semantics=%j',
      (semantics, matched, reason) => {
        expect(matchScheduleConstraint(semantics, { onlyWeekends: true })).toEqual({
          matched,
          ...(reason ? { reason } : {}),
        });
      },
    );

    it('lets full-week semantics override flexible for badcase 6a57332c', () => {
      expect(
        matchScheduleConstraint(['requires_full_week', 'low_weekly_frequency'], { onlyWeekends: true }),
      ).toEqual({ matched: false, reason: '岗位是全周强排班，与"只做周末"冲突' });
    });
  });

  describe('maxDaysPerWeek', () => {
    it.each([
      [['requires_full_week'], 2, false],
      [['mandatory_weekend_days'], 2, false],
      [['low_weekly_frequency'], 2, true],
      [['unknown'], 2, true],
      [['requires_full_week'], 3, true],
    ] satisfies Array<[ScheduleSemantic[], number, boolean]>)(
      'handles semantics=%j maxDaysPerWeek=%s',
      (semantics, maxDaysPerWeek, matched) => {
        const result = matchScheduleConstraint(semantics, { maxDaysPerWeek });
        expect(result.matched).toBe(matched);
        if (!matched) {
          expect(result.reason).toContain(`每周最多 ${maxDaysPerWeek} 天`);
        }
      },
    );
  });
});
