import {
  extractHighConfidenceFacts,
  extractStructuredName,
  unwrapHighConfidenceValue,
} from '@memory/facts/high-confidence-facts';

describe('extractHighConfidenceFacts', () => {
  const brandData = [
    { name: '来伊份', aliases: ['来一份', '来1份'] },
    { name: '肯德基', aliases: ['KFC'] },
    { name: '瑞幸咖啡', aliases: ['瑞幸', 'luckin'] },
    { name: '报亭咖啡', aliases: ['报', '报亭'] },
  ];

  it('should normalize brand aliases from user messages', () => {
    const result = extractHighConfidenceFacts(['来一份'], brandData);

    expect(result?.preferences.brands).toEqual(
      expect.objectContaining({ value: ['来伊份'], confidence: 'high', source: 'rule' }),
    );
  });

  it('should not misclassify generic phrases as brands', () => {
    const result = extractHighConfidenceFacts(['给我来一份工作'], brandData);

    expect(result).toBeNull();
  });

  it('should match a distinctive brand embedded in a sentence (containment)', () => {
    // 旧的全等匹配会因为 "我要"/"兼职" 未被恰好剥离而漏掉品牌；
    // 长别称改为子串包含后，品牌嵌在句子里也能命中。
    const result = extractHighConfidenceFacts(['我要瑞幸咖啡兼职'], brandData);

    expect(unwrapHighConfidenceValue(result?.preferences.brands) ?? []).toContain('瑞幸咖啡');
  });

  it('should not let short generic aliases false-match common words (报名)', () => {
    // 报亭咖啡 的短别称 "报" 不可被 "报名" 命中。
    const result = extractHighConfidenceFacts(['我要报名面试'], brandData);

    expect(unwrapHighConfidenceValue(result?.preferences.brands) ?? []).not.toContain('报亭咖啡');
  });

  it('should expand a category word (咖啡) to related brands, not a position', () => {
    // 品类词"咖啡"指的是相关品牌，应展开为咖啡类品牌走品牌召回，而非提取为 position "咖啡师"。
    const result = extractHighConfidenceFacts(['我要咖啡兼职'], brandData);

    const brands = unwrapHighConfidenceValue(result?.preferences.brands) ?? [];
    expect(brands).toEqual(expect.arrayContaining(['瑞幸咖啡', '报亭咖啡']));
    // 规则层绝不能把品类词识别成具体岗位
    expect(unwrapHighConfidenceValue(result?.preferences.position) ?? []).not.toContain('咖啡师');
  });

  it('should prefer the specific brand over category expansion when one is named', () => {
    // 指名"瑞幸咖啡"时只取该品牌，不应再展开成整个咖啡品类。
    const result = extractHighConfidenceFacts(['我要瑞幸咖啡兼职'], brandData);

    const brands = unwrapHighConfidenceValue(result?.preferences.brands) ?? [];
    expect(brands).toEqual(['瑞幸咖啡']);
  });

  it('should not match conjunction chars as brand alias', () => {
    const brands = [{ name: '和府捞面', aliases: ['和'] }];
    const result = extractHighConfidenceFacts(['肯德基和星巴克'], brands);

    expect(unwrapHighConfidenceValue(result?.preferences.brands) ?? []).not.toContain('和府捞面');
  });

  it('should extract explicit high-confidence entities from one sentence', () => {
    const result = extractHighConfidenceFacts(
      ['上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空'],
      brandData,
    );

    expect(result?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      source: 'rule',
      evidence: 'municipality_compact',
    });
    expect(unwrapHighConfidenceValue(result?.preferences.district)).toEqual(['杨浦']);
    // 平台全为兼职岗位，"兼职"不作为 labor_form 提取（无筛选价值）。
    expect(result?.preferences.labor_form).toBeNull();
    expect(unwrapHighConfidenceValue(result?.preferences.position)).toEqual(['服务员']);
    expect(unwrapHighConfidenceValue(result?.preferences.schedule)).toBe('周末');
    expect(unwrapHighConfidenceValue(result?.interview_info.gender)).toBe('男');
    expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('25');
    expect(unwrapHighConfidenceValue(result?.interview_info.has_health_certificate)).toBe('有');
  });

  it('should extract resume upload URL when the file name looks like a resume', () => {
    const result = extractHighConfidenceFacts(
      [
        '[文件消息] 文件名：张三简历.pdf；文件地址：https://example.com/resume.pdf；文件大小：2KB\n简历附件：https://example.com/resume.pdf',
      ],
      brandData,
    );

    expect(unwrapHighConfidenceValue(result?.interview_info.upload_resume)).toBe(
      'https://example.com/resume.pdf',
    );
  });

  it('should not extract upload resume from unrelated PDF file names', () => {
    const result = extractHighConfidenceFacts(
      [
        '[文件消息] 文件名：入职材料.pdf；文件地址：https://example.com/onboarding.pdf；文件大小：2KB',
      ],
      brandData,
    );

    expect(unwrapHighConfidenceValue(result?.interview_info.upload_resume)).toBeNull();
  });

  it('should keep first scalar values across multiple messages', () => {
    const result = extractHighConfidenceFacts(
      [
        '我25岁，男的，本科，有健康证，想做小时工，工资5000-6000，周末有空，13800138000',
        '我18岁，女的，硕士，没有健康证，想做寒假工，工资7000-8000，早班，13900139000',
      ],
      brandData,
    );

    expect(unwrapHighConfidenceValue(result?.interview_info.phone)).toBe('13800138000');
    expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('25');
    expect(unwrapHighConfidenceValue(result?.interview_info.gender)).toBe('男');
    expect(unwrapHighConfidenceValue(result?.interview_info.education)).toBe('本科');
    expect(unwrapHighConfidenceValue(result?.interview_info.has_health_certificate)).toBe('有');
    expect(unwrapHighConfidenceValue(result?.preferences.labor_form)).toBe('小时工');
    expect(unwrapHighConfidenceValue(result?.preferences.salary)).toBe('工资5000-6000');
    expect(unwrapHighConfidenceValue(result?.preferences.schedule)).toBe('周末');
  });

  it('should not extract phone from longer numeric strings', () => {
    const result = extractHighConfidenceFacts(['订单号20261380013800123'], brandData);

    expect(result?.interview_info.phone ?? null).toBeNull();
  });

  it('should not extract age from job requirement wording', () => {
    const result = extractHighConfidenceFacts(['要求20-35岁'], brandData);

    expect(result?.interview_info.age ?? null).toBeNull();
  });

  it('should extract structured age even when message also contains requirement text', () => {
    const result = extractHighConfidenceFacts(['年龄：22，要求：18岁以上'], brandData);

    expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('22');
  });

  it('should extract structured age when the value is written without a separator', () => {
    const result = extractHighConfidenceFacts(
      ['姓名：张琰\n电话：19986247174\n年龄24\n明天吧\n有'],
      brandData,
    );

    expect(result?.interview_info.name).toEqual(expect.objectContaining({ value: '张琰' }));
    expect(result?.interview_info.phone).toEqual(expect.objectContaining({ value: '19986247174' }));
    expect(result?.interview_info.age).toEqual(
      expect.objectContaining({
        value: '24',
        confidence: 'high',
        source: 'rule',
        evidence: '年龄识别：24',
      }),
    );
  });

  it.each([
    ['年龄24', '24'],
    ['年龄 24', '24'],
    ['年龄：24', '24'],
    ['年龄:24', '24'],
    ['年龄 24岁', '24'],
    ['我24岁', '24'],
    ['今年24', '24'],
    ['岗位要求25-50岁，我24岁', '24'],
  ])('should extract candidate age from raw wording: %s', (raw, expectedAge) => {
    const result = extractHighConfidenceFacts([raw], brandData);

    expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe(expectedAge);
  });

  it('should not extract structured age from age range text without a separator', () => {
    const result = extractHighConfidenceFacts(['年龄25-50岁'], brandData);

    expect(result?.interview_info.age ?? null).toBeNull();
  });

  it('should extract candidate age when job requirement age appears in the same message', () => {
    const result = extractHighConfidenceFacts(['岗位要求25-50岁，我24岁'], brandData);

    expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('24');
  });

  it('should not extract salary from generic numeric ranges', () => {
    const result = extractHighConfidenceFacts(['编号100-200'], brandData);

    expect(result?.preferences.salary ?? null).toBeNull();
  });

  it('should extract schedule hard constraints beyond simple shift keywords', () => {
    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['每周最多也就能干两天'], brandData)?.preferences.schedule,
      ),
    ).toBe('每周最多两天');

    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['我只能做一休一'], brandData)?.preferences.schedule,
      ),
    ).toBe('做一休一');

    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['有没有不上夜班的'], brandData)?.preferences.schedule,
      ),
    ).toBe('夜班、不上夜班');

    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['我今天六点才能下班'], brandData)?.preferences.schedule,
      ),
    ).toBe('下班后');
  });

  describe('schedule_constraint (Phase 3.1 structured)', () => {
    it('extracts onlyWeekends from "只能周末上班"', () => {
      const constraint = extractHighConfidenceFacts(['我只能周末上班'], brandData)?.preferences
        .schedule_constraint;
      expect(unwrapHighConfidenceValue(constraint)?.onlyWeekends).toBe(true);
      expect(unwrapHighConfidenceValue(constraint)?.maxDaysPerWeek).toBeNull();
    });

    it('extracts onlyEvenings from "只做晚班"', () => {
      const constraint = extractHighConfidenceFacts(['我只做晚班'], brandData)?.preferences
        .schedule_constraint;
      expect(unwrapHighConfidenceValue(constraint)?.onlyEvenings).toBe(true);
    });

    it('extracts maxDaysPerWeek=1 from "做一休一"', () => {
      const constraint = extractHighConfidenceFacts(['我只能做一休一'], brandData)?.preferences
        .schedule_constraint;
      expect(unwrapHighConfidenceValue(constraint)?.maxDaysPerWeek).toBe(1);
    });

    it('extracts maxDaysPerWeek=2 from "每周最多两天"', () => {
      const constraint = extractHighConfidenceFacts(['每周最多也就能干两天'], brandData)
        ?.preferences.schedule_constraint;
      expect(unwrapHighConfidenceValue(constraint)?.maxDaysPerWeek).toBe(2);
    });

    it('extracts maxDaysPerWeek=2 from "做二休一"', () => {
      const constraint = extractHighConfidenceFacts(['可以做二休一'], brandData)?.preferences
        .schedule_constraint;
      expect(unwrapHighConfidenceValue(constraint)?.maxDaysPerWeek).toBe(2);
    });

    it('combines multiple constraints in one message', () => {
      const constraint = extractHighConfidenceFacts(['我只能周末做晚班，每周最多两天'], brandData)
        ?.preferences.schedule_constraint;
      expect(unwrapHighConfidenceValue(constraint)?.onlyWeekends).toBe(true);
      expect(unwrapHighConfidenceValue(constraint)?.onlyEvenings).toBe(true);
      expect(unwrapHighConfidenceValue(constraint)?.maxDaysPerWeek).toBe(2);
    });

    it('returns null when no constraint signal', () => {
      const constraint = extractHighConfidenceFacts(['你好我想看下兼职'], brandData)?.preferences
        .schedule_constraint;
      expect(constraint ?? null).toBeNull();
    });
  });

  describe('available_after (Phase 3.2 future date constraint)', () => {
    beforeAll(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-20T10:00:00+08:00'));
    });
    afterAll(() => {
      jest.useRealTimers();
    });

    it('extracts明确日期"5月1日之后" → next future date', () => {
      const aa = extractHighConfidenceFacts(['5月1日之后才能来面试'], brandData)?.preferences
        .available_after;
      expect(unwrapHighConfidenceValue(aa)?.date).toBe('2026-05-01');
      expect(unwrapHighConfidenceValue(aa)?.raw).toContain('5月1日');
    });

    it('extracts full date "2026-05-15 之后"', () => {
      const aa = extractHighConfidenceFacts(['2026-05-15之后再面试吧'], brandData)?.preferences
        .available_after;
      expect(unwrapHighConfidenceValue(aa)?.date).toBe('2026-05-15');
    });

    it('rolls over to next year when month-day already passed', () => {
      const aa = extractHighConfidenceFacts(['3月10日之后联系'], brandData)?.preferences
        .available_after;
      // 当前 2026-04-20，3月10日已过 → 2027-03-10
      expect(unwrapHighConfidenceValue(aa)?.date).toBe('2027-03-10');
    });

    it('does NOT extract fuzzy wording like "月底/等开学/下周再说"', () => {
      expect(
        extractHighConfidenceFacts(['等开学再说'], brandData)?.preferences.available_after,
      ).toBeUndefined();
      expect(
        extractHighConfidenceFacts(['月底再面试'], brandData)?.preferences.available_after,
      ).toBeUndefined();
    });
  });

  it('should distinguish health certificate type from missing certificate wording', () => {
    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['我有食品类健康证'], brandData)?.interview_info
          .has_health_certificate,
      ),
    ).toBe('有');
    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['健康证不是本地的'], brandData)?.interview_info
          .has_health_certificate,
      ),
    ).toBe('非本地健康证');
    expect(
      unwrapHighConfidenceValue(
        extractHighConfidenceFacts(['我没有食品健康证'], brandData)?.interview_info
          .has_health_certificate,
      ),
    ).toBe('无');
  });

  it('should treat admitted or enrolled graduate students as student identity', () => {
    const admitted = extractHighConfidenceFacts(
      ['我去年毕业了但是今年考上研究生了能行吗'],
      brandData,
    );
    expect(unwrapHighConfidenceValue(admitted?.interview_info.is_student)).toBe(true);
    expect(unwrapHighConfidenceValue(admitted?.interview_info.education)).toBe('硕士待入学');

    const undergrad = extractHighConfidenceFacts(['学历填本科在读有影响吗'], brandData);
    expect(unwrapHighConfidenceValue(undergrad?.interview_info.is_student)).toBe(true);
    expect(unwrapHighConfidenceValue(undergrad?.interview_info.education)).toBe('本科在读');
  });

  it('should not downgrade "本科在读" to "本科"', () => {
    const result = extractHighConfidenceFacts(['我是大三本科在读'], brandData);

    expect(unwrapHighConfidenceValue(result?.interview_info.education)).toBe('本科在读');
    expect(unwrapHighConfidenceValue(result?.interview_info.is_student)).toBe(true);
  });

  it.each([
    ['社会人士，目前待岗状态'],
    ['我是社会人士'],
    ['上班族，找个兼职'],
    ['我已经工作了'],
    ['之前工作过几年'],
    ['目前在职'],
    ['暂时待岗中'],
    ['失业了想找份兼职'],
    ['退休了想发挥余热'],
    ['全职妈妈，孩子上学后有空'],
    ['平时在家带娃'],
  ])('should mark non-student identity for message: %s', (message) => {
    const result = extractHighConfidenceFacts([message], brandData);
    expect(unwrapHighConfidenceValue(result?.interview_info.is_student)).toBe(false);
  });

  it('should extract specific labor_form subtypes only (小时工 / 寒假工 / 暑假工 / 兼职+)', () => {
    const hourly = extractHighConfidenceFacts(['我想做小时工'], brandData);
    expect(unwrapHighConfidenceValue(hourly?.preferences.labor_form)).toBe('小时工');

    const winter = extractHighConfidenceFacts(['寒假想找寒假工'], brandData);
    expect(unwrapHighConfidenceValue(winter?.preferences.labor_form)).toBe('寒假工');

    // "兼职"/"全职"/"临时工" 都不是合法的 labor_form 取值。
    // 单独一条 "我要找兼职" 没有任何可提取字段，整体返回 null。
    expect(extractHighConfidenceFacts(['我要找兼职'], brandData)).toBeNull();
    expect(extractHighConfidenceFacts(['我找全职'], brandData)).toBeNull();

    // 即便伴随其他信号（能触发非 null 结果），也不应把"兼职"写进 labor_form
    const combined = extractHighConfidenceFacts(['想找兼职服务员'], brandData);
    expect(unwrapHighConfidenceValue(combined?.preferences.position)).toEqual(['服务员']);
    expect(combined?.preferences.labor_form).toBeNull();
  });

  it('should extract city from whitelist district even when preceded by greetings or positional verbs', () => {
    // badcase: 候选人发"你好我在青浦区"，贪婪正则把整段当成区名归一化为
    // "你好我在青浦"，导致 DISTRICT_TO_CITY 永远查不到，city 留空，下游硬约束
    // 进入"当前没有已确认城市"分支，Agent 反复反问城市。修复后应正确识别青浦→上海。
    const greeted = extractHighConfidenceFacts(['你好我在青浦区'], brandData);
    expect(greeted?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      source: 'rule',
      evidence: 'unique_district_alias',
    });
    expect(unwrapHighConfidenceValue(greeted?.preferences.district)).toEqual(['青浦']);

    const positional = extractHighConfidenceFacts(['我在浦东区'], brandData);
    expect(unwrapHighConfidenceValue(positional?.preferences.city)).toBe('上海');
    expect(unwrapHighConfidenceValue(positional?.preferences.district)).toEqual(['浦东']);

    const lived = extractHighConfidenceFacts(['住在朝阳区'], brandData);
    expect(unwrapHighConfidenceValue(lived?.preferences.city)).toBe('北京');
    expect(unwrapHighConfidenceValue(lived?.preferences.district)).toEqual(['朝阳']);

    const nanjing = extractHighConfidenceFacts(['我在栖霞区'], brandData);
    expect(nanjing?.preferences.city).toEqual({
      value: '南京',
      confidence: 'high',
      source: 'rule',
      evidence: 'unique_district_alias',
    });
    expect(unwrapHighConfidenceValue(nanjing?.preferences.district)).toEqual(['栖霞']);

    const liuhe = extractHighConfidenceFacts(['六合区'], brandData);
    expect(unwrapHighConfidenceValue(liuhe?.preferences.city)).toBe('南京');
    expect(unwrapHighConfidenceValue(liuhe?.preferences.district)).toEqual(['六合']);
  });

  it('should resolve city from whitelist district even when message glues district + sub-town/street', () => {
    // badcase 2026-05-18 (msg id 23946)：候选人发"浦东新区航头镇"，贪婪正则把整段
    // 当一个 district 捕获，归一化"浦东新区航头"查不到白名单，city 留空，硬约束
    // 又把 Agent 卡进"当前没有已确认城市"循环反问。重构成白名单驱动扫描后，
    // "浦东新区"应优先于"浦东"被认领，剩余"航头镇"通过正则兜底但**不影响 city 识别**。
    const district_plus_town = extractHighConfidenceFacts(['浦东新区航头镇'], brandData);
    expect(district_plus_town?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      source: 'rule',
      evidence: 'unique_district_alias',
    });
    expect(unwrapHighConfidenceValue(district_plus_town?.preferences.district)).toContain(
      '浦东新区',
    );

    // 同模式的另一种表达：区 + 街道
    const district_plus_street = extractHighConfidenceFacts(['徐汇区漕河泾街道'], brandData);
    expect(unwrapHighConfidenceValue(district_plus_street?.preferences.city)).toBe('上海');
    expect(unwrapHighConfidenceValue(district_plus_street?.preferences.district)).toContain('徐汇');

    // 同模式的另一种城市：海淀 + 镇
    const beijing_district_plus_town = extractHighConfidenceFacts(['海淀区清河镇'], brandData);
    expect(unwrapHighConfidenceValue(beijing_district_plus_town?.preferences.city)).toBe('北京');
    expect(unwrapHighConfidenceValue(beijing_district_plus_town?.preferences.district)).toContain(
      '海淀',
    );
  });

  it('should prefer the longest whitelist district when multiple keys could prefix match', () => {
    // "浦东" 和 "浦东新区" 都在白名单里。扫描必须先认领"浦东新区"，避免被短 key 偷走。
    const result = extractHighConfidenceFacts(['浦东新区'], brandData);
    expect(unwrapHighConfidenceValue(result?.preferences.city)).toBe('上海');
    expect(unwrapHighConfidenceValue(result?.preferences.district)).toEqual(['浦东新区']);
  });

  it('should not extract education from location or school names', () => {
    const result = extractHighConfidenceFacts(
      ['[位置分享] 大宁国际学校小学部（上海市静安区江场路1428号） [经纬度:31.295946,121.453613]'],
      brandData,
    );

    expect(result?.interview_info.education ?? null).toBeNull();
    expect(result?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      source: 'rule',
      evidence: 'explicit_city',
    });
    expect(unwrapHighConfidenceValue(result?.preferences.district)).toEqual(['静安']);
    expect(unwrapHighConfidenceValue(result?.preferences.location)).toEqual([
      '大宁国际学校小学部',
      '上海市静安区江场路1428号',
    ]);
  });

  it.each(['大超市', '去夜市', '逛早市', '全市统一'])(
    'should not extract city from "%s"',
    (message) => {
      const result = extractHighConfidenceFacts([message], brandData);

      expect(result?.preferences.city ?? null).toBeNull();
    },
  );

  it.each([
    ['苏州市有岗位吗', '苏州'],
    ['昆山市有没有兼职', '昆山'],
    ['芒市有店吗', '芒市'],
  ])('should extract explicit national city name from "%s"', (message, city) => {
    const result = extractHighConfidenceFacts([message], brandData);

    expect(result?.preferences.city).toEqual({
      value: city,
      confidence: 'high',
      source: 'rule',
      evidence: 'explicit_city',
    });
  });

  describe('extractStructuredName', () => {
    it('should extract name from "姓名：XX" key-value pair', () => {
      expect(extractStructuredName('姓名：赵堤')).toBe('赵堤');
      expect(extractStructuredName('姓名:张三')).toBe('张三');
      expect(extractStructuredName('名字：李四')).toBe('李四');
      expect(extractStructuredName('姓名 王五')).toBe('王五');
    });

    it('should extract name from multi-line structured form', () => {
      const form = '姓名：赵堤\n联系电话：18800001111\n年龄：24';
      expect(extractStructuredName(form)).toBe('赵堤');
    });

    it('should reject names that fail isLikelyRealChineseName', () => {
      expect(extractStructuredName('姓名：执子之魂加油')).toBeNull(); // 6 字 → 超上限
      expect(extractStructuredName('姓名：test123')).toBeNull(); // 非 CJK
      expect(extractStructuredName('姓名：加油宝贝吖哦')).toBeNull(); // 6 字 → 超上限
    });

    it('should return null when no structured name key is present', () => {
      expect(extractStructuredName('我叫张三')).toBeNull();
      expect(extractStructuredName('我是李四')).toBeNull();
      expect(extractStructuredName('想找工作')).toBeNull();
    });

    it('should accept 5-char minority names', () => {
      expect(extractStructuredName('姓名：布买日也木')).toBe('布买日也木');
    });

    it('should reject 6+ char names', () => {
      expect(extractStructuredName('姓名：阿不力克木江')).toBeNull();
    });
  });

  it('should extract structured name via extractHighConfidenceFacts', () => {
    const result = extractHighConfidenceFacts(
      ['姓名：赵堤\n联系电话：18800001111\n年龄：24'],
      brandData,
    );
    expect(unwrapHighConfidenceValue(result?.interview_info.name)).toBe('赵堤');
    expect(unwrapHighConfidenceValue(result?.interview_info.phone)).toBe('18800001111');
    expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('24');
  });

  describe('extractStructuredName edge cases', () => {
    it('should NOT extract name from quoted block containing structured form', () => {
      // 引用块里的"姓名：XX"不是候选人填的，是经理发的模板
      // stripQuotedBlocks 剥离后剩余"好的我来填"，无可提取字段，整体返回 null
      const quoted = '[引用 李涵婷：姓名：王五\n联系电话：13800138000]\n好的我来填';
      const result = extractHighConfidenceFacts([quoted], brandData);
      expect(result).toBeNull();
    });

    it('should extract name from candidate reply after quoted block', () => {
      // 引用块被剥离后，候选人自己填的部分应该被提取
      const msg = '[引用 经理：请按模板填写]\n姓名：赵堤\n年龄：24';
      const result = extractHighConfidenceFacts([msg], brandData);
      expect(unwrapHighConfidenceValue(result?.interview_info.name)).toBe('赵堤');
      expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('24');
    });

    it('should take first name when multiple messages contain structured names', () => {
      const result = extractHighConfidenceFacts(
        ['姓名：张三\n年龄：25', '姓名：李四\n年龄：30'],
        brandData,
      );
      expect(unwrapHighConfidenceValue(result?.interview_info.name)).toBe('张三');
    });

    it('should extract name with space separator (姓名 XX)', () => {
      expect(extractStructuredName('姓名 赵堤')).toBe('赵堤');
    });

    it('should NOT extract single-char name from structured form', () => {
      // 单字不是合法姓名
      expect(extractStructuredName('姓名：赵')).toBeNull();
    });

    it('should NOT extract name when value is followed by comma on same line', () => {
      // 正则要求 value 延伸到行尾或字符串末尾，"姓名：张三，男"是单行混写，不符合结构化表单格式
      expect(extractStructuredName('姓名：张三，男')).toBeNull();
    });

    it('should extract name when value is on its own line even with trailing content below', () => {
      // 但如果"姓名：张三"独占一行，后面有其他行，应该提取
      expect(extractStructuredName('姓名：张三\n性别：男')).toBe('张三');
    });

    it('should handle time context suffix on structured form message', () => {
      // 短期记忆注入的时间后缀不应干扰结构化提取
      const msg = '姓名：赵堤\n年龄：24\n[消息发送时间：2026-04-23 14:26 周四]';
      const result = extractHighConfidenceFacts([msg], brandData);
      expect(unwrapHighConfidenceValue(result?.interview_info.name)).toBe('赵堤');
    });

    it('should coexist with auto-greeting in multi-message extraction', () => {
      // T1 打招呼"我是阳光明媚"，T5 填表"姓名：赵堤"
      // 规则层应提取"赵堤"，不受打招呼语干扰
      const result = extractHighConfidenceFacts(
        ['我是阳光明媚', '你好', '姓名：赵堤\n联系电话：18800001111'],
        brandData,
      );
      expect(unwrapHighConfidenceValue(result?.interview_info.name)).toBe('赵堤');
    });
  });

  describe('badcase 6a13c26f: quoted message stripping', () => {
    const badcaseMessages = [
      '都不太合适耶',
      '[引用 李涵婷：成都你六姐-莘庄龙之梦店 前厅服务员，3.1km 班次：11:30-14:30（午高峰短班，约3小时） 薪资：24元/时，满40小时26元/时，满80小时28元/时 要求：20-35岁，入职前办食品健康证]\n我36岁',
      '[引用 李涵婷：奥乐齐-1082鑫都 晚班补货，3.2km 班次：22:00-07:00（夜班） 薪资：5500-6500元/月（约30元/时） 要求：18-40岁]\n我白天9:00到下午三点有时间，上不就夜班',
    ];

    it('should extract age=36 from candidate text, not 35 from quoted job requirement', () => {
      const result = extractHighConfidenceFacts(badcaseMessages, brandData);
      expect(unwrapHighConfidenceValue(result?.interview_info.age)).toBe('36');
    });

    it('should NOT extract salary from quoted job descriptions', () => {
      const result = extractHighConfidenceFacts(badcaseMessages, brandData);
      expect(result?.preferences.salary).toBeNull();
    });

    it('should NOT extract position keywords from quoted job descriptions', () => {
      const result = extractHighConfidenceFacts(badcaseMessages, brandData);
      expect(result?.preferences.position).toBeNull();
    });

    it('should NOT extract shift schedule from quoted job descriptions', () => {
      const result = extractHighConfidenceFacts(badcaseMessages, brandData);
      // "不就夜班" from candidate's own text — should not match the shift keywords
      // from the quoted content like "晚班" "11:30-14:30" "夜班"
      const schedule = unwrapHighConfidenceValue(result?.preferences.schedule);
      if (schedule) {
        expect(schedule).not.toContain('11:30-14:30');
        expect(schedule).not.toContain('22:00-07:00');
      }
    });
  });
});
