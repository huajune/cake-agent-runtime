import { ThresholdsSection } from '@agent/context/sections/thresholds.section';
import { PromptContext } from '@agent/context/sections/section.interface';
import { StrategyConfigRecord } from '@shared-types/strategy-config.types';

describe('ThresholdsSection', () => {
  const section = new ThresholdsSection();

  const makeCtx = (
    thresholds?: StrategyConfigRecord['red_lines']['thresholds'],
  ): PromptContext => ({
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {
      red_lines: {
        rules: ['禁止编造数据'],
        thresholds,
      },
    } as StrategyConfigRecord,
  });

  it('should format thresholds from config', () => {
    const block = section.build(
      makeCtx([
        {
          flag: 'max_recommend_distance_km',
          label: '推荐距离上限',
          rule: '仅推荐范围内的门店',
          max: 10,
          unit: 'km',
        },
      ]),
    );

    expect(block).toContain('# 业务阈值');
    expect(block).toContain('推荐距离上限');
    expect(block).toContain('最大 10');
    expect(block).toContain('km');
    expect(block).toContain('仅推荐范围内的门店');
  });

  it('should return empty when no thresholds configured', () => {
    expect(section.build(makeCtx())).toBe('');
    expect(section.build(makeCtx([]))).toBe('');
  });

  it('should format thresholds without numeric values', () => {
    const block = section.build(
      makeCtx([
        {
          flag: 'age_sensitive',
          label: '年龄敏感',
          rule: '确认年龄是否符合岗位要求',
        },
      ]),
    );

    expect(block).toContain('年龄敏感');
    expect(block).toContain('确认年龄是否符合岗位要求');
    expect(block).not.toContain('最小');
    expect(block).not.toContain('最大');
  });

  it('should format thresholds with min and max', () => {
    const block = section.build(
      makeCtx([
        {
          flag: 'age_requirement',
          label: '年龄要求',
          rule: '不符合年龄要求的不推荐',
          min: 16,
          max: 55,
          unit: '岁',
        },
      ]),
    );

    expect(block).toContain('最小 16');
    expect(block).toContain('最大 55');
    expect(block).toContain('岁');
  });
});
