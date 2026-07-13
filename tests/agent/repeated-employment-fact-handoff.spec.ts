import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('repeated unknown employment fact handoff contract', () => {
  const root = process.cwd();

  it('forces repeated contract or agreement questions to request_handoff(other)', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/generator/context/prompts/candidate-consultation.md'),
      'utf8',
    );
    const handoffTool = readFileSync(join(root, 'src/tools/request-handoff.tool.ts'), 'utf8');

    expect(candidatePrompt).toContain('关键用工事实无法确认时，重复追问必须转人工');
    expect(candidatePrompt).toContain('先问"签合同吗"');
    expect(candidatePrompt).toContain('request_handoff(reasonCode="other")');
    expect(candidatePrompt).toContain('不得第二次复读"我帮你确认下"');
    expect(candidatePrompt).toContain('不得继续收资、预约或回答其他问题');

    expect(handoffTool).toContain('候选人追问合同/劳动合同/劳务或灵活用工协议');
    expect(handoffTool).toContain('必须按 other 调用本工具');
    expect(handoffTool).toContain('不要第二次复读兜底');
  });
});
