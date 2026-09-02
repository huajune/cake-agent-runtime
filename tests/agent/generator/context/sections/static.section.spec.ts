import { StaticSection } from '@agent/generator/context/sections/static.section';
import { promptModelOf, renderSection } from '../../../../helpers/prompt-model.fixture';

describe('StaticSection', () => {
  const ctx = promptModelOf();

  it('should expose its configured name', () => {
    const section = new StaticSection('base-manual', 'content');
    expect(section.id).toBe('base-manual');
  });

  it('should return trimmed static content', () => {
    const section = new StaticSection('base-manual', '  hello world  ');
    expect(renderSection(section, ctx)).toBe('hello world');
  });
});
