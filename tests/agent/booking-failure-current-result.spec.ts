import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('booking failure current-result-only contract', () => {
  const root = process.cwd();

  it('requires an explicit terminal reply when the candidate asks for only the current result', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/generator/context/sections/procedural/candidate-consultation.md'),
      'utf8',
    );

    expect(candidatePrompt).toContain(
      '候选人报告报名失败但工具和权威历史没有原因时，只能确认失败事实',
    );
    expect(candidatePrompt).toContain('若候选人同时明确只要当前结果、不需要后续动作或再次提交');
    expect(candidatePrompt).toContain('确认失败后立即结束');
    expect(candidatePrompt).toContain('不追加问题、推荐、承诺或建议');
  });
});
