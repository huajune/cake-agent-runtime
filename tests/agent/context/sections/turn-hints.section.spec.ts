import { PromptContext } from '@agent/context/sections/section.interface';
import { TurnHintsSection } from '@agent/context/sections/turn-hints.section';
import {
  FALLBACK_EXTRACTION,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

function highConfidence<T>(value: T, evidence: string): HighConfidenceValue<T> {
  return { value, confidence: 'high', source: 'rule', evidence };
}

function lowSystem<T>(value: T, evidence: string): HighConfidenceValue<T> {
  return { value, confidence: 'low', source: 'system', evidence };
}

function emptyHighConfidenceFacts(): HighConfidenceFacts {
  return {
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
  };
}

describe('TurnHintsSection', () => {
  const section = new TurnHintsSection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should return empty string when no high-confidence facts', () => {
    expect(section.build(baseCtx)).toBe('');
  });

  it('should render high-confidence facts as a single runtime hints block when no session facts exist', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        preferences: {
          ...emptyHighConfidenceFacts().preferences,
          brands: highConfidence(['来伊份'], '品牌别名识别：来伊份'),
        },
        reasoning: '品牌别名识别',
      },
    });

    expect(output).toContain('[本轮高置信线索]');
    expect(output).toContain('意向品牌: 来伊份');
    expect(output).not.toContain('[本轮待确认线索]');
  });

  it('should render city confidence and evidence inline in high-confidence hints block', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        preferences: {
          ...emptyHighConfidenceFacts().preferences,
          city: highConfidence('上海', 'unique_district_alias'),
        },
        reasoning: '区映射识别',
      },
    });

    expect(output).toContain('[本轮高置信线索]');
    expect(output).toContain('意向城市: 上海（置信度: high，来源: rule，证据: unique_district_alias）');
  });

  it('should render low-confidence facts to LLM with labels instead of filtering them out', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        interview_info: {
          ...emptyHighConfidenceFacts().interview_info,
          gender: lowSystem('女', '客户详情接口补充性别：女'),
          gender_source: lowSystem('system', '客户详情接口补充性别来源：系统标签'),
        },
        reasoning: '客户详情接口补充性别：女',
      },
    });

    expect(output).toContain('[本轮高置信线索]');
    expect(output).toContain(
      '性别: 女（系统标签，未经候选人自陈，不得用于直接排除候选人）（置信度: low，来源: system，证据: 客户详情接口补充性别：女）',
    );
  });

  it('should move conflicting fields into pending confirmation hints and keep new fields in normal hints', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, city: { value: '上海', confidence: 'high', evidence: 'explicit_city' } },
      },
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        preferences: {
          ...emptyHighConfidenceFacts().preferences,
          brands: highConfidence(['来伊份'], '品牌别名识别：来伊份'),
          city: highConfidence('北京', 'explicit_city'),
        },
        reasoning: '品牌别名识别，城市识别',
      },
    });

    expect(output).toContain('[本轮高置信线索]');
    expect(output).toContain('[本轮待确认线索]');
    expect(output).toContain('意向品牌: 来伊份');
    expect(output).toContain('意向城市: 北京');

    const highConfidenceIndex = output.indexOf('[本轮高置信线索]');
    const pendingIndex = output.indexOf('[本轮待确认线索]');
    const cityIndex = output.indexOf('意向城市: 北京');
    expect(pendingIndex).toBeGreaterThan(highConfidenceIndex);
    expect(cityIndex).toBeGreaterThan(pendingIndex);
  });

  it('should still render current-turn facts when they match session facts', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, city: { value: '上海', confidence: 'high', evidence: 'explicit_city' } },
      },
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        preferences: {
          ...emptyHighConfidenceFacts().preferences,
          city: highConfidence('上海', 'explicit_city'),
        },
        reasoning: '同值',
      },
    });

    expect(output).toContain('[本轮高置信线索]');
    expect(output).toContain('意向城市: 上海（置信度: high，来源: rule，证据: explicit_city）');
    expect(output).not.toContain('[本轮待确认线索]');
  });
});
