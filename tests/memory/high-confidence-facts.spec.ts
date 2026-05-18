import { extractHighConfidenceFacts } from '@memory/facts/high-confidence-facts';

describe('extractHighConfidenceFacts', () => {
  const brandData = [
    { name: '来伊份', aliases: ['来一份', '来1份'] },
    { name: '肯德基', aliases: ['KFC'] },
  ];

  it('should normalize brand aliases from user messages', () => {
    const result = extractHighConfidenceFacts(['来一份'], brandData);

    expect(result?.preferences.brands).toEqual(['来伊份']);
  });

  it('should not misclassify generic phrases as brands', () => {
    const result = extractHighConfidenceFacts(['给我来一份工作'], brandData);

    expect(result).toBeNull();
  });

  it('should extract explicit high-confidence entities from one sentence', () => {
    const result = extractHighConfidenceFacts(
      ['上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空'],
      brandData,
    );

    expect(result?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      evidence: 'municipality_compact',
    });
    expect(result?.preferences.district).toEqual(['杨浦']);
    // 平台全为兼职岗位，"兼职"不作为 labor_form 提取（无筛选价值）。
    expect(result?.preferences.labor_form).toBeNull();
    expect(result?.preferences.position).toEqual(['服务员']);
    expect(result?.preferences.schedule).toBe('周末');
    expect(result?.interview_info.gender).toBe('男');
    expect(result?.interview_info.age).toBe('25');
    expect(result?.interview_info.has_health_certificate).toBe('有');
  });

  it('should extract schedule hard constraints beyond simple shift keywords', () => {
    expect(
      extractHighConfidenceFacts(['每周最多也就能干两天'], brandData)?.preferences.schedule,
    ).toBe('每周最多两天');

    expect(extractHighConfidenceFacts(['我只能做一休一'], brandData)?.preferences.schedule).toBe(
      '做一休一',
    );

    expect(extractHighConfidenceFacts(['有没有不上夜班的'], brandData)?.preferences.schedule).toBe(
      '夜班、不上夜班',
    );

    expect(
      extractHighConfidenceFacts(['我今天六点才能下班'], brandData)?.preferences.schedule,
    ).toBe('下班后');
  });

  it('should distinguish health certificate type from missing certificate wording', () => {
    expect(
      extractHighConfidenceFacts(['我有食品类健康证'], brandData)?.interview_info
        .has_health_certificate,
    ).toBe('有');
    expect(
      extractHighConfidenceFacts(['健康证不是本地的'], brandData)?.interview_info
        .has_health_certificate,
    ).toBe('非本地健康证');
    expect(
      extractHighConfidenceFacts(['我没有食品健康证'], brandData)?.interview_info
        .has_health_certificate,
    ).toBe('无');
  });

  it('should treat admitted or enrolled graduate students as student identity', () => {
    const admitted = extractHighConfidenceFacts(
      ['我去年毕业了但是今年考上研究生了能行吗'],
      brandData,
    );
    expect(admitted?.interview_info.is_student).toBe(true);
    expect(admitted?.interview_info.education).toBe('硕士待入学');

    const undergrad = extractHighConfidenceFacts(['学历填本科在读有影响吗'], brandData);
    expect(undergrad?.interview_info.is_student).toBe(true);
    expect(undergrad?.interview_info.education).toBe('本科在读');
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
    expect(result?.interview_info.is_student).toBe(false);
  });

  it('should extract specific labor_form subtypes only (小时工 / 寒假工 / 暑假工 / 兼职+)', () => {
    const hourly = extractHighConfidenceFacts(['我想做小时工'], brandData);
    expect(hourly?.preferences.labor_form).toBe('小时工');

    const winter = extractHighConfidenceFacts(['寒假想找寒假工'], brandData);
    expect(winter?.preferences.labor_form).toBe('寒假工');

    // "兼职"/"全职"/"临时工" 都不是合法的 labor_form 取值。
    // 单独一条 "我要找兼职" 没有任何可提取字段，整体返回 null。
    expect(extractHighConfidenceFacts(['我要找兼职'], brandData)).toBeNull();
    expect(extractHighConfidenceFacts(['我找全职'], brandData)).toBeNull();

    // 即便伴随其他信号（能触发非 null 结果），也不应把"兼职"写进 labor_form
    const combined = extractHighConfidenceFacts(['想找兼职服务员'], brandData);
    expect(combined?.preferences.position).toEqual(['服务员']);
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
      evidence: 'unique_district_alias',
    });
    expect(greeted?.preferences.district).toEqual(['青浦']);

    const positional = extractHighConfidenceFacts(['我在浦东区'], brandData);
    expect(positional?.preferences.city?.value).toBe('上海');
    expect(positional?.preferences.district).toEqual(['浦东']);

    const lived = extractHighConfidenceFacts(['住在朝阳区'], brandData);
    expect(lived?.preferences.city?.value).toBe('北京');
    expect(lived?.preferences.district).toEqual(['朝阳']);
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
      evidence: 'unique_district_alias',
    });
    expect(district_plus_town?.preferences.district).toContain('浦东新区');

    // 同模式的另一种表达：区 + 街道
    const district_plus_street = extractHighConfidenceFacts(['徐汇区漕河泾街道'], brandData);
    expect(district_plus_street?.preferences.city?.value).toBe('上海');
    expect(district_plus_street?.preferences.district).toContain('徐汇');

    // 同模式的另一种城市：海淀 + 镇
    const beijing_district_plus_town = extractHighConfidenceFacts(['海淀区清河镇'], brandData);
    expect(beijing_district_plus_town?.preferences.city?.value).toBe('北京');
    expect(beijing_district_plus_town?.preferences.district).toContain('海淀');
  });

  it('should prefer the longest whitelist district when multiple keys could prefix match', () => {
    // "浦东" 和 "浦东新区" 都在白名单里。扫描必须先认领"浦东新区"，避免被短 key 偷走。
    const result = extractHighConfidenceFacts(['浦东新区'], brandData);
    expect(result?.preferences.city?.value).toBe('上海');
    expect(result?.preferences.district).toEqual(['浦东新区']);
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
      evidence: 'explicit_city',
    });
    expect(result?.preferences.district).toEqual(['静安']);
    expect(result?.preferences.location).toEqual([
      '大宁国际学校小学部',
      '上海市静安区江场路1428号',
    ]);
  });
});
