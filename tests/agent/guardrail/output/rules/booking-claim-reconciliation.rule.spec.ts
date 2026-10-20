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
      detectBookingDoneClaimWithoutSubmission(
        '这家时薪24元，班次17:00-23:00，感兴趣可以帮你报名',
        [],
      ),
    ).toBeNull();
  });
});

describe('detectCancelDoneClaimWithoutSubmission', () => {
  it('取消工具调用失败却宣称已取消 → repair（硬矛盾）', () => {
    const hit = detectCancelDoneClaimWithoutSubmission('好的，收到，我帮你取消明天的面试预约', [
      failedCall('duliday_cancel_work_order'),
    ]);
    expect(hit?.ruleId).toBe('cancel_done_claim_failed_tool');
    expect(hit?.action).toBe('repair');
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

describe('booking_done_claim_no_work_order（长期记忆确证无在途工单时要求 replan）', () => {
  const booking = (job_id: number | null | undefined) => ({
    work_order_id: 1,
    linked_at: '2026-09-02',
    job_id,
  });

  it('零 booking + 无在途工单 → replan（badcase wvr7pejq；2026-10-19 起由 repair 升档）', () => {
    const hit = detectBookingDoneClaimWithoutSubmission('预约成功\n\n面试地址：勤奋路103号', [], {
      activeBookings: [],
    });
    expect(hit?.ruleId).toBe('booking_done_claim_no_work_order');
    expect(hit?.action).toBe('replan');
    expect(hit?.repairMode).toBe('replan');
    expect(hit?.currentReplySendable).toBe(false);
  });

  it('代报第二人零工具宣称"也预约成功啦" → replan，不走无工具改写（badcase x1soque5，trace batch_6accbaa4ce406a6aee50a95b_1792057074005）', () => {
    // 第一人罗彝的工单 472752 在前几轮已真实建单；本轮零工具、焦点仍是同一岗位时，
    // 名下工单能解释"跨轮复述"，只落 observe——这是 2026-09-09 判据的既定边界。
    // 但候选人名下确证没有任何在途工单、或在途工单都不是本岗时，"何佳淼也预约成功啦"就是假回执，
    // rewrite 只能改成"我这就去提交"（永不兑现），必须同参重进让 precheck/booking 真正发生。
    const hit = detectBookingDoneClaimWithoutSubmission(
      '好的，何佳淼也预约成功啦，面试时间同样是明天下午两点',
      [],
      {
        activeBookings: [],
      },
    );
    expect(hit?.ruleId).toBe('booking_done_claim_no_work_order');
    expect(hit?.action).toBe('replan');
  });

  it('在途工单存在或未知时保持 observe', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('已经帮你约好了', [], {
        activeBookings: [booking(528334)],
      })?.ruleId,
    ).toBe('booking_done_claim_without_submission');
    expect(detectBookingDoneClaimWithoutSubmission('已经帮你约好了', [], {})?.ruleId).toBe(
      'booking_done_claim_without_submission',
    );
  });

  it('在途工单都不是本轮焦点岗位 → replan（chat 6a97b336 换店重约后零工具宣称"报名已提交成功"）', () => {
    const hit = detectBookingDoneClaimWithoutSubmission(
      '李霄的报名已提交成功\n\n面试时间：明天（9月8日）下午 2 点\n门店：必胜客武进万达店',
      [],
      { activeBookings: [booking(529171)], focusJobId: 528334 },
    );
    expect(hit?.ruleId).toBe('booking_done_claim_no_work_order');
    expect(hit?.action).toBe('replan');
  });

  it('在途工单就是焦点岗位 → 跨轮复述，保持 observe', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('之前已帮你约好了，明天下午两点', [], {
        activeBookings: [booking(529171), booking(528334)],
        focusJobId: 528334,
      })?.ruleId,
    ).toBe('booking_done_claim_without_submission');
  });

  it('入口快照焦点为空时回落本轮 precheck 参数 jobId → repair（chat 6aa13718 旧店工单 + 新店零工具"报名成功"）', () => {
    const precheck = {
      toolName: 'duliday_interview_precheck',
      args: { mode: 'query', jobId: 523254 },
      result: { success: true, nextAction: 'ready_to_book' },
    } as unknown as AgentToolCall;
    const hit = detectBookingDoneClaimWithoutSubmission(
      '报名成功\n\n面试时间：9月17日（周四）14:00',
      [precheck],
      { activeBookings: [booking(520437)] },
    );
    expect(hit?.ruleId).toBe('booking_done_claim_no_work_order');
    expect(hit?.action).toBe('replan');

    // 同轮多次 precheck 取最后一次；快照焦点存在时仍以快照为准。
    const older = { ...precheck, args: { jobId: 520437 } } as unknown as AgentToolCall;
    expect(
      detectBookingDoneClaimWithoutSubmission('报名成功', [precheck, older], {
        activeBookings: [booking(520437)],
      })?.ruleId,
    ).toBe('booking_done_claim_without_submission');
    expect(
      detectBookingDoneClaimWithoutSubmission('报名成功', [precheck], {
        activeBookings: [booking(520437)],
        focusJobId: 520437,
      })?.ruleId,
    ).toBe('booking_done_claim_without_submission');
  });

  it('焦点岗位未知或老行 job_id 为空时不升档', () => {
    expect(
      detectBookingDoneClaimWithoutSubmission('已经帮你约好了', [], {
        activeBookings: [booking(529171)],
      })?.ruleId,
    ).toBe('booking_done_claim_without_submission');
    expect(
      detectBookingDoneClaimWithoutSubmission('已经帮你约好了', [], {
        activeBookings: [booking(null), booking(529171)],
        focusJobId: 528334,
      })?.ruleId,
    ).toBe('booking_done_claim_without_submission');
  });
});

describe('追加候选人的完成回执独立对账', () => {
  it('第一人同岗有工单，第二人活动表单未提交，仍要求 replan', () => {
    const hit = detectBookingDoneClaimWithoutSubmission('第二人也预约成功了', [], {
      activeBookings: [{ work_order_id: 1, linked_at: '2026-10-20', job_id: 100 }],
      focusJobId: 100,
      pendingAdditionalCandidateJobId: 100,
    });
    expect(hit?.ruleId).toBe('booking_done_claim_no_work_order');
    expect(hit?.action).toBe('replan');
  });
  it('旧主候选人预检的在途工单不能覆盖当前第二人未提交状态', () => {
    const hit = detectBookingDoneClaimWithoutSubmission(
      '第二人报名成功',
      [call('duliday_interview_precheck', { duplicateBookingGuard: { workOrderId: 1 } })],
      {
        pendingAdditionalCandidateJobId: 100,
      },
    );
    expect(hit?.action).toBe('replan');
  });
});
