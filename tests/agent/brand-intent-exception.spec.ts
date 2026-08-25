import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('agent-recommended brand intent exception', () => {
  const root = process.cwd();

  it('keeps agent-recommended jobs from being treated as candidate hard brand intent', () => {
    const candidatePrompt = readFileSync(
      join(root, 'src/agent/generator/context/sections/procedural/candidate-consultation.md'),
      'utf8',
    );
    const jobListTool = readFileSync(join(root, 'src/tools/duliday-job-list.tool.ts'), 'utf8');
    const handoffTool = readFileSync(join(root, 'src/tools/request-handoff.tool.ts'), 'utf8');

    // 2026-08-21 手册批：查询机制细节归并 job_list 描述唯一居所，手册留跨工具原则；
    // include 开关已 schema default(true)，手册不再教开关
    expect(candidatePrompt).toContain('Agent 主动推荐不等于候选人自带品牌意向');
    expect(candidatePrompt).toContain('去掉品牌参数');

    expect(jobListTool).toContain('Agent 自推岗位不适用品牌锁死');
    expect(jobListTool).toContain('不要直接 request_handoff');

    expect(handoffTool).toContain('不要直接调用本工具');
    expect(handoffTool).toContain('重查可匹配替代岗位');
  });
});
