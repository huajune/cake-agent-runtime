import {
  fixedSlotsRelation,
  LONG_SLOT_MAX_MINUTES,
  LONG_SLOT_MIN_MINUTES,
  longSlotArrangement,
} from '@resolution/schedule/slots';

const range = (start: string, end: string) => {
  const toMinute = (clock: string) => {
    const [h, m] = clock.split(':').map(Number);
    return h * 60 + m;
  };
  const startMinute = toMinute(start);
  let endMinute = toMinute(end);
  if (endMinute <= startMinute) endMinute += 1440;
  return { startMinute, endMinute };
};

describe('longSlotArrangement', () => {
  it('超过 12 小时的班次按 6-8 小时兜底', () => {
    expect(longSlotArrangement(range('09:30', '22:30'))).toEqual({
      minMinutes: LONG_SLOT_MIN_MINUTES,
      maxMinutes: LONG_SLOT_MAX_MINUTES,
    });
    expect(LONG_SLOT_MIN_MINUTES).toBe(360);
    expect(LONG_SLOT_MAX_MINUTES).toBe(480);
  });

  it('正好 12 小时不兜底，多 1 分钟才兜底', () => {
    expect(longSlotArrangement(range('10:00', '22:00'))).toBeUndefined();
    expect(longSlotArrangement({ startMinute: 600, endMinute: 1321 })).toBeDefined();
  });

  it('跨零点的超长班次同样兜底', () => {
    expect(longSlotArrangement(range('05:00', '01:00'))).toBeDefined();
  });
});

describe('fixedSlotsRelation', () => {
  it('只有一个班次时为 single', () => {
    expect(fixedSlotsRelation([range('12:00', '15:00')])).toBe('single');
  });

  it('班次互相重叠时认定不在同一天上', () => {
    expect(fixedSlotsRelation([range('07:00', '15:00'), range('14:00', '22:00')])).toBe(
      'separate_days',
    );
  });

  it('不重叠但合计超过 12 小时时认定不在同一天上', () => {
    expect(fixedSlotsRelation([range('07:00', '16:00'), range('16:00', '01:00')])).toBe(
      'separate_days',
    );
  });

  it('首尾相接不算重叠：合计不超过 12 小时时为未明确', () => {
    expect(fixedSlotsRelation([range('08:00', '12:00'), range('12:00', '16:00')])).toBe('unclear');
  });

  it('不重叠且合计正好 12 小时时为未明确', () => {
    expect(fixedSlotsRelation([range('06:00', '12:00'), range('14:00', '20:00')])).toBe('unclear');
  });

  it('典型两头班（午市加晚市）为未明确', () => {
    expect(fixedSlotsRelation([range('11:30', '14:00'), range('17:30', '19:30')])).toBe('unclear');
  });

  it('三档中任意两档重叠即认定不在同一天上', () => {
    expect(
      fixedSlotsRelation([
        range('08:00', '14:00'),
        range('11:00', '20:00'),
        range('15:00', '23:00'),
      ]),
    ).toBe('separate_days');
  });
});
