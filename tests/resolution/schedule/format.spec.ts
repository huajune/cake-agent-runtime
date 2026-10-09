import { formatStoredScheduleConstraint } from '@resolution/schedule/format';

describe('班次记忆统一投影', () => {
  it('明确撤销的条件不产生仍有限制的文本', () => {
    expect(
      formatStoredScheduleConstraint({ includeAnyTags: [], availableWindow: null }),
    ).toBeNull();
    expect(formatStoredScheduleConstraint(null)).toBeNull();
  });

  it('次日时段与周频独立展示，主生成和修复可以读取相同事实', () => {
    const text = formatStoredScheduleConstraint({
      onlyWeekends: true,
      availableWindow: { start: '22:00', end: '06:00', endDayOffset: 1 },
      maxShiftHours: 8,
    });
    expect(text).toContain('只周末');
    expect(text).toContain('22:00-次日06:00');
    expect(text).toContain('每班至多 8 小时');
  });

  it('旧会话偏好仅提示确认，不捏造具体时段', () => {
    expect(formatStoredScheduleConstraint({ onlyEvenings: true })).toBe('历史早晚班偏好含义需确认');
    expect(formatStoredScheduleConstraint({ availableWindow: {} })).toBe('已有排班条件需重新确认');
  });
});
