import { HardConstraintsSection } from '@agent/generator/context/sections/hard-constraints.section';
import type { PromptContext } from '@agent/generator/context/sections/section.interface';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

describe('HardConstraintsSection', () => {
  const section = new HardConstraintsSection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  const cloneFallback = (): EntityExtractionResult => ({
    interview_info: { ...FALLBACK_EXTRACTION.interview_info },
    preferences: { ...FALLBACK_EXTRACTION.preferences },
    reasoning: '',
  });

  const highConfidenceValue = <T>(value: T, evidence: string): HighConfidenceValue<T> => ({
    value,
    confidence: 'high',
    source: 'rule',
    evidence,
  });

  const lowConfidenceValue = <T>(value: T, evidence: string): HighConfidenceValue<T> => ({
    value,
    confidence: 'low',
    source: 'system',
    evidence,
  });

  const cloneHighConfidenceFallback = (): HighConfidenceFacts => ({
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    },
    preferences: {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: '',
  });

  it('returns empty string when no facts available at all', () => {
    expect(section.build(baseCtx)).toBe('');
  });

  it('returns empty string when both fact buckets are present but contain only nulls', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: cloneFallback(),
      highConfidenceFacts: cloneHighConfidenceFallback(),
    });
    expect(output).toBe('');
  });

  it('renders city/district from session facts and tells the model which filter to use', () => {
    const facts = cloneFallback();
    facts.preferences.city = { value: '南京', confidence: 'high', evidence: 'explicit_city' };
    facts.preferences.district = ['秦淮区', '建邺区'];
    facts.preferences.location = ['新街口'];

    const output = section.build({ ...baseCtx, sessionFacts: facts });

    expect(output).toContain('[本轮查询硬约束]');
    expect(output).toContain(
      '- 城市: 南京（必填到 duliday_job_list.cityNameList；调用 invite_to_group 时也必须用这个城市级名称；若本轮需要对商圈/地标/街道调 geocode，也必须把该城市作为 geocode.city 传入，不要留空）',
    );
    expect(output).toContain(
      '- 区域: 秦淮区、建邺区（填到 duliday_job_list.regionNameList；严禁填到 invite_to_group.city）',
    );
    expect(output).toContain('位置/商圈/地标: 新街口');
    expect(output).toContain('必须先 geocode');
  });

  it('surfaces interview_info constraints (gender / age / health cert / education / student)', () => {
    const facts = cloneFallback();
    facts.interview_info.gender = '男';
    facts.interview_info.age = '25-40';
    facts.interview_info.has_health_certificate = '已办';
    facts.interview_info.education = '高中';
    facts.interview_info.is_student = false;

    const output = section.build({ ...baseCtx, sessionFacts: facts });

    expect(output).toContain('性别: 男');
    expect(output).toContain('年龄: 25-40');
    expect(output).toContain('健康证: 已办');
    expect(output).toContain('学历: 高中');
    expect(output).toContain('是否学生: 否');
  });

  it('renders is_student=true correctly (boolean false branch must not be skipped)', () => {
    const facts = cloneFallback();
    facts.interview_info.is_student = true;

    const output = section.build({ ...baseCtx, sessionFacts: facts });

    expect(output).toContain('是否学生: 是');
    expect(output).toContain('学生/在读/准研究生身份需谨慎处理');
    expect(output).toContain('figure=不限、学历够、未写学生限制都不能推断为身份没限制');
  });

  it('routes district-without-city through geocode tri-state instead of reverse-asking the candidate', () => {
    const facts = cloneFallback();
    facts.preferences.district = ['房山'];

    const output = section.build({ ...baseCtx, sessionFacts: facts });

    expect(output).toContain('区域: 房山');
    // 新策略：优先调 geocode 让工具判定（unique/ambiguous 三态），而非先反问候选人
    expect(output).toContain('优先把区/县名作为 address 传给 `geocode`');
    expect(output).toContain('unique/ambiguous 三态');
    expect(output).toContain('不要先反问候选人城市');
    expect(output).toContain('反问时不得带具体城市名');
  });

  it('falls back to highConfidenceFacts when sessionFacts has no value for a field', () => {
    const session = cloneFallback();
    const high = cloneHighConfidenceFallback();
    high.preferences.brands = highConfidenceValue(['必胜客'], '品牌别名识别：必胜客');
    high.preferences.schedule = highConfidenceValue('晚班', '班次识别：晚班');

    const output = section.build({
      ...baseCtx,
      sessionFacts: session,
      highConfidenceFacts: high,
    });

    expect(output).toContain('意向品牌: 必胜客');
    expect(output).toContain('班次/工时偏好: 晚班');
    expect(output).toContain('"每天/周一至周日"不等于"可只排周末"');
  });

  it('renders Boss title brand ids as brandIdList hints', () => {
    const session = cloneFallback();
    session.preferences.brand_ids = [10239];

    const output = section.build({ ...baseCtx, sessionFacts: session });

    expect(output).toContain('意向品牌ID: 10239');
    expect(output).toContain('来自 Boss 岗位标题 [brand_id]');
    expect(output).toContain('brandIdList');
  });

  it('prefers sessionFacts over highConfidenceFacts when both have a value (no merge conflict)', () => {
    const session = cloneFallback();
    session.preferences.salary = '5000+';
    const high = cloneHighConfidenceFallback();
    high.preferences.salary = highConfidenceValue('8000+', '薪资识别：8000+');

    const output = section.build({
      ...baseCtx,
      sessionFacts: session,
      highConfidenceFacts: high,
    });

    expect(output).toContain('意向薪资: 5000+');
    expect(output).not.toContain('意向薪资: 8000+');
  });

  it('does not consume low-confidence highConfidenceFacts as query constraints', () => {
    const high = cloneHighConfidenceFallback();
    high.interview_info.gender = lowConfidenceValue('女', '客户详情接口补充性别：女');
    high.preferences.city = lowConfidenceValue('上海', '低置信城市');

    const output = section.build({
      ...baseCtx,
      sessionFacts: cloneFallback(),
      highConfidenceFacts: high,
    });

    expect(output).toBe('');
  });

  it('drops empty string and empty array fields from interview_info during merge', () => {
    // Empty string for gender shouldn't render a "性别: " line.
    const session = cloneFallback();
    session.interview_info.gender = '   ';
    session.interview_info.age = ''; // empty
    session.interview_info.education = '本科'; // valid

    const output = section.build({ ...baseCtx, sessionFacts: session });

    expect(output).not.toContain('性别:');
    expect(output).not.toContain('年龄:');
    expect(output).toContain('学历: 本科');
  });

  it('renders Case 2 reproduction: gender + schedule together', () => {
    // Reproduces the production gap that motivated this section: manager said
    // "急需男生晚班打烊" but the model called duliday_job_list without filters.
    // After this section, both constraints are required to appear in the prompt.
    const facts = cloneFallback();
    facts.interview_info.gender = '男';
    facts.preferences.schedule = '晚班';

    const output = section.build({ ...baseCtx, sessionFacts: facts });

    expect(output).toContain('性别: 男');
    expect(output).toContain('班次/工时偏好: 晚班');
    expect(output).toContain('早开晚结全天时段');
    expect(output).toContain('调用 duliday_job_list');
  });
});
