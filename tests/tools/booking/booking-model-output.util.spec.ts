import { projectBookingModelOutput } from '@tools/booking/booking-model-output.util';

describe('报名回执的模型输出边界', () => {
  it('只保留回复所需事实，嵌套副作用和未来新增后台字段也不透传', () => {
    const output = {
      success: true,
      workOrderId: 468104,
      traceId: 'internal-trace',
      notice: '内部项目经理通知',
      requestInfo: { jobId: 529386, labelIds: [769] },
      collectionConfigDebts: [{ labelId: 4 }],
      futureBackendMetadata: { workOrderId: 468104 },
      otherActiveBookings: [{ workOrderId: 468105, jobId: 100 }],
      sideEffect: { workOrderId: 468104, idempotencyKey: 'private-key' },
      _replyInstruction: '报名成功，请保持电话畅通',
      _waitNoticeReplyGuide: '面试官会电话联系',
      groupInvite: {
        success: true,
        delivery: 'invite_card',
        groupName: '上海兼职群',
        internalId: 123,
      },
      interviewGroupHandling: {
        required: true,
        delivery: 'manual',
        candidateGuide: '等候面试群邀请',
        internalId: 456,
      },
    };
    const before = JSON.stringify(output);
    expect(projectBookingModelOutput(output)).toEqual({
      success: true,
      _replyInstruction: '报名成功，请保持电话畅通',
      _waitNoticeReplyGuide: '面试官会电话联系',
      groupInvite: { success: true, delivery: 'invite_card', groupName: '上海兼职群' },
      interviewGroupHandling: {
        required: true,
        delivery: 'manual',
        candidateGuide: '等候面试群邀请',
      },
    });
    expect(JSON.stringify(output)).toBe(before);
  });

  it.each([
    {
      success: false,
      errorType: 'booking.already_booked',
      existingWorkOrderId: 468104,
      _existingInterviewTimeHuman: '9月25日（周五）14:00',
    },
    {
      success: false,
      errorType: 'booking.request_failed',
      workOrderId: 468104,
      reason: 'internal response',
      apiMessage: 'internal response',
    },
    {
      success: true,
      workOrderId: 468104,
      traceId: 'internal-trace',
      _confirmedInterviewTimeHuman: '9月25日（周五）14:00',
    },
  ])('重复报名、异常、已提交降级结果均保留处置指令并隐藏编号：%j', (result) => {
    const output = projectBookingModelOutput({ ...result, _replyInstruction: '按实际结果处理' });
    expect(output.success).toBe(result.success);
    expect(output._replyInstruction).toBe('按实际结果处理');
    expect(output.errorType).toBe(result.errorType);
    expect(JSON.stringify(output)).not.toMatch(/468104|internal/);
    expect(output._existingInterviewTimeHuman).toBe(result._existingInterviewTimeHuman);
    expect(output._confirmedInterviewTimeHuman).toBe(result._confirmedInterviewTimeHuman);
  });
});
