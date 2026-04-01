import { MemorySection } from '@agent/context/sections/memory.section';
import { PromptContext } from '@agent/context/sections/section.interface';

describe('MemorySection', () => {
  const section = new MemorySection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should return trimmed memory block', () => {
    expect(section.build({ ...baseCtx, memoryBlock: '  [会话记忆]\nfoo\n  ' })).toBe(
      '[会话记忆]\nfoo',
    );
  });

  it('should return empty string when memory block is missing', () => {
    expect(section.build(baseCtx)).toBe('');
  });
});
