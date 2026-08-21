import {
  SESSION_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionIdentityProvenanceCorpus,
  buildSessionExtractionPrompt,
} from '@memory/session-state/session-extraction.prompt';
import {
  FALLBACK_EXTRACTION,
  LLMEntityExtractionResultSchema,
  toSessionFacts,
} from '@memory/session-state/session-facts.types';

const emptyPreferences = () => ({
  brand_ids: null,
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
});

describe('session extraction prompt（表单外软事实 only）', () => {
  it('明确禁止身份与事务字段，并只列 preferences 输出面', () => {
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('只从候选人本轮表达中提取表单外软事实');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('禁止输出或推断姓名、手机号');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('禁止输出报名门店、报名岗位、面试时间');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('preferences');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('brand_intents');
    expect(SESSION_EXTRACTION_SYSTEM_PROMPT).toContain('labor_form_intent');
  });

  it('LLM schema 不再含 interview_info / explicit_provenance / 事务字段', () => {
    expect(LLMEntityExtractionResultSchema.shape).not.toHaveProperty('interview_info');
    expect(LLMEntityExtractionResultSchema.shape).not.toHaveProperty('explicit_provenance');
    expect(JSON.stringify(LLMEntityExtractionResultSchema)).not.toContain('applied_store');
    expect(JSON.stringify(LLMEntityExtractionResultSchema)).not.toContain('interview_time');

    const parsed = LLMEntityExtractionResultSchema.parse({
      interview_info: { name: '伪造姓名' },
      explicit_provenance: [{ field: 'name', quote: '伪造姓名' }],
      preferences: { ...emptyPreferences(), schedule: '晚班' },
      brand_intents: [],
      labor_form_intent: { intent: 'ignore', quote: '我只能晚班' },
      reasoning: '提取班次',
    });
    expect(parsed).not.toHaveProperty('interview_info');
    expect(parsed).not.toHaveProperty('explicit_provenance');
    expect(parsed.preferences.schedule).toBe('晚班');
  });

  it('已知事实只注入 preferences，不回灌表单身份', () => {
    const facts = toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '兮兮' },
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: { value: '上海', confidence: 'medium', evidence: 'explicit_city' },
        },
        reasoning: 'fixture',
      },
      { confidence: 'medium', source: 'archive', evidence: 'fixture' },
    );
    const prompt = buildSessionExtractionPrompt(
      [{ name: '肯德基', aliases: ['KFC'] }] as never,
      '用户: 我想找晚班',
      [],
      [],
      null,
      undefined,
      facts,
    );
    expect(prompt).toContain('[已有偏好]');
    expect(prompt).toContain('city');
    expect(prompt).not.toContain('兮兮');
    expect(prompt).not.toContain('[已确认事实');
  });

  it('品牌别名提示仍支持标准化', () => {
    const prompt = buildSessionExtractionPrompt(
      [{ name: '肯德基', aliases: ['KFC'] }] as never,
      '用户: KFC也可以',
      [],
      [{ sourceText: 'KFC', matchedAlias: 'KFC', brandName: '肯德基' }],
    );
    expect(prompt).toContain('肯德基（别称：KFC）');
    expect(prompt).toContain('「KFC」=>「肯德基」');
  });

  it('legacy provenance corpus 导出只拼对话，不拼历史身份事实', () => {
    const corpus = buildExtractionIdentityProvenanceCorpus(
      '用户: 当前消息',
      ['用户: 历史消息'],
      null,
    );
    expect(corpus).toBe('用户: 历史消息\n用户: 当前消息');
  });
});
