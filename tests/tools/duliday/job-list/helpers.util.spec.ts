import {
  cleanMultilineText,
  cleanNumber,
  cleanSingleLineText,
  compressWeekdays,
  formatNameWithId,
  formatRange,
  formatTimeRange,
  formatValueWithUnit,
  hasFullWeekOrRigidSchedule,
  hasValue,
  isNonEmpty,
  pushField,
  pushLongText,
  stripCityPrefixFromStoreName,
} from '@tools/duliday/job-list/helpers.util';

describe('job-list helpers util', () => {
  it('distinguishes shallow and recursive non-empty values', () => {
    expect(hasValue('  ')).toBe(false);
    expect(hasValue([])).toBe(false);
    expect(hasValue({ nested: '' })).toBe(true);

    expect(isNonEmpty({ nested: '' })).toBe(false);
    expect(isNonEmpty({ nested: [' ', null, { value: 'ok' }] })).toBe(true);
  });

  it('cleans single-line and multiline text without flattening useful line breaks', () => {
    expect(cleanSingleLineText('辛苦跟店长确认。保留手动输入！！')).toBe('保留！');
    expect(cleanMultilineText('\n\n第一行  \n\n\n第二行\n\n')).toBe('第一行\n\n第二行');
  });

  it('pushes short and long markdown fields only when values are meaningful', () => {
    const lines: string[] = [];

    pushField(lines, '品牌', ' 肯德基 ');
    pushField(lines, '空字段', '   ');
    pushLongText(lines, '备注', '第一行\n第二行');

    expect(lines).toEqual(['- **品牌**: 肯德基', '- **备注**:', '  第一行', '  第二行']);
  });

  it('formats numeric values, ranges, names and time ranges for markdown display', () => {
    expect(cleanNumber('24.500')).toBe(24.5);
    expect(cleanNumber(Number.NaN)).toBeNull();
    expect(formatValueWithUnit('24.00', '元/时')).toBe('24 元/时');
    expect(formatRange(150, 200, '元/天')).toBe('150-200 元/天');
    expect(formatRange(180, 180, '元/天')).toBe('180 元/天');
    expect(formatNameWithId('肯德基', 10005)).toBe('肯德基 (ID: 10005)');
    expect(formatTimeRange('18:00', '22:00')).toBe('18:00 - 22:00');
    expect(formatTimeRange('18:00', '')).toBe('18:00 起');
    expect(formatTimeRange('', '22:00')).toBe('至 22:00');
  });

  it('strips duplicated city prefixes from store names but keeps meaningful names', () => {
    expect(stripCityPrefixFromStoreName('上海莘庄龙之梦店', '上海市')).toBe('莘庄龙之梦店');
    expect(stripCityPrefixFromStoreName('北京-青塔店', '北京')).toBe('青塔店');
    expect(stripCityPrefixFromStoreName('静安寺店', '上海')).toBe('静安寺店');
    expect(stripCityPrefixFromStoreName(null, '上海')).toBeNull();
  });

  it('compresses full-week tokens and detects rigid scheduling language', () => {
    expect(compressWeekdays('每周一,每周二,每周三,每周四,每周五,每周六,每周日')).toBe('每天');
    expect(compressWeekdays('每周六，每周日')).toBe('每周六, 每周日');

    expect(hasFullWeekOrRigidSchedule(['每天 05:00 - 23:00', '固定排班'])).toBe(true);
    expect(hasFullWeekOrRigidSchedule(['仅周末短班'])).toBe(false);
  });
});
