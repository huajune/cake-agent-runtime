import {
  CandidateScheduleConstraintSchema,
  mergeScheduleConstraints,
  readScheduleConditions,
} from '@resolution/schedule/types';

describe('候选人条件契约', () => {
  it.each([
    { availableWindow: {} },
    { availableWindow: { start: '24:00' } },
    { availableWindow: { start: '22:00', end: '06:00' } },
    { availableWindow: { start: '15:00', end: '16:00', endDayOffset: 1 } },
    { minShiftHours: 8, maxShiftHours: 4 },
  ])('拒绝不明确或矛盾输入 %j', (value) =>
    expect(CandidateScheduleConstraintSchema.safeParse(value).success).toBe(false),
  );
  it('省略延续，显式清空不复活旧字段', () => {
    const merged = mergeScheduleConstraints(
      {
        onlyWeekends: true,
        onlyEvenings: true,
        includeAnyTags: ['evening'],
        availableWindow: { start: '18:00' },
      },
      { includeAnyTags: [], availableWindow: null },
    );
    expect(merged).toEqual({ onlyWeekends: true, includeAnyTags: [], availableWindow: null });
    expect(readScheduleConditions(merged).legacyUnresolved).toBe(false);
  });
});
