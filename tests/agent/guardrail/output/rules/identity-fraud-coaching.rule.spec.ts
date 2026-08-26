import { detectIdentityMisregistrationCoaching } from '@agent/guardrail/output/rules/identity-fraud-coaching.rule';
import type { AgentToolCall } from '@agent/generator/generator.types';

const precheckIdentityGuard = [
  {
    toolName: 'duliday_interview_precheck',
    result: { identityFieldGuard: { mustAskCandidate: true } },
  } as unknown as AgentToolCall,
];

describe('detectIdentityMisregistrationCoaching', () => {
  it.each([
    '为了通过系统审核，把你按非学生登记上去就行',
    '面试的时候先别说你是学生',
    '回复不是暑假工才能提交预约',
  ])('无条件拦截封闭的身份造假教唆：%s', (reply) => {
    expect(detectIdentityMisregistrationCoaching(reply, [])?.ruleId).toBe(
      'identity_misregistration_coaching',
    );
  });

  it('复用已确认学生事实拦截虚假登记', () => {
    expect(
      detectIdentityMisregistrationCoaching(
        '身份帮你登记成社会人士了',
        [],
        { sessionFacts: { 'interview.is_student': true } } as never,
        '那怎么办',
      ),
    ).not.toBeNull();
  });

  it('复用 precheck 身份闸门拦截模型代填', () => {
    expect(
      detectIdentityMisregistrationCoaching(
        '身份帮你填成社会人士了',
        precheckIdentityGuard,
        undefined,
        '好的',
      ),
    ).not.toBeNull();
  });

  it('候选人明确自报社会人士时允许如实登记', () => {
    expect(
      detectIdentityMisregistrationCoaching(
        '身份帮你填成社会人士了',
        precheckIdentityGuard,
        undefined,
        '我不是学生，是社会人士',
      ),
    ).toBeNull();
  });

  it('如实说明学生岗位暂时没有不属于造假教唆', () => {
    expect(
      detectIdentityMisregistrationCoaching(
        '目前确实没有招学生的岗位，我可以继续帮你看接受学生的岗位',
        [],
      ),
    ).toBeNull();
  });
});
