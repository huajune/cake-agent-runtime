import {
  normalizeProvinceToId,
  parseHouseholdProvince,
} from '@resolution/candidate/household-province';

describe('parseHouseholdProvince', () => {
  // 户籍是红线字段（不得据此筛人），但候选人自陈时仍要正确入档而非乱记。
  it.each([
    ['我户籍是河南省', '河南省'],
    ['籍贯河南', '河南'],
    ['老家在四川', '四川'],
    ['户口：北京', '北京'],
  ])('parses %s → %s', (text, expected) => {
    expect(parseHouseholdProvince(text)?.value).toBe(expected);
  });

  it('keeps the matched excerpt as evidence', () => {
    expect(parseHouseholdProvince('我户籍是河南省，现在在上海')?.excerpt).toContain('户籍');
  });

  it('strips 自治区/特别行政区 后缀取常用简称', () => {
    expect(parseHouseholdProvince('籍贯广西')?.value).toBe('广西');
    expect(parseHouseholdProvince('老家新疆')?.value).toBe('新疆');
    expect(parseHouseholdProvince('户籍内蒙古')?.value).toBe('内蒙古');
  });

  it('returns null without a 户籍/籍贯/老家/户口 cue（普通地名不算户籍自陈）', () => {
    expect(parseHouseholdProvince('我在河南工作过')).toBeNull();
    expect(parseHouseholdProvince('想找上海的兼职')).toBeNull();
  });

  it('returns null when the cue is followed by an unknown province', () => {
    expect(parseHouseholdProvince('籍贯火星')).toBeNull();
  });
});

describe('normalizeProvinceToId', () => {
  it('maps a province label to the sponge id', () => {
    expect(normalizeProvinceToId('北京市')).toBe(110000);
  });

  it('returns null for an unknown label', () => {
    expect(normalizeProvinceToId('火星省')).toBeNull();
  });

  it('round-trips a parsed household province into an id', () => {
    const parsed = parseHouseholdProvince('户籍是北京市');
    expect(parsed?.value).toBe('北京市');
    expect(normalizeProvinceToId(parsed?.value ?? '')).toBe(110000);
  });
});
