import { ThresholdsSection } from '@agent/generator/context/sections/procedural/thresholds.section';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import type { PromptModel } from '@agent/generator/context/prompt-model.types';
import { promptModelOf, renderSection } from '../../../../helpers/prompt-model.fixture';

describe('ThresholdsSection', () => {
  const section = new ThresholdsSection();

  const makeCtx = (thresholds?: StrategyConfigRecord['red_lines']['thresholds']): PromptModel =>
    promptModelOf({
      strategy: { ...promptModelOf().strategy, thresholds: thresholds ?? [] },
    });
  const build = (model: PromptModel) => renderSection(section, model);

  it('should format thresholds from config', () => {
    const block = build(
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
    expect(build(makeCtx())).toBe('');
    expect(build(makeCtx([]))).toBe('');
  });

  it('should format thresholds without numeric values', () => {
    const block = build(
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
    const block = build(
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
