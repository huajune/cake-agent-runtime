import { detectJobAvailabilityWithoutLookup } from '@agent/guardrail/output/rules/job-availability-grounding.rule';
import type { AgentToolCall } from '@agent/generator/generator.types';

describe('detectJobAvailabilityWithoutLookup', () => {
  it.each([
    '上海兼职岗位挺多的，我先帮你看看附近的。',
    '我们这边有不少兼职岗位。',
    '附近好几家门店在招呢。',
    '暑假工我们有。',
  ])('revises a positive availability claim without a job lookup: %s', (reply) => {
    expect(detectJobAvailabilityWithoutLookup(reply)).toMatchObject({
      ruleId: 'job_availability_without_lookup',
      action: 'revise',
    });
  });

  it.each([
    '我先帮你查下附近有没有合适的岗位。',
    '你在哪个区域呀？我帮你看看附近在招的岗位。',
    '我还没查，不能说上海的岗位多不多。',
    '附近有没有兼职岗位？',
    '一般要看具体岗位，面试前是否需要有证也以岗位为准。',
    '时薪20元，日结，也有工作餐。',
  ])('allows a question or lookup commitment without an availability conclusion: %s', (reply) => {
    expect(detectJobAvailabilityWithoutLookup(reply)).toBeNull();
  });

  it('allows a positive claim after the job-list tool ran', () => {
    const toolCalls = [{ toolName: 'duliday_job_list' }] as AgentToolCall[];

    expect(detectJobAvailabilityWithoutLookup('附近有几个兼职岗位。', toolCalls)).toBeNull();
  });
});
