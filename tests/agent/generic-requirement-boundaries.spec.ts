import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('generic job-requirement boundaries', () => {
  const root = process.cwd();

  const readPrompt = (name: string) =>
    readFileSync(join(root, 'src/agent/generator/context/prompts', name), 'utf8');

  it('keeps combination scheduling independent from weekly attendance frequency', () => {
    const candidatePrompt = readPrompt('candidate-consultation.md');
    const finalCheckPrompt = readPrompt('candidate-consultation-final-check.md');

    expect(candidatePrompt).toContain('“组合排班”只描述班次组合/轮换，不代表周频');
    expect(candidatePrompt).toContain('不能据此推断每周最低出勤天数');
    expect(candidatePrompt).toContain('是否匹配要另看具体岗位明确的每周要求');
    expect(candidatePrompt).toContain(
      '严禁泛化成“组合排班通常有周频底线 / 每周两天很难匹配这类排班”',
    );
    expect(finalCheckPrompt).toContain('把两者作为独立维度');
    expect(finalCheckPrompt).toContain(
      '删除“组合排班通常有每周出勤底线 / 每周 N 天很难匹配”之类泛化',
    );
  });

  it('keeps the universal food-service requirement while forbidding stage proportions', () => {
    const candidatePrompt = readPrompt('candidate-consultation.md');
    const finalCheckPrompt = readPrompt('candidate-consultation-final-check.md');

    expect(candidatePrompt).toContain('餐饮类工作一律需要健康证，办理阶段不得编造比例');
    expect(candidatePrompt).toContain('餐饮类工作一律需要食品健康证');
    expect(candidatePrompt).toContain(
      '不得编造“大部分录用后办 / 少数或极少数面试前办”等比例性流程结论',
    );
    expect(candidatePrompt).toContain('只用于已确认具体岗位且工具证据表明入职前办证的约面流程');
    expect(finalCheckPrompt).toContain('保留正确的统一办证要求');
    expect(finalCheckPrompt).toContain(
      '删除“大部分 / 少数 / 极少数在面试前、录用后或入职前办理”等无证据比例结论',
    );
  });

  it('keeps weak gender evidence and post-form detail questions on the deduplicated collection path', () => {
    const candidatePrompt = readPrompt('candidate-consultation.md');

    expect(candidatePrompt).toContain('无论岗位是否限制性别，都严禁拆成单独确认问题');
    expect(candidatePrompt).toContain('性别：男/女（如有误请改）');
    expect(candidatePrompt).toContain('发过收资表后插问岗位细节，不重发表');
    expect(candidatePrompt).toContain('答完只用“还差 X、Y 两项哈”');
  });
});
