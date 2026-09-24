import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('unknown employment fact handoff contract', () => {
  const root = process.cwd();

  it('forces unresolved contract or agreement questions to salary_admin_inquiry handoff', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/generator/context/sections/procedural/candidate-consultation.md'),
      'utf8',
    );
    const handoffTool = readFileSync(join(root, 'src/tools/request-handoff.tool.ts'), 'utf8');

    expect(candidatePrompt).toContain('关键用工事实无法确认时，当轮转人工');
    expect(candidatePrompt).toContain('合同与协议性质、条款、签约主体');
    expect(candidatePrompt).toContain(
      '字段无答案时当轮调用 `request_handoff(reasonCode="salary_admin_inquiry")`',
    );
    expect(candidatePrompt).toContain('不得凭常识补充，也不得只承诺后续确认');
    expect(candidatePrompt).toContain('该工具会短路本轮并由人工跟进');

    expect(handoffTool).toContain('三方协议、合同/协议条款、签约主体');
    expect(handoffTool).toContain('当轮按本码调用本工具');
    expect(handoffTool).toContain('reasonCode=salary_admin_inquiry 时必传');
    expect(handoffTool).toContain('missingJobInfo');
  });
});
