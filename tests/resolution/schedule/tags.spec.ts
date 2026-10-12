import { buildShiftTags } from '@resolution/schedule/tags';

describe('班次标签阈值', () => {
  it('59分钟不打标，60分钟打标，同一班次可以多标签', () => {
    expect(buildShiftTags({ startMinute: 421, endMinute: 600 })).toEqual(['morning']);
    expect(buildShiftTags({ startMinute: 420, endMinute: 600 })).toEqual(['early', 'morning']);
  });
  it('21点起或跨过零点为夜班，不沿用60分钟阈值', () => {
    expect(buildShiftTags({ startMinute: 1260, endMinute: 1290 })).toEqual(['night']);
    expect(buildShiftTags({ startMinute: 1200, endMinute: 1450 })).toContain('night');
  });
});
