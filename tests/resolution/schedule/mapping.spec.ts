import { completeEarlyShiftMapping } from '@resolution/schedule/mapping';

describe('早班固定映射补齐', () => {
  it.each(['有早班吗', '我只做早上的', '早晨可以'])('原话说到早班类词时补上午班：%s', (text) => {
    expect(completeEarlyShiftMapping({ includeAnyTags: ['early'] }, text)).toEqual({
      includeAnyTags: ['early', 'morning'],
    });
    expect(completeEarlyShiftMapping({ excludeTags: ['early', 'night'] }, '早班不做')).toEqual({
      excludeTags: ['early', 'morning', 'night'],
    });
  });
  it('开档只对应早班，不补上午班；已含上午班或没有早班标签时原样返回', () => {
    const open = { includeAnyTags: ['early' as const] };
    expect(completeEarlyShiftMapping(open, '有开档的班吗')).toBe(open);
    const full = { includeAnyTags: ['early' as const, 'morning' as const] };
    expect(completeEarlyShiftMapping(full, '有早班吗')).toBe(full);
    const evening = { includeAnyTags: ['evening' as const] };
    expect(completeEarlyShiftMapping(evening, '早上没空，只做晚班')).toBe(evening);
    expect(completeEarlyShiftMapping(undefined, '有早班吗')).toBeUndefined();
  });
});
