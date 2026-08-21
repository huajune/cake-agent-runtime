import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('booking failure current-result-only contract', () => {
  const root = process.cwd();

  it('requires an explicit terminal reply when the candidate asks for only the current result', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/generator/context/procedural/candidate-consultation.md'),
      'utf8',
    );

    expect(candidatePrompt).toContain('回复必须在确认失败事实处结束');
    expect(candidatePrompt).toContain('不得继续追问是否看其他岗位');
    expect(candidatePrompt).toContain('承诺以后确认或登记');
    expect(candidatePrompt).toContain('不得添加任何下一步建议');
  });
});
