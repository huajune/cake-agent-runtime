import { classifyReviewedOutcome } from '@agent/runner/turn-outcome';
import { buildPreHandoffReceipt } from '@agent/runner/handoff-receipt';
import type { SessionRef } from '@agent/runner/agent-runner.types';
import type { OutputGuardDecision } from '@agent/guardrail/output/output-guardrail.service';
import type { AgentToolCall } from '@agent/generator/generator.types';

/**
 * PRD R5.1 第 3 条：同轮已提交的报名/改约/取消结果 + request_handoff 短路 → handoff 终态携带
 * 确定性回执 preHandoffReceipt，渠道在暂停前先投递。文本只来自工具结构化字段。
 */
describe('buildPreHandoffReceipt', () => {
  const requestHandoff: AgentToolCall = {
    toolName: 'request_handoff',
    args: { reasonCode: 'salary_admin_inquiry', reason: '试工问题答不上' },
    result: { dispatched: true, shortCircuited: true, reasonCode: 'salary_admin_inquiry' },
  };

  it.each(['job', 'brand'])(
    'keeps a cross-account precheck receipt (%s) before handoff',
    (matchedBy) => {
      const receipt = buildPreHandoffReceipt([
        {
          toolName: 'duliday_interview_precheck',
          args: { jobId: 100 },
          result: {
            success: true,
            nextAction: 'already_booked',
            duplicateBookingGuard: {
              workOrderId: 888001,
              crossAccount: true,
              matchedBy,
            },
          },
        },
        requestHandoff,
      ]);
      expect(receipt?.text).toContain(matchedBy === 'job' ? '已报过这个岗位' : '已报过这个品牌');
      expect(receipt?.text).toContain('本次没有重复提交');
      expect(receipt?.text).not.toContain('提交成功');
      expect(receipt?.sources).toEqual(['duliday_interview_precheck']);
    },
  );

  it('keeps a provider duplicate rejection receipt without inventing a verified appointment', () => {
    const receipt = buildPreHandoffReceipt([
      {
        toolName: 'duliday_interview_booking',
        args: { jobId: 100, interviewTime: '2099-01-01 10:00' },
        result: {
          success: false,
          errorType: 'booking.already_booked',
          alreadyBookedSource: 'sponge_duplicate_signup',
          crossAccount: true,
        },
      },
    ]);
    expect(receipt?.text).toContain('系统显示你已报过这个岗位或品牌');
    expect(receipt?.text).not.toContain('2099');
    expect(receipt?.text).toContain('核实已有报名和面试安排');
  });

  it('does not turn unknown or unverified precheck data into an existing-booking receipt', () => {
    expect(
      buildPreHandoffReceipt([
        {
          toolName: 'duliday_interview_precheck',
          args: {},
          result: { success: true, nextAction: 'already_booked' },
        },
        {
          toolName: 'duliday_interview_booking',
          args: {},
          result: { success: false, errorType: 'action.result_unresolved' },
        },
      ]),
    ).toBeUndefined();
  });

  it('booking success with interview time → 岗位 + 时间', () => {
    const receipt = buildPreHandoffReceipt([
      {
        toolName: 'duliday_interview_booking',
        args: { jobId: 528546, interviewTime: '2026-08-28 10:00:00' },
        result: {
          success: true,
          workOrderId: 459742,
          requestInfo: { jobId: 528546, interviewTime: '2026-08-28 10:00:00' },
          _confirmedInterviewTimeHuman: '8月28日（周五）10:00',
          brandName: '肯德基',
          storeName: '西宸里店',
        },
      },
      requestHandoff,
    ]);
    expect(receipt).toEqual({
      text: '肯德基 西宸里店 的报名已经提交成功了，面试时间是 8月28日（周五）10:00。',
      sources: ['duliday_interview_booking'],
    });
  });

  it('wait-notice booking → 等通知口径，不编时间', () => {
    const receipt = buildPreHandoffReceipt([
      {
        toolName: 'duliday_interview_booking',
        args: { jobId: 1 },
        result: { success: true, workOrderId: 1, requestInfo: { jobId: 1, interviewTime: null } },
      },
    ]);
    expect(receipt?.text).toBe(
      '报名资料已经提交成功了，这个岗位是等通知的，请等待面试安排通知，保持手机畅通。',
    );
  });

  it('wait-notice booking on an AI-interview job → 短信发链接口径，不说面试官电话联系（badcase 2026-10-14）', () => {
    const receipt = buildPreHandoffReceipt([
      {
        toolName: 'duliday_interview_booking',
        args: { jobId: 1 },
        result: {
          success: true,
          workOrderId: 1,
          interviewMethod: 'AI面试',
          requestInfo: { jobId: 1, interviewTime: null },
          brandName: '肯德基',
        },
      },
    ]);
    expect(receipt?.text).toBe(
      '肯德基 的报名资料已经提交成功了，这个岗位是等通知的，第一轮是 AI 面试，面试链接会短信发到你手机，留意短信并按时完成；通过后店长再联系你。',
    );
    expect(receipt?.text).not.toContain('电话联系');
  });

  it('AI 面试转人工前的固定回执保留流程首句中的完成时限', () => {
    const receipt = buildPreHandoffReceipt([
      {
        toolName: 'duliday_interview_booking',
        args: { jobId: 1 },
        result: {
          success: true,
          workOrderId: 1,
          interviewMethod: 'AI面试',
          interviewProcessRemark: '报名后 24 小时内短信发链接，请在 48 小时内完成。第二句不附加。',
          requestInfo: { jobId: 1, interviewTime: null },
        },
      },
    ]);
    expect(receipt?.text).toContain('报名后 24 小时内短信发链接，请在 48 小时内完成');
    expect(receipt?.text).not.toContain('第二句');
  });

  it('modify + cancel successes are described from their structured fields', () => {
    const receipt = buildPreHandoffReceipt([
      {
        toolName: 'duliday_modify_interview_time',
        args: { workOrderId: 1 },
        result: { success: true, workOrderId: 1, newInterviewTime: '2026-09-03 14:00' },
      },
      {
        toolName: 'duliday_cancel_work_order',
        args: { workOrderId: 2 },
        result: { success: true, workOrderId: 2 },
      },
    ]);
    expect(receipt?.text).toBe(
      '面试时间已经帮你改到 9月3日（周四）14:00 了，记得准时哈。\n\n这次面试预约已经帮你取消了。',
    );
    expect(receipt?.sources).toEqual([
      'duliday_modify_interview_time',
      'duliday_cancel_work_order',
    ]);
  });

  it('ignores failed or non-committing tools', () => {
    expect(
      buildPreHandoffReceipt([
        {
          toolName: 'duliday_interview_booking',
          args: {},
          result: { success: false, errorType: 'booking.rejected' },
        },
        { toolName: 'duliday_job_list', args: {}, result: { success: true } },
        requestHandoff,
      ]),
    ).toBeUndefined();
  });
});

describe('classifyReviewedOutcome — request_handoff 之前的已提交动作回执', () => {
  const sessionRef: SessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'chat-1' };
  const decision: OutputGuardDecision = {
    decision: 'pass',
    riskLevel: 'low',
    violations: [],
    ruleIds: [],
    blockedRuleIds: [],
    repairMode: 'rewrite',
    reasonCode: undefined,
  };
  const classify = (toolCalls: AgentToolCall[]) =>
    classifyReviewedOutcome(
      {
        text: '',
        steps: 2,
        agentSteps: [],
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        outputDecision: decision,
        resolution: { outcome: 'reply' },
        revised: false,
      },
      sessionRef,
      'msg-1',
    );

  const bookingSuccess: AgentToolCall = {
    toolName: 'duliday_interview_booking',
    args: { jobId: 528546, interviewTime: '2026-08-28 10:00:00' },
    result: {
      success: true,
      workOrderId: 459742,
      requestInfo: { jobId: 528546, interviewTime: '2026-08-28 10:00:00' },
      _confirmedInterviewTimeHuman: '8月28日（周五）10:00',
    },
  };

  it('carries an existing-booking receipt through the actual handoff classifier', () => {
    const outcome = classify([
      {
        toolName: 'duliday_interview_precheck',
        args: { jobId: 100 },
        result: {
          success: true,
          nextAction: 'already_booked',
          duplicateBookingGuard: {
            workOrderId: 888001,
            matchedBy: 'job',
            crossAccount: true,
          },
        },
      },
      {
        toolName: 'request_handoff',
        args: { reasonCode: 'duplicate_signup' },
        result: {
          dispatched: true,
          shortCircuited: true,
          sideEffect: {
            kind: 'general_handoff',
            source: 'agent_tool',
            reasonCode: 'duplicate_signup',
            reason: '核实已有报名',
          },
        },
      },
    ]);
    expect(outcome.kind).toBe('handoff');
    expect(outcome.preHandoffReceipt?.text).toContain('已报过这个岗位');
  });

  it('handoff outcome carries preHandoffReceipt when booking succeeded in the same turn', () => {
    const outcome = classify([
      bookingSuccess,
      {
        toolName: 'request_handoff',
        args: { reasonCode: 'salary_admin_inquiry', reason: '试工问题' },
        result: {
          dispatched: true,
          shortCircuited: true,
          sideEffect: {
            kind: 'general_handoff',
            source: 'agent_tool',
            alertLabel: '岗位口径答不上',
            reasonCode: 'salary_admin_inquiry',
            reason: '试工问题',
          },
        },
      },
    ]);

    expect(outcome.kind).toBe('handoff');
    expect(outcome.preHandoffReceipt).toEqual({
      text: '报名已经提交成功了，面试时间是 8月28日（周五）10:00。',
      sources: ['duliday_interview_booking'],
    });
    expect(outcome.sideEffects).toHaveLength(1);
  });

  it('no receipt when request_handoff is the only committed action', () => {
    const outcome = classify([
      {
        toolName: 'request_handoff',
        args: { reasonCode: 'other', reason: 'x' },
        result: { dispatched: true, shortCircuited: true },
      },
    ]);
    expect(outcome.kind).toBe('handoff');
    expect(outcome.preHandoffReceipt).toBeUndefined();
  });

  it('第二人待提交导致空响应转人工时仍先保留第一人的真实回执', () => {
    const outcome = classifyReviewedOutcome(
      {
        text: '',
        steps: 2,
        agentSteps: [],
        toolCalls: [
          bookingSuccess,
          {
            toolName: 'duliday_interview_precheck',
            args: { jobId: 528546, candidatePhone: '13800000002' },
            result: {
              success: true,
              nextAction: 'confirm_collection',
              candidateScope: 'additional',
            },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        outputDecision: decision,
        resolution: { outcome: 'handoff', source: 'output_guardrail' },
        revised: false,
        recoveryDisposition: {
          outcome: 'handoff',
          reasonCode: 'empty_recovery_pending_submission',
          precheckNextAction: 'confirm_collection',
          jobId: 528546,
          reason: '第二人已确认但未提交，生成无回复',
        },
      },
      sessionRef,
      'msg-multi-candidate',
    );
    expect(outcome.kind).toBe('handoff');
    expect(outcome.preHandoffReceipt).toEqual(buildPreHandoffReceipt([bookingSuccess]));
    expect(outcome.preHandoffReceipt?.text).not.toContain('第二人');
    expect(outcome.sideEffects).toEqual([expect.objectContaining({ kind: 'general_handoff' })]);
  });

  it('gate rejections (booking provenance / modify ownership) never get a receipt', () => {
    const outcome = classify([
      bookingSuccess,
      {
        toolName: 'duliday_modify_interview_time',
        args: { workOrderId: 9 },
        result: {
          success: false,
          errorType: 'modify.work_order_not_in_memory',
          shortCircuited: true,
          gateRejected: true,
          reasonCode: 'modify_appointment',
          workOrderId: 9,
        },
      },
    ]);
    expect(outcome.kind).toBe('handoff');
    expect(outcome.preHandoffReceipt).toBeUndefined();
  });
});
