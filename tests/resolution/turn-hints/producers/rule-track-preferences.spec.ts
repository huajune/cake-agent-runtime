import {
  extractAvailableAfterDate,
  extractLaborForm,
  extractLocation,
  extractPositions,
  extractSalary,
  extractSchedule,
  extractScheduleConstraintStructured,
} from '@resolution/turn-hints/producers/rule-track-preferences';

describe('rule-track preferences · extractLaborForm', () => {
  it('reads an explicit labor-form intent', () => {
    expect(extractLaborForm('我想找兼职')).toBe('兼职');
    expect(extractLaborForm('要全职的')).toBe('全职');
  });

  it('returns null when the message carries no set-intent', () => {
    expect(extractLaborForm('有什么岗位')).toBeNull();
  });
});

describe('extractSalary', () => {
  it.each([
    ['时薪30以上', '时薪30'],
    ['25元/小时能接受', '25元/小时'],
    ['月薪5000起', '月薪5000'],
  ])('parses %s', (message, expected) => {
    expect(extractSalary(message)).toBe(expected);
  });

  it('accepts a bare range only with a semantic prefix or unit suffix', () => {
    expect(extractSalary('工资5000-6000')).toBe('工资5000-6000');
    expect(extractSalary('5000-6000元')).toBe('5000-6000元');
  });

  it('rejects a bare number range with no salary context（岗位编号/门店号不是薪资）', () => {
    expect(extractSalary('看下 3000-4000 这几个编号')).toBeNull();
  });

  it('returns null without any salary signal', () => {
    expect(extractSalary('我明天有空')).toBeNull();
  });
});

describe('extractPositions', () => {
  it('returns catalog keywords present in the message', () => {
    expect(extractPositions('我想做服务员')).toContain('服务员');
  });

  it('returns an empty list without a keyword', () => {
    expect(extractPositions('随便什么都行')).toEqual([]);
  });
});

describe('extractSchedule', () => {
  it('joins every matched schedule signal, deduped', () => {
    const schedule = extractSchedule('我只能上晚班，不上夜班');
    expect(schedule).toContain('晚班');
    expect(schedule).toContain('不上夜班');
  });

  it('renders a weekly upper bound as 每周最多N天', () => {
    expect(extractSchedule('一周最多能上三天')).toContain('每周最多三天');
  });

  it('picks up an explicit time range', () => {
    expect(extractSchedule('下午2点到6点有空')).toContain('2点到6点');
  });

  it('picks up 下班后 availability', () => {
    expect(extractSchedule('我晚上7点才下班')).toContain('下班后');
  });

  it('returns null when nothing matches', () => {
    expect(extractSchedule('有岗位吗')).toBeNull();
  });
});

describe('extractScheduleConstraintStructured', () => {
  it('turns 只能周末 into onlyWeekends', () => {
    expect(extractScheduleConstraintStructured('我只能周末上班')).toMatchObject({
      onlyWeekends: true,
    });
  });

  it('turns 只上晚班 into onlyEvenings', () => {
    expect(extractScheduleConstraintStructured('只上晚班')).toMatchObject({ onlyEvenings: true });
  });

  it('turns 只上早班 into onlyMornings', () => {
    expect(extractScheduleConstraintStructured('只能上早班')).toMatchObject({
      onlyMornings: true,
    });
  });

  it('reads maxDaysPerWeek from an upper-bound phrasing', () => {
    expect(extractScheduleConstraintStructured('一周最多上四天')).toMatchObject({
      maxDaysPerWeek: 4,
    });
  });

  it('returns null when no structured constraint is present（不产出全 null 的空壳）', () => {
    expect(extractScheduleConstraintStructured('我想找兼职')).toBeNull();
  });
});

describe('extractAvailableAfterDate', () => {
  const today = '2026-08-13';

  it('parses a full date after today', () => {
    expect(extractAvailableAfterDate('2026-09-01之后可以上班', today)).toEqual({
      date: '2026-09-01',
      raw: expect.stringContaining('2026-09-01'),
    });
  });

  it('parses 月日 form and keeps it in the current year when still ahead', () => {
    expect(extractAvailableAfterDate('9月1号以后有空', today)?.date).toBe('2026-09-01');
  });

  it('rolls a past 月日 into next year（8月1号已过，说的是明年）', () => {
    expect(extractAvailableAfterDate('8月1号以后有空', today)?.date).toBe('2027-08-01');
  });

  it('parses the dotted form', () => {
    expect(extractAvailableAfterDate('9.5之后开始', today)?.date).toBe('2026-09-05');
  });

  it('rejects an impossible calendar date instead of rolling it over', () => {
    expect(extractAvailableAfterDate('13月45号以后', today)).toBeNull();
  });

  it('ignores a full date that is not after today', () => {
    expect(extractAvailableAfterDate('2026-08-01之后', today)).toBeNull();
  });

  it('returns null without a date cue', () => {
    expect(extractAvailableAfterDate('随时可以', today)).toBeNull();
  });
});

describe('extractLocation', () => {
  it('lifts a city with high confidence and evidence', () => {
    const signals = extractLocation('我在上海');
    expect(signals.city).toMatchObject({ value: '上海', confidence: 'high' });
    expect(signals.city?.evidence).toBeTruthy();
  });

  it('returns empty signals for a message with no geography', () => {
    expect(extractLocation('有兼职吗')).toEqual({ city: null, district: [], location: [] });
  });
});

describe('extractLocation · "XX附近"前缀噪音（09-02 生产核对：3.8% 地点值是整句）', () => {
  it.each([
    ['我住在弘扬广场附近', '弘扬广场'],
    ['就在青龙湖公园附近', '青龙湖公园'],
    ['人在美的财富广场附近有岗吗', '美的财富广场'],
    ['地铁1号线附近有吗', '地铁1号线'],
  ])('%s → 只留地点本体 %s', (message, expected) => {
    const { location } = extractLocation(message);
    expect(location).toContain(expected);
    expect(location.some((item) => /我|住在|人在/u.test(item))).toBe(false);
  });

  it.each([
    '我在这附近',
    '是的这附近',
    '我家在这附近',
    '如果工作合适可以搬去工作地附近',
    '你在帮我看看有没有附近的',
    '的工作不是陈翔公路附近',
  ])('%s 不产地点', (message) => {
    expect(extractLocation(message).location).toEqual([]);
  });

  it('动作前缀归一仍然有效（"帮我找一下"不吃进地点）', () => {
    expect(extractLocation('帮我找一下弘扬广场附近的').location).toContain('弘扬广场');
  });
});
