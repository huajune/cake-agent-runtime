import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('unknown employment fact handoff contract', () => {
  const root = process.cwd();

  it('forces unresolved contract or agreement questions to salary_admin_inquiry handoff', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/generator/context/prompts/candidate-consultation.md'),
      'utf8',
    );
    const handoffTool = readFileSync(join(root, 'src/tools/request-handoff.tool.ts'), 'utf8');

    expect(candidatePrompt).toContain('关键用工事实无法确认时，当轮转人工');
    expect(candidatePrompt).toContain('合同/劳动合同/劳务或灵活用工协议');
    expect(candidatePrompt).toContain('request_handoff(reasonCode="salary_admin_inquiry")');
    expect(candidatePrompt).toContain('不要说"这个我帮你确认下/问清楚了告诉你"却不调用工具');
    expect(candidatePrompt).toContain('request_handoff` 会短路本轮并由人工跟进');

    expect(handoffTool).toContain('三方协议、合同/协议条款、签约主体');
    expect(handoffTool).toContain('直接按本码调用本工具');
    expect(handoffTool).toContain('reasonCode=salary_admin_inquiry 时必传');
    expect(handoffTool).toContain('missingJobInfo');
  });
});
