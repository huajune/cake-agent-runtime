import {
  extractResumeFieldsFallback,
  notarizeResumeFields,
  type ResumeRawField,
} from '@resolution/candidate/resume-fields';

const raw = (
  field: ResumeRawField['field'],
  value: string,
  sourceText: string,
): ResumeRawField => ({ field, value, sourceText });

describe('notarizeResumeFields', () => {
  it('grants high only to strict label-anchored evidence', () => {
    const text = '姓名：兮兮\n求职意向：咖啡师';
    const result = notarizeResumeFields(
      [raw('name', '兮兮', '姓名：兮兮'), raw('jobIntent', '咖啡师', '求职意向：咖啡师')],
      text,
    );

    expect(result.name).toMatchObject({ value: '兮兮', confidence: 'high' });
    expect(result.jobIntent).toMatchObject({ value: '咖啡师', confidence: 'high' });
  });

  it('grants medium to free-position evidence and caps all vision fields at medium', () => {
    const text = '兮兮\n姓名：兮兮';
    expect(notarizeResumeFields([raw('name', '兮兮', '兮兮')], text).name?.confidence).toBe(
      'medium',
    );
    expect(
      notarizeResumeFields([raw('name', '兮兮', '姓名：兮兮')], text, {
        sourceKind: 'vision_transcription',
      }).name?.confidence,
    ).toBe('medium');
  });

  it('accepts a unique deterministic re-anchor and marks it rule_fallback/medium', () => {
    const text = '基本信息\n姓名：兮兮\n学历：本科';
    const result = notarizeResumeFields([raw('name', '兮兮', '姓名 兮兮')], text);

    expect(result.name).toEqual({
      value: '兮兮',
      sourceText: '姓名：兮兮',
      extractedBy: 'rule_fallback',
      confidence: 'medium',
    });
    expect(result.notaryDrops).toEqual([]);
  });

  it.each([
    ['zero anchor', '姓名：占位值', '兮兮'],
    ['multiple anchors', '姓名：兮兮\n兮兮有餐饮经验', '兮兮'],
  ])('rejects %s when model quote is absent', (_label, text, value) => {
    const result = notarizeResumeFields([raw('name', value, '模型改写的引文')], text);
    expect(result.name).toBeUndefined();
    expect(result.notaryDrops).toContainEqual({ field: 'name', reason: 'quote_not_found' });
  });

  it('rejects a value that cannot be deterministically derived from an exact quote', () => {
    const text = '姓名：兮兮';
    const result = notarizeResumeFields([raw('name', '编造姓名', text)], text);
    expect(result.name).toBeUndefined();
    expect(result.notaryDrops).toContainEqual({ field: 'name', reason: 'shape_invalid' });
  });

  it('rejects overlong whole-document quotes before they can make lookup vacuous', () => {
    const text = `姓名：兮兮\n${'工作经历内容'.repeat(30)}`;
    const result = notarizeResumeFields([raw('name', '兮兮', text)], text);
    expect(result.name?.sourceText).toBe('姓名：兮兮');
    expect(result.name?.extractedBy).toBe('rule_fallback');
  });

  it('drops placeholder phones and excludes third-party phone ownership', () => {
    const text = '手机：13800138000\nHR电话：18271421691\n本人电话：18271421690';
    const result = notarizeResumeFields(
      [
        raw('phone', '13800138000', '手机：13800138000'),
        raw('phone', '18271421691', 'HR电话：18271421691'),
        raw('phone', '18271421690', '本人电话：18271421690'),
      ],
      text,
    );

    expect(result.phone).toMatchObject({ value: '18271421690', confidence: 'medium' });
    expect(result.phoneCandidates).toEqual(['18271421690']);
    expect(result.notaryDrops).toContainEqual({ field: 'phone', reason: 'placeholder' });
    expect(result.notaryDrops).toContainEqual({ field: 'phone', reason: 'shape_invalid' });
  });

  it('lists all candidate-owned phones while keeping the selected phone medium', () => {
    const text = '手机：18271421690\n备用电话：18271421692';
    const result = notarizeResumeFields([raw('phone', '18271421690', '手机：18271421690')], text);
    expect(result.phoneCandidates).toEqual(['18271421690', '18271421692']);
    expect(result.phone?.confidence).toBe('medium');
  });

  it('normalizes equivalent education values through the shared education ids', () => {
    const text = '最高学历：专科';
    const result = notarizeResumeFields([raw('education', '大专', text)], text);
    expect(result.education).toMatchObject({ value: '大专', confidence: 'high' });
  });

  it('validates age, gender, email and caps relevant experience at 120 chars', () => {
    const experience = '门店服务'.repeat(25);
    const text = `女 | 24岁\n邮箱：xixi@example.test\n工作经历：${experience}`;
    const result = notarizeResumeFields(
      [
        raw('gender', '女', '女 | 24岁'),
        raw('age', '24', '女 | 24岁'),
        raw('email', 'xixi@example.test', '邮箱：xixi@example.test'),
        raw('relevantExperience', experience, `工作经历：${experience}`),
      ],
      text,
    );

    expect(result.gender?.confidence).toBe('high');
    expect(result.age?.confidence).toBe('high');
    expect(result.email?.value).toBe('xixi@example.test');
    expect(result.relevantExperience?.value.length).toBeLessThanOrEqual(120);
  });

  it('uses a strict sanitized filename as independent high-confidence name evidence', () => {
    const result = notarizeResumeFields([], '教育经历\n测试大学本科', {
      fileName: encodeURIComponent('兮兮求职简历.pdf'),
    });
    expect(result.name).toEqual({
      value: '兮兮',
      sourceText: '兮兮求职简历.pdf',
      extractedBy: 'filename',
      confidence: 'high',
    });
  });
});

describe('extractResumeFieldsFallback', () => {
  it('extracts label fields, all phones and the highest education', () => {
    const text = [
      '姓名：兮兮',
      '女 | 24岁',
      '手机：18271421690',
      '教育经历：测试职业学院大专，后取得本科',
      '期望城市：上海',
      '求职意向：咖啡师',
      '期望薪资：6000-7000元',
      '工作年限：3年',
      '相关经历：测试咖啡店负责饮品制作',
    ].join('\n');
    const candidates = extractResumeFieldsFallback(text, '兮兮简历.pdf');
    const result = notarizeResumeFields(candidates, text, { fileName: '兮兮简历.pdf' });

    expect(result.name?.value).toBe('兮兮');
    expect(result.phone?.value).toBe('18271421690');
    expect(result.education?.value).toBe('本科');
    expect(result.expectedCity?.value).toBe('上海');
    expect(result.jobIntent?.value).toBe('咖啡师');
    expect(result.expectedSalary?.value).toBe('6000-7000元');
    expect(result.workYears?.value).toBe('3年');
    expect(result.relevantExperience?.value).toBe('测试咖啡店负责饮品制作');
  });

  it('falls back to a unique strict name near a phone/age anchor', () => {
    const text = '个人信息\n兮兮\n18271421690\n24岁\n餐饮经历';
    const result = notarizeResumeFields(extractResumeFieldsFallback(text), text);
    expect(result.name).toMatchObject({ value: '兮兮', confidence: 'medium' });
  });

  it('does not guess a neighbor name when multiple candidates exist', () => {
    const text = '兮兮甲\n18271421690\n24岁\n兮兮';
    const result = notarizeResumeFields(extractResumeFieldsFallback(text), text);
    expect(result.name).toBeUndefined();
  });
});
