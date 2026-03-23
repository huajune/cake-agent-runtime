import { RiskScenariosSection } from '@agent/context/sections/risk-scenarios.section';
import { PromptContext } from '@agent/context/sections/section.interface';
import { StrategyConfigRecord } from '@shared-types/strategy-config.types';

describe('RiskScenariosSection', () => {
  const section = new RiskScenariosSection();

  const makeCtx = (
    riskScenarios?: StrategyConfigRecord['red_lines']['riskScenarios'],
  ): PromptContext => ({
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {
      red_lines: {
        rules: ['禁止编造数据'],
        riskScenarios,
      },
    } as StrategyConfigRecord,
  });

  it('should format risk scenarios from config', () => {
    const block = section.build(
      makeCtx([
        {
          flag: 'age_sensitive',
          label: '年龄敏感',
          signals: '候选人提及年龄',
          strategy: '确认年龄是否符合',
        },
      ]),
    );

    expect(block).toContain('# 风险场景应对');
    expect(block).toContain('age_sensitive');
    expect(block).toContain('年龄敏感');
    expect(block).toContain('候选人提及年龄');
    expect(block).toContain('确认年龄是否符合');
  });

  it('should return empty when no risk scenarios configured', () => {
    expect(section.build(makeCtx())).toBe('');
    expect(section.build(makeCtx([]))).toBe('');
  });

  it('should format multiple risk scenarios', () => {
    const block = section.build(
      makeCtx([
        {
          flag: 'age_sensitive',
          label: '年龄敏感',
          signals: '提及年龄',
          strategy: '确认年龄',
        },
        {
          flag: 'insurance_promise_risk',
          label: '保险承诺风险',
          signals: '追问社保',
          strategy: '引导到店确认',
        },
      ]),
    );

    expect(block).toContain('age_sensitive');
    expect(block).toContain('insurance_promise_risk');
  });
});
