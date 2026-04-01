import { PolicySection } from '@agent/context/sections/policy.section';
import { PromptContext, PromptSection } from '@agent/context/sections/section.interface';

describe('PolicySection', () => {
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should concatenate non-empty child sections', async () => {
    const redLinesSection: PromptSection = {
      name: 'red',
      build: () => '# 红线\n- 禁止编造',
    };
    const thresholdsSection: PromptSection = {
      name: 'thresholds',
      build: () => '# 阈值\n- 最大 10km',
    };

    const section = new PolicySection(redLinesSection, thresholdsSection);
    await expect(section.build(baseCtx)).resolves.toBe('# 红线\n- 禁止编造\n\n# 阈值\n- 最大 10km');
  });

  it('should skip empty child sections', async () => {
    const section = new PolicySection(
      { name: 'red', build: () => '   ' },
      { name: 'thresholds', build: () => '# 阈值\n- 最大 10km' },
    );

    await expect(section.build(baseCtx)).resolves.toBe('# 阈值\n- 最大 10km');
  });
});
