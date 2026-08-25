import { HardConstraintsSection } from '@agent/generator/context/sections/hard-constraints.section';
import type { PromptContext } from '@agent/generator/context/sections/section.interface';
import { cityFixture, sessionFactsOf } from '../../../../helpers/session-facts.fixture';
import { testTurnHint, testTurnHints } from '../../../../helpers/turn-hints.fixture';

describe('HardConstraintsSection', () => {
  const section = new HardConstraintsSection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('returns empty string when no facts available at all', () => {
    expect(section.build(baseCtx)).toBe('');
  });

  it('returns empty string when both fact buckets are present but contain only nulls', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(),
      turnHints: testTurnHints(),
    });
    expect(output).toBe('');
  });

  it('renders an explicit current labor-form intent even when persisted facts are unavailable', () => {
    const output = section.build({
      ...baseCtx,
      currentLaborFormIntent: { kind: 'set', value: '暑假工' },
    });

    expect(output).toContain('用工形式: 暑假工');
    expect(output).toContain('只保留匹配「暑假工」的岗位');
    expect(output).toContain('暑假工无岗时直接拒绝并结束本轮');
    expect(output).toContain('禁止追加问题、替代岗位');
  });

  it('renders city/district from session facts and tells the model which filter to use', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({
        preferences: {
          city: cityFixture('南京'),
          district: ['秦淮区', '建邺区'],
          location: ['新街口'],
        },
      }),
    });

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

  // 议题 1-1 的负向用例：置信度门此前从未被任何测试执行过（裸态 fixture 绕开了它）。
  // 去掉 mergeFacts 的 minConfidence:'high' 后本用例必失败。
  it('drops a medium-confidence city from the hard-constraint block (置信度门必须真的在工作)', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({
        preferences: { city: cityFixture('南京', 'medium'), schedule: '晚班' },
      }),
    });

    // 同一份 facts 里的 high 字段照常渲染，证明不是整块被丢掉
    expect(output).toContain('班次/工时偏好: 晚班');
    expect(output).not.toContain('城市: 南京');
  });

  it('keeps a high-confidence city in the hard-constraint block', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { city: cityFixture('南京', 'high') } }),
    });

    expect(output).toContain('城市: 南京');
  });

  it('drops medium-confidence non-city fields as well (整份信封走同一道门)', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(
        { preferences: { salary: '8000+' }, interview_info: { age: '25' } },
        { confidence: 'medium' },
      ),
    });

    expect(output).toBe('');
  });

  it('surfaces interview_info constraints (gender / age / health cert / education / student)', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({
        interview_info: {
          gender: '男',
          age: '25-40',
          has_health_certificate: '已办',
          education: '高中',
          is_student: false,
        },
      }),
    });

    expect(output).toContain('性别: 男');
    expect(output).toContain('年龄: 25-40');
    expect(output).toContain('健康证: 已办');
    expect(output).toContain('学历: 高中');
    expect(output).toContain('是否学生: 否');
  });

  it('renders is_student=true correctly (boolean false branch must not be skipped)', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ interview_info: { is_student: true } }),
    });

    expect(output).toContain('是否学生: 是');
    expect(output).toContain('学生能否安排只看岗位数据');
    expect(output).toContain('未写学生限制或未返回学生筛选项时按没有额外学生硬限制');
    expect(output).toContain('不得凭空增加门店确认或人工介入');
    expect(output).toContain('约面阶段仍必须保持 candidateIsStudent=true 调 precheck');
  });

  it('routes district-without-city through geocode tri-state instead of reverse-asking the candidate', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { district: ['房山'] } }),
    });

    expect(output).toContain('区域: 房山');
    // 新策略：优先调 geocode 让工具判定（unique/ambiguous 三态），而非先反问候选人
    expect(output).toContain('优先把区/县名作为 address 传给 `geocode`');
    expect(output).toContain('unique/ambiguous 三态');
    expect(output).toContain('不要先反问候选人城市');
    expect(output).toContain('反问时不得带具体城市名');
  });

  it('falls back to turnHints when sessionFacts has no value for a field', () => {
    const high = testTurnHints(testTurnHint('preferences.schedule', '晚班', '班次识别：晚班'));

    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(),
      turnHints: high,
    });

    expect(output).toContain('班次/工时偏好: 晚班');
    expect(output).toContain('"每天/周一至周日"不等于"可只排周末"');
  });

  it('明确做一休一不满足每周最多一至两天，避免低周频语义串线', () => {
    const high = testTurnHints(
      testTurnHint('preferences.schedule', '每周最多两天', '班次识别：每周最多两天'),
    );

    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(),
      turnHints: high,
    });

    expect(output).toContain('"做一休一"通常每周出勤 3–4 天');
    expect(output).toContain('不满足"每周最多 1–2 天"');
    expect(output).toContain('不得把它列为低周频候选人的合适方案');
  });

  it('品牌口径改读 SessionBrandState：currentBrand + excludedBrands（§14.4/goal #10）', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(),
      sessionBrandState: {
        currentBrand: { canonicalName: '必胜客', brandId: 10239 },
        excludedBrands: [{ canonicalName: '肯德基', brandId: 10001 }],
      },
    });

    expect(output).toContain('当前意向品牌: 必胜客');
    expect(output).toContain("brandFilterMode='clear'");
    expect(output).toContain('排斥品牌: 肯德基');
    expect(output).toContain('不要主动推荐其岗位');
  });

  it('空品牌状态不产出品牌行（不再读 preferences.brands 投影）', () => {
    const high = testTurnHints(testTurnHint('preferences.schedule', '晚班', '班次识别：晚班'));

    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(),
      turnHints: high,
      sessionBrandState: { currentBrand: null, excludedBrands: [] },
    });

    expect(output).not.toContain('当前意向品牌');
    expect(output).not.toContain('排斥品牌');
  });

  it('renders Boss title brand ids as brandIdList hints', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { brand_ids: [10239] } }),
    });

    expect(output).toContain('意向品牌ID: 10239');
    expect(output).toContain('来自 Boss 岗位标题 [brand_id]');
    expect(output).toContain('brandIdList');
  });

  it('本轮高置信值覆盖旧 session 值（Phase 0 第 2 条：与工具层合并口径统一）', () => {
    // 候选人上轮说 5000+、本轮改口 8000+：硬约束段必须跟随最新表达——
    // 工具层 mergeSessionFactsWithHighConfidence 一直如此，prompt 层此前相反
    // （旧值压新值，候选人刚改口的条件在硬约束段被无视）。
    const high = testTurnHints(testTurnHint('preferences.salary', '8000+', '薪资识别：8000+'));

    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { salary: '5000+' } }),
      turnHints: high,
    });

    expect(output).toContain('意向薪资: 8000+');
    expect(output).not.toContain('意向薪资: 5000+');
  });

  it('本轮无该字段线索时沿用 session 值（覆盖仅发生在本轮确有新值）', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { salary: '5000+' } }),
      turnHints: testTurnHints(),
    });

    expect(output).toContain('意向薪资: 5000+');
  });

  it('prefers the current explicit labor form over stale session labor form', () => {
    const high = testTurnHints(
      testTurnHint('preferences.labor_form', '暑假工', '用工形式识别：暑假工'),
    );

    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { labor_form: '兼职' } }),
      turnHints: high,
    });

    expect(output).toContain('用工形式: 暑假工');
    expect(output).toContain('只保留匹配「暑假工」的岗位');
    expect(output).not.toContain('用工形式: 兼职');
  });

  it('does not fall back to stale summer labor form after the candidate explicitly excludes it', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { labor_form: '暑假工' } }),
      currentLaborFormIntent: { kind: 'clear', clearedValues: ['暑假工'] },
    });

    expect(output).not.toContain('用工形式: 暑假工');
  });

  it('keeps the existing summer labor form when the candidate only asks about a job type', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { labor_form: '暑假工' } }),
      currentLaborFormIntent: { kind: 'ignore' },
    });

    expect(output).toContain('用工形式: 暑假工');
  });

  it('does not consume low-confidence turnHints as query constraints', () => {
    const high = testTurnHints(
      testTurnHint('interview_info.gender', '女', '客户详情接口补充性别：女', {
        confidence: 'low',
        producer: 'system',
      }),
      testTurnHint('preferences.city', '上海', '低置信城市', {
        confidence: 'low',
        producer: 'system',
      }),
    );

    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf(),
      turnHints: high,
    });

    expect(output).toBe('');
  });

  it('drops empty string and empty array fields from interview_info during merge', () => {
    // Empty string for gender shouldn't render a "性别: " line.
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({
        interview_info: { gender: '   ', age: '', education: '本科' },
      }),
    });

    expect(output).not.toContain('性别:');
    expect(output).not.toContain('年龄:');
    expect(output).toContain('学历: 本科');
  });

  it('renders Case 2 reproduction: gender + schedule together', () => {
    // Reproduces the production gap that motivated this section: manager said
    // "急需男生晚班打烊" but the model called duliday_job_list without filters.
    // After this section, both constraints are required to appear in the prompt.
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({
        interview_info: { gender: '男' },
        preferences: { schedule: '晚班' },
      }),
    });

    expect(output).toContain('性别: 男');
    expect(output).toContain('班次/工时偏好: 晚班');
    expect(output).toContain('早开晚结全天时段');
    expect(output).toContain('调用 duliday_job_list');
  });
});
