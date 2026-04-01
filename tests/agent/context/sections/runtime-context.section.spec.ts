import { RuntimeContextSection } from '@agent/context/sections/runtime-context.section';
import { PromptContext, PromptSection } from '@agent/context/sections/section.interface';

describe('RuntimeContextSection', () => {
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should concatenate non-empty runtime sections in order', async () => {
    const section = new RuntimeContextSection(
      { name: 'stage', build: () => '[阶段]' },
      { name: 'memory', build: () => '[记忆]' },
      { name: 'time', build: () => '当前时间：2026-04-01' },
      { name: 'channel', build: () => '' },
    );

    await expect(section.build(baseCtx)).resolves.toBe('[阶段]\n\n[记忆]\n\n当前时间：2026-04-01');
  });

  it('should skip empty child sections', async () => {
    const empty: PromptSection = { name: 'empty', build: () => '   ' };
    const section = new RuntimeContextSection(empty, empty, empty, empty);

    await expect(section.build(baseCtx)).resolves.toBe('');
  });
});
