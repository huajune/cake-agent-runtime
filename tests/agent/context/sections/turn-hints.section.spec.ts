import { PromptContext } from '@agent/context/sections/section.interface';
import { TurnHintsSection } from '@agent/context/sections/turn-hints.section';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';

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
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, brands: ['来伊份'] },
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
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: { value: '上海', confidence: 'high', evidence: 'unique_district_alias' },
        },
        reasoning: '区映射识别',
      },
    });

    expect(output).toContain('[本轮高置信线索]');
    expect(output).toContain('意向城市: 上海（置信度: high，证据: unique_district_alias）');
  });

it('should move conflicting fields into pending confirmation hints and keep new fields in normal hints', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, city: { value: '上海', confidence: 'high', evidence: 'explicit_city' } },
      },
      highConfidenceFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          brands: ['来伊份'],
          city: { value: '北京', confidence: 'high', evidence: 'explicit_city' },
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

  it('should return empty string when all high-confidence fields match session facts', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, city: { value: '上海', confidence: 'high', evidence: 'explicit_city' } },
      },
      highConfidenceFacts: {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, city: { value: '上海', confidence: 'high', evidence: 'explicit_city' } },
        reasoning: '同值',
      },
    });

    expect(output).toBe('');
  });
});
