import { detectCancelDoneClaimWithoutSubmission } from '@agent/guardrail/output/rules/booking-claim-reconciliation.rule';
import { detectInvalidModelOutput } from '@agent/guardrail/output/rules/invalid-model-output.rule';
import type { AgentToolCall } from '@agent/generator/generator.types';

const tc = (toolName: string, status?: string): AgentToolCall =>
  ({ toolName, args: {}, result: {}, status }) as unknown as AgentToolCall;

describe('生产 badcase 原文回验', () => {
  it('4peya6s9：cancel 失败却承诺取消 → revise', () => {
    const hit = detectCancelDoneClaimWithoutSubmission('好的，收到，我帮你取消明天的面试预约', [
      tc('duliday_cancel_work_order', 'error'),
    ]);
    expect(hit?.ruleId).toBe('cancel_done_claim_failed_tool');
  });

  it('nrz6axmr：零 cancel 却称已取消 → observe', () => {
    const hit = detectCancelDoneClaimWithoutSubmission(
      '这个提示是说你在平台那边已经报过必胜客了，系统有记录\n不影响咱们这边正常推进，你之前在西樵的面试我已经帮你取消了\n九江附近暂时没有合适的岗位，后续有匹配的我第一时间叫你',
      [tc('save_image_description', 'ok')],
    );
    expect(hit?.ruleId).toBe('cancel_done_claim_without_submission');
  });

  it('2m09fyio：[NO_REPLY] 整条投递 → block', () => {
    expect(detectInvalidModelOutput('[NO_REPLY]')?.action).toBe('block');
  });
});
