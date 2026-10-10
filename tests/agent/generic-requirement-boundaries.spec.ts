import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FINAL_CHECK_RULES } from '@agent/generator/context/sections/procedural/final-check.section';

describe('generic job-requirement boundaries', () => {
  const root = process.cwd();

  const readPrompt = (name: string) =>
    readFileSync(join(root, 'src/agent/generator/context/sections/procedural', name), 'utf8');

  const finalCheckRuleText = (ruleId: string): string => {
    const rule = FINAL_CHECK_RULES.find((item) => item.id === ruleId);
    if (!rule) throw new Error(`final-check rule not found: ${ruleId}`);
    return rule.text;
  };

  it('keeps combination scheduling independent from weekly attendance frequency', () => {
    const candidatePrompt = readPrompt('candidate-consultation.md');
    const comboScheduleCheck = finalCheckRuleText('combo_schedule_two_dimensions');

    expect(candidatePrompt).toContain('“组合排班”只描述班次组合/轮换，不代表周频');
    expect(candidatePrompt).toContain('不能据此推断每周最低出勤天数');
    expect(candidatePrompt).toContain('候选人的每周出勤上限须独立处理');
    expect(candidatePrompt).toContain('是否匹配只看具体岗位本轮 `duliday_job_list` 返回的每周要求');
    expect(comboScheduleCheck).toContain('把两者作为独立维度');
    expect(comboScheduleCheck).toContain(
      '无具体岗位与本轮岗位工具证据时，不得推断组合排班存在周出勤底线或候选人难以匹配',
    );
  });

  it('keeps the universal food-service requirement while forbidding stage proportions', () => {
    const candidatePrompt = readPrompt('candidate-consultation.md');
    const healthCertCheck = finalCheckRuleText('health_cert_general_answer');

    expect(candidatePrompt).toContain('办理阶段以具体岗位当前要求为准');
    expect(candidatePrompt).toContain('餐饮类工作一律需要食品健康证');
    expect(candidatePrompt).toContain('不得编造各办理阶段的岗位占比');
    expect(candidatePrompt).toContain('一般性办证问题不得被当作候选人已持证或愿意办理的事实');
    expect(candidatePrompt).toContain('只适用于已确认具体岗位且工具证据支持入职前办证的约面流程');
    expect(healthCertCheck).toContain('保留正确的统一办证要求');
    expect(healthCertCheck).toContain('删除办理阶段分布的无证据比例结论');
    expect(healthCertCheck).toContain('不得把问句写成候选人已持证或愿意办理的事实');
  });

  it('keeps weak gender evidence and post-form detail questions on the deduplicated collection path', () => {
    const candidatePrompt = readPrompt('candidate-consultation.md');

    expect(candidatePrompt).toContain('无论岗位是否限制性别，都严禁拆成单独确认问题');
    expect(candidatePrompt).toContain('性别：男/女（如有误请改）');
    expect(candidatePrompt).toContain('发过收资表后插问岗位细节，不重发表');
    expect(candidatePrompt).toContain('先查证并回答当前问题，随后只用一句话提醒仍缺的字段');
    expect(candidatePrompt).toContain(
      '即使本轮只调用 `duliday_job_list` 而未重调 precheck，也不从历史复制整张表',
    );
  });
});
