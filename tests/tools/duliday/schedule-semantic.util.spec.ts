import {
  classifyScheduleSemantic,
  matchScheduleConstraint,
  ScheduleSemantic,
} from '@tools/duliday/schedule-semantic.util';

describe('classifyScheduleSemantic', () => {
  it.each([
    ['requires_full_week', '每天 05:00-23:00 固定排班'],
    ['mandatory_weekend_days', '周六周日都要给班'],
    ['weekend_only_compatible', '可只做周末'],
    ['evening_compatible', '晚班 18:00-22:00'],
    ['morning_compatible', '早班 06:00-10:00'],
    ['flexible', '自定义工时，可选时段，短班灵活'],
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

  it('also reads interview and requirement remarks', () => {
    expect(
      classifyScheduleSemantic({
        workTimeText: '',
        interviewRemark: '门店要求周末必到',
        requirementRemark: '候选人可选时段',
      }),
    ).toEqual(expect.arrayContaining(['mandatory_weekend_days', 'flexible']));
  });
});

describe('matchScheduleConstraint', () => {
  it('matches when no candidate constraint is provided', () => {
    expect(matchScheduleConstraint(['requires_full_week'], undefined)).toEqual({ matched: true });
  });

  describe('onlyWeekends', () => {
    it.each([
      [['weekend_only_compatible'], true, undefined],
      [['flexible'], true, undefined],
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
  });

  describe('onlyEvenings', () => {
    it.each([
      [['evening_compatible'], true, undefined],
      [['flexible'], true, undefined],
      [['morning_compatible'], false, '岗位仅安排早班，与"只做晚班"冲突'],
      [['requires_full_week'], false, '岗位是全周强排班，与"只做晚班"可能冲突，需进一步确认'],
      [['unknown'], false, '岗位排班未明确含晚班'],
    ] satisfies Array<[ScheduleSemantic[], boolean, string | undefined]>)(
      'handles semantics=%j',
      (semantics, matched, reason) => {
        expect(matchScheduleConstraint(semantics, { onlyEvenings: true })).toEqual({
          matched,
          ...(reason ? { reason } : {}),
        });
      },
    );
  });

  describe('onlyMornings', () => {
    it.each([
      [['morning_compatible'], true, undefined],
      [['flexible'], true, undefined],
      [['evening_compatible'], false, '岗位仅安排晚班，与"只做早班"冲突'],
      [['unknown'], false, '岗位排班未明确含早班'],
    ] satisfies Array<[ScheduleSemantic[], boolean, string | undefined]>)(
      'handles semantics=%j',
      (semantics, matched, reason) => {
        expect(matchScheduleConstraint(semantics, { onlyMornings: true })).toEqual({
          matched,
          ...(reason ? { reason } : {}),
        });
      },
    );
  });

  describe('maxDaysPerWeek', () => {
    it.each([
      [['requires_full_week'], 2, false],
      [['mandatory_weekend_days'], 2, false],
      [['flexible'], 2, true],
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
