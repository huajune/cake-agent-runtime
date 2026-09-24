import {
  buildBookingFailureRecordIntent,
  buildToolFailureHandoffSideEffect,
  buildToolFailureReplyInstruction,
  classifyBookingFailure,
} from '@tools/shared/tool-failure-handoff.util';
import { createToolContext } from '../../helpers/tool-context.fixture';

describe('tool-failure-handoff.util', () => {
  const context = createToolContext({
    session: { sessionId: 'chat-1', botImId: 'bot-im-1' },
    archive: {
      currentStage: 'interview_booking',
      currentFocusJob: { jobId: 528546 } as never,
      activeBookingJobIds: [999],
    },
    turnInput: { currentUserMessage: '帮我改到明天下午两点' },
  });

  describe('classifyBookingFailure', () => {
    it.each([
      ['用户已报名该岗位或品牌', 'duplicate_signup'],
      ['报名人数已超出上限', 'booking_capacity_full'],
      ['名额已满', 'booking_capacity_full'],
      ['内部错误', 'system_blocked'],
      [undefined, 'system_blocked'],
    ])('%s → %s', (message, expected) => {
      expect(classifyBookingFailure(message ? { apiMessage: message } : undefined)).toBe(expected);
    });
  });

  it('buildToolFailureHandoffSideEffect: modify_appointment + 工单/岗位/阶段/失败原因/候选人原话', () => {
    const intent = buildToolFailureHandoffSideEffect({
      context,
      action: '改约',
      workOrderId: 123,
      errorType: 'modify.rejected',
      failureReason: '海绵返回 code=500',
      requestedInterviewTime: '2026-06-20 14:00',
    });
    expect(intent).toEqual(
      expect.objectContaining({
        kind: 'general_handoff',
        source: 'agent_tool',
        origin: 'tool_failure',
        reasonCode: 'modify_appointment',
        alertLabel: '改约/取消自助失败',
        workOrderId: 123,
        jobId: 528546,
        stage: 'interview_booking',
        botImId: 'bot-im-1',
        recordHandoff: true,
      }),
    );
    expect(intent.reason).toBe(
      '候选人要求改约工单 123，自助改约失败（modify.rejected：海绵返回 code=500）｜想改到：2026-06-20 14:00｜候选人原话：「帮我改到明天下午两点」',
    );
    expect(intent.actionAdvice).toContain('手动改约工单 123');
    // 不带 idempotencyKey：统一出口按回合生成，同工单隔天再失败仍能触发
    expect('idempotencyKey' in intent).toBe(false);
  });

  it('buildBookingFailureRecordIntent: recordOnly + booking.failed 同源幂等键', () => {
    const intent = buildBookingFailureRecordIntent({
      context,
      jobId: 528546,
      interviewTime: '2026-08-28 10:00:00',
      errorType: 'booking.rejected',
      failureReason: '用户已报名该岗位或品牌',
    });
    expect(intent).toEqual(
      expect.objectContaining({
        origin: 'booking_failure',
        reasonCode: 'duplicate_signup',
        alertLabel: '重复报名核实',
        workOrderId: null,
        jobId: 528546,
        stage: 'interview_booking',
        idempotencyKey: 'chat-1:booking_failed:528546:2026-08-28 10:00:00',
        recordHandoff: true,
        recordOnly: true,
      }),
    );
    expect(
      buildBookingFailureRecordIntent({
        context,
        jobId: 1,
        interviewTime: undefined,
        errorType: 'booking.request_failed',
        failureReason: 'network',
      }),
    ).toEqual(
      expect.objectContaining({
        reasonCode: 'system_blocked',
        idempotencyKey: 'chat-1:booking_failed:1:wait_notice',
      }),
    );
  });

  it('reply instruction tells the truth and forbids request_handoff / retry', () => {
    const text = buildToolFailureReplyInstruction('取消');
    expect(text).toContain('不要再调用 request_handoff');
    expect(text).toContain('已经转给同事跟进');
    expect(text).toContain('不要谎称已取消');
    expect(text).not.toContain('我让同事帮你确认一下');
  });
});
