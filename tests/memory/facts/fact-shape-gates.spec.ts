import {
  detectScalarFanoutValues,
  isPlausibleAgeValue,
  isPlausibleCityValue,
} from '@memory/facts/fact-shape-gates';

describe('detectScalarFanoutValues (badcase 6a6c4c13 标量扇出污染)', () => {
  it('badcase 原形：整句同时落 city/salary/age → 检出扇出值', () => {
    const fanout = detectScalarFanoutValues({
      'preferences.city': '晚上才可以，有吗？',
      'preferences.salary': '晚上才可以，有吗？',
      'interview_info.age': '晚上才可以，有吗？',
      'preferences.labor_form': '兼职',
    });
    expect(fanout).toEqual(new Set(['晚上才可以，有吗？']));
  });

  it('两个字段同值不触发（city=district 同名等合法形态）', () => {
    const fanout = detectScalarFanoutValues({
      'preferences.city': '东莞',
      'preferences.district': '东莞',
      'interview_info.age': '30',
    });
    expect(fanout.size).toBe(0);
  });

  it('布尔/数字/短串不参与统计', () => {
    const fanout = detectScalarFanoutValues({
      a: false,
      b: false,
      c: false,
      d: 1,
      e: 1,
      f: 1,
      g: '是',
      h: '是',
      i: '是',
    });
    expect(fanout.size).toBe(0);
  });
});

describe('isPlausibleCityValue', () => {
  it.each(['东莞', '上海', '呼和浩特', '巴音郭楞', '巴音郭楞蒙古自治州', '克孜勒苏柯尔克孜自治州'])(
    '放行真实城市名 %s',
    (city) => {
      expect(isPlausibleCityValue(city)).toBe(true);
    },
  );

  it.each([
    '晚上才可以，有吗？',
    '晚上才可以有吗',
    '我在广东不是上海哈是的呢',
    '我在广东不是上海哈是的',
    '我在广东不是上海这个城市',
    '杜撰测试蒙古自治州',
    '我想去巴音郭楞蒙古自治州',
    '上海？',
    '城市 未知',
    '静安区123',
  ])('拒绝整句/疑问/含标点数字文本 %s', (value) => {
    expect(isPlausibleCityValue(value)).toBe(false);
  });

  // 2026-08-06 生产观测：这批短串全部穿过了旧的"8 字内自由放行"，落进 pref.city，
  // 再由 geocode 变成推给候选人的多余城市反问。短串靠形状分辨不出真假，只能查表。
  it.each(['hello', 'null', '只晚班', '我是应聘的', '平坊', '我是BOSS'])(
    '拒绝行政区数据认不出的短串 %s',
    (value) => {
      expect(isPlausibleCityValue(value)).toBe(false);
    },
  );

  it('放行真实县级市与同形城市名（海南东方市 / 昆山）', () => {
    expect(isPlausibleCityValue('东方')).toBe(true);
    expect(isPlausibleCityValue('昆山')).toBe(true);
    expect(isPlausibleCityValue('上海市')).toBe(true);
  });

  it('区名不是城市值——归属地由 district 解析另行补出，占着 city 只会喂错城市门', () => {
    expect(isPlausibleCityValue('浦东新区')).toBe(false);
    expect(isPlausibleCityValue('静安区')).toBe(false);
  });
});

describe('isPlausibleAgeValue', () => {
  it.each(['39', '39岁', 25, '18'])('放行合法年龄 %s', (value) => {
    expect(isPlausibleAgeValue(value)).toBe(true);
  });

  it.each(['晚上才可以，有吗？', '18-25', '108', '3', '', null, undefined, '13'])(
    '拒绝非法年龄 %s',
    (value) => {
      expect(isPlausibleAgeValue(value)).toBe(false);
    },
  );
});
