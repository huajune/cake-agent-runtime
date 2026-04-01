import { StaticSection } from '@agent/context/sections/static.section';
import { PromptContext } from '@agent/context/sections/section.interface';

describe('StaticSection', () => {
  const ctx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should expose its configured name', () => {
    const section = new StaticSection('base-manual', 'content');
    expect(section.name).toBe('base-manual');
  });

  it('should return trimmed static content', () => {
    const section = new StaticSection('base-manual', '  hello world  ');
    expect(section.build(ctx)).toBe('hello world');
  });
});
