import { PromptContext } from '@agent/generator/context/sections/section.interface';
import { TurnHintsSection } from '@agent/generator/context/sections/turn-hints.section';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';
import { testRuleFact, testRuleFacts } from '../../../../helpers/rule-fact-claims.fixture';

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
      // brands 已随 preferences.brands 退役不再进 turn hints（§19.6），用 district 验证同一数组渲染路径
      ruleFacts: testRuleFacts(
        testRuleFact('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
      ),
    });

    expect(output).toContain('[本轮系统疑似识别]');
    expect(output).toContain('意向区域: 杨浦区');
    expect(output).toContain('严禁向候选人复述或提及“系统识别/系统提示”字样');
    expect(output).not.toContain('[本轮待确认线索]');
  });

  it('should render city confidence and evidence inline in high-confidence hints block', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      ruleFacts: testRuleFacts(
        testRuleFact('preferences.city', '上海', 'unique_district_alias'),
      ),
    });

    expect(output).toContain('[本轮系统疑似识别]');
    expect(output).toContain('意向城市: 上海（置信度: high，来源: rule，证据: unique_district_alias）');
  });

  it('should render low-confidence facts to LLM with labels instead of filtering them out', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      ruleFacts: testRuleFacts(
        testRuleFact('interview_info.gender', '女', '客户详情接口补充性别：女', {
          confidence: 'low',
          producer: 'system',
        }),
        testRuleFact(
          'interview_info.gender_source',
          'system',
          '客户详情接口补充性别来源：系统标签',
          { confidence: 'low', producer: 'system' },
        ),
      ),
    });

    expect(output).toContain('[本轮系统疑似识别]');
    expect(output).toContain(
      '性别: 女（系统标签，未经候选人自陈，不得用于直接排除候选人）（置信度: low，来源: system，证据: 客户详情接口补充性别：女）',
    );
  });

  it('should move conflicting fields into pending confirmation hints and keep new fields in normal hints', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
        },
      },
      ruleFacts: testRuleFacts(
        testRuleFact('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
        testRuleFact('preferences.city', '北京', 'explicit_city'),
      ),
    });

    expect(output).toContain('[本轮系统疑似识别]');
    expect(output).toContain('[本轮待确认线索]');
    expect(output).toContain('意向区域: 杨浦区');
    expect(output).toContain('意向城市: 北京');

    const highConfidenceIndex = output.indexOf('[本轮系统疑似识别]');
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
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
        },
      },
      ruleFacts: testRuleFacts(
        testRuleFact('preferences.city', '上海', 'explicit_city'),
      ),
    });

    expect(output).toContain('[本轮系统疑似识别]');
    expect(output).toContain('意向城市: 上海（置信度: high，来源: rule，证据: explicit_city）');
    expect(output).not.toContain('[本轮待确认线索]');
  });

  it('treats a current labor-form change as the active intent instead of pending confirmation', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          labor_form: '兼职',
        },
      },
      ruleFacts: testRuleFacts(
        testRuleFact('preferences.labor_form', '暑假工', '用工形式识别：暑假工'),
      ),
    });

    expect(output).toContain('[本轮系统疑似识别]');
    expect(output).toContain('用工形式: 暑假工');
    expect(output).not.toContain('[本轮待确认线索]');
  });
});
