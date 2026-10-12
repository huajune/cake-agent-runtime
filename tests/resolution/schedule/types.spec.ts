import {
  CandidateScheduleConstraintSchema,
  type StoredScheduleConstraint,
  StoredScheduleConstraintSchema,
  mergeScheduleConstraints,
  readScheduleConditions,
} from '@resolution/schedule/types';

describe('旧契约落盘时段的读取兼容', () => {
  it.each([
    [
      { start: '22:00', end: '06:00' },
      { start: '22:00', end: '06:00', endDayOffset: 1 },
    ],
    [
      { start: '9:00', end: '17:00' },
      { start: '09:00', end: '17:00' },
    ],
    [
      { start: '18:00', end: '00:00' },
      { start: '18:00', end: '24:00' },
    ],
    [
      { start: '15:00', end: '21:00' },
      { start: '15:00', end: '21:00' },
    ],
  ])('结束不晚于开始按旧语义视为跨午夜，钟点补零：%j', (legacy, expected) => {
    const parsed = StoredScheduleConstraintSchema.parse({ availableWindow: legacy });
    expect(parsed.availableWindow).toEqual(expected);
    expect(CandidateScheduleConstraintSchema.safeParse(parsed).success).toBe(true);
  });

  it('旧默认 null 形态整体可读', () => {
    expect(
      StoredScheduleConstraintSchema.parse({
        onlyWeekends: null,
        onlyEvenings: true,
        onlyMornings: null,
        maxDaysPerWeek: 3,
        availableWindow: { start: '20:00', end: '02:00' },
      }),
    ).toEqual({
      onlyWeekends: null,
      onlyEvenings: true,
      onlyMornings: null,
      maxDaysPerWeek: 3,
      availableWindow: { start: '20:00', end: '02:00', endDayOffset: 1 },
    });
  });

  it.each([{ start: '08:00', end: '08:00' }, { start: '晚上', end: '早上' }, {}])(
    '含义无法确定的旧时段不擅自放宽，仍交由重新确认：%j',
    (legacy) =>
      expect(StoredScheduleConstraintSchema.safeParse({ availableWindow: legacy }).success).toBe(
        false,
      ),
  );

  it('模型侧契约仍要求显式 endDayOffset', () => {
    expect(
      CandidateScheduleConstraintSchema.safeParse({
        availableWindow: { start: '22:00', end: '06:00' },
      }).success,
    ).toBe(false);
  });
});

describe('候选人条件契约', () => {
  it.each<StoredScheduleConstraint>([
    { excludeTags: ['night'] },
    { unavailableWindow: { start: '12:00', end: '14:00' } },
    { unavailableWindow: null },
    { excludeTags: [] },
  ])('无关补丁不解除历史早晚班限制：%j', (patch) => {
    for (const legacy of [{ onlyEvenings: true }, { onlyMornings: true }]) {
      const merged = mergeScheduleConstraints(legacy, patch);
      expect(merged).toMatchObject(legacy);
      expect(readScheduleConditions(merged).legacyUnresolved).toBe(true);
    }
  });
  it.each<StoredScheduleConstraint>([
    { includeAnyTags: ['evening'] },
    { availableWindow: { start: '18:00' } },
  ])('明确的新可出勤条件替换历史早晚班含义：%j', (patch) => {
    const merged = mergeScheduleConstraints({ onlyEvenings: true }, patch);
    expect(merged).toEqual(patch);
    expect(readScheduleConditions(merged).legacyUnresolved).toBe(false);
  });
  it.each<StoredScheduleConstraint>([
    { includeAnyTags: [] },
    { availableWindow: null },
    { includeAnyTags: [], availableWindow: null },
  ])('候选人明确撤销日内正向条件时同时解除历史早晚班限制：%j', (patch) => {
    for (const legacy of [{ onlyEvenings: true }, { onlyMornings: true }]) {
      const merged = mergeScheduleConstraints({ ...legacy, maxDaysPerWeek: 3 }, patch);
      expect(merged).toEqual({ maxDaysPerWeek: 3, ...patch });
      expect(readScheduleConditions(merged).legacyUnresolved).toBe(false);
    }
  });
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
