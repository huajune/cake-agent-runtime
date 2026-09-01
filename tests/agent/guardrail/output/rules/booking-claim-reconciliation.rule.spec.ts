import type { AgentToolCall } from '@agent/generator/generator.types';
import {
  detectBookingDoneClaimWithoutSubmission,
  detectCancelDoneClaimWithoutSubmission,
} from '@agent/guardrail/output/rules/booking-claim-reconciliation.rule';

function call(toolName: string, result: Record<string, unknown> = {}): AgentToolCall {
  return { toolName, args: {}, result } as unknown as AgentToolCall;
}

function failedCall(toolName: string): AgentToolCall {
  return { toolName, args: {}, result: {}, status: 'error' } as unknown as AgentToolCall;
}

describe('detectBookingDoneClaimWithoutSubmission', () => {
  it('零 booking 调用却宣称"已帮你报好"时命中 observe', () => {
    const hit = detectBookingDoneClaimWithoutSubmission('已帮你报好名啦，明天下午2点到店面试', []);
    expect(hit?.ruleId).toBe('booking_done_claim_without_submission');
    expect(hit?.action).toBe('observe');
  });

  it('"报名成功"独立宣称同样命中', () => {
    const hit = detectBookingDoneClaimWithoutSubmission('报名成功，等门店通知就行', []);
    expect(hit?.ruleId).toBe('booking_done_claim_without_submission');
  });

  it('本轮存在 booking 调用（无论成败）让位给 booking_receipt_mismatch', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('已帮你提交报名', [
        call('duliday_interview_booking', { success: false }),
      ]),
    ).toBeNull();
  });

  it('本轮成功改约后的"已帮你约到"是合法回执', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('已帮你约到明天下午1点', [
        call('duliday_modify_interview_time', { success: true }),
      ]),
    ).toBeNull();
  });

  it('precheck 返回在途工单时完成时态是合法复述', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('之前已帮你约好周四下午的面试哈', [
        call('duliday_interview_precheck', {
          duplicateBookingGuard: { workOrderId: 'wo-1', interviewTime: '周四 14:00' },
        }),
      ]),
    ).toBeNull();
  });

  it('将来时收资话术（"资料发我，我帮你约"）不在口径内', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('你把姓名和联系方式发我，我马上帮你约面试', []),
    ).toBeNull();
  });

  it('普通岗位介绍不命中', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('这家时薪24元，班次17:00-23:00，感兴趣可以帮你报名', []),
    ).toBeNull();
  });
});

describe('detectCancelDoneClaimWithoutSubmission', () => {
  it('取消工具调用失败却宣称已取消 → revise（硬矛盾）', () => {
    const hit = detectCancelDoneClaimWithoutSubmission('好的，收到，我帮你取消明天的面试预约', [
      failedCall('duliday_cancel_work_order'),
    ]);
    expect(hit?.ruleId).toBe('cancel_done_claim_failed_tool');
    expect(hit?.action).toBe('revise');
  });

  it('零取消调用却宣称"已经帮你取消了" → observe', () => {
    const hit = detectCancelDoneClaimWithoutSubmission(
      '你之前在西樵的面试我已经帮你取消了，九江附近暂时没有合适的岗位',
      [call('save_image_description')],
    );
    expect(hit?.ruleId).toBe('cancel_done_claim_without_submission');
    expect(hit?.action).toBe('observe');
  });

  it('取消成功后的完成时态是合法回执', () => {
    expect(
      detectCancelDoneClaimWithoutSubmission('已经帮你取消了，后续有合适的再联系你', [
        call('duliday_cancel_work_order', { success: true }),
      ]),
    ).toBeNull();
  });

  it('一次失败一次成功时按成功放行', () => {
    expect(
      detectCancelDoneClaimWithoutSubmission('面试已取消', [
        failedCall('duliday_cancel_work_order'),
        call('duliday_cancel_work_order', { success: true }),
      ]),
    ).toBeNull();
  });

  it('将来时"我帮你取消"不在口径内', () => {
    expect(detectCancelDoneClaimWithoutSubmission('我这就帮你取消，稍等哈', [])).toBeNull();
  });

  it('普通岗位介绍不命中', () => {
    expect(
      detectCancelDoneClaimWithoutSubmission('这家时薪24元，随时可以取消不用违约金', []),
    ).toBeNull();
  });
});
