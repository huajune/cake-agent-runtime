import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('agent-recommended brand intent exception', () => {
  const root = process.cwd();

  it('keeps agent-recommended jobs from being treated as candidate hard brand intent', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/context/prompts/candidate-consultation.md'),
      'utf8',
    );
    const jobListTool = readFileSync(join(root, 'src/tools/duliday-job-list.tool.ts'), 'utf8');
    const handoffTool = readFileSync(join(root, 'src/tools/request-handoff.tool.ts'), 'utf8');

    expect(candidatePrompt).toContain('Agent 主动推荐不等于候选人自带品牌意向');
    expect(candidatePrompt).toContain('去掉 jobIdList / brandIdList / brandAliasList');
    expect(candidatePrompt).toContain('includeHiringRequirement');
    expect(candidatePrompt).toContain('includeWorkTime');

    expect(jobListTool).toContain('Agent 自推岗位不适用品牌锁死');
    expect(jobListTool).toContain('不要直接 request_handoff');

    expect(handoffTool).toContain('不要直接调用本工具');
    expect(handoffTool).toContain('重查可匹配替代岗位');
  });
});
