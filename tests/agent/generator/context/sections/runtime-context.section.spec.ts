import { RuntimeContextSection } from '@agent/generator/context/sections/runtime-context.section';
import { PromptContext, PromptSection } from '@agent/generator/context/sections/section.interface';

describe('RuntimeContextSection', () => {
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should concatenate non-empty runtime sections in order', async () => {
    const section = new RuntimeContextSection(
      { name: 'stage', domain: 'teaching', build: () => '[阶段]' },
      { name: 'memory', domain: 'evidence', build: () => '[记忆]' },
      { name: 'turn-hints', domain: 'evidence', build: () => '' },
      {
        name: 'hard-constraints',
        domain: 'evidence',
        build: () => '[本轮查询硬约束]\n- 性别: 男',
      },
      { name: 'time', domain: 'tool_result', build: () => '当前时间：2026-04-01' },
      { name: 'channel', domain: 'teaching', build: () => '' },
    );

    await expect(section.build(baseCtx)).resolves.toBe(
      '[阶段]\n\n[记忆]\n\n[本轮查询硬约束]\n- 性别: 男\n\n当前时间：2026-04-01',
    );
  });

  it('should skip empty child sections', async () => {
    const empty: PromptSection = { name: 'empty', domain: 'teaching', build: () => '   ' };
    const section = new RuntimeContextSection(empty, empty, empty, empty, empty, empty);

    await expect(section.build(baseCtx)).resolves.toBe('');
  });
});
