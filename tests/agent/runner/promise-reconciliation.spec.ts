import { classifyReviewedOutcome } from '@agent/runner/turn-outcome';
import type { SessionRef } from '@agent/runner/agent-runner.types';
import type { OutputGuardDecision } from '@agent/guardrail/output/output-guardrail.service';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { TurnLedger } from '@shared-types/turn.types';

/**
 * 终态 side-effect 对账验收：回复明确承诺人工跟进时
 * ① 文本原样投递（不进 repair、不改写）；② 挂人工介入 sideEffect，
 * 由 TurnOutcomeInterventionService.commit 在 replay 定局后统一执行。
 *
 * PRD R5.1 第 2 条：补动作结构化（承诺原句 / 候选人原话 / 焦点岗位 / 工单 / 阶段 /
 * 按触发工具给原因码）；完成时陈述不算承诺。「未投递不补」在渠道侧按 origin 过滤（见
 * reply-workflow.service.spec）。
 */
describe('classifyReviewedOutcome — handoff 承诺补动作（议题 7-1 / PRD R5.1）', () => {
  const sessionRef: SessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'chat-1' };
  const reply = '我让同事帮你确认下具体算法，稍后联系你哈';

  const decision = (ruleIds: string[]): OutputGuardDecision => ({
    decision: 'pass',
    riskLevel: 'low',
    violations: [],
    ruleIds,
    blockedRuleIds: [],
    repairMode: 'rewrite',
    reasonCode: undefined,
  });

  const classify = (
    toolCalls: AgentToolCall[] = [],
    text = reply,
    extra: {
      userMessage?: string;
      turnLedger?: Partial<TurnLedger>;
      memorySnapshot?: { currentStage: string | null; currentFocusJob?: { jobId: number } };
    } = {},
  ) =>
    classifyReviewedOutcome(
      {
        text,
        steps: 1,
        agentSteps: [],
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        outputDecision: decision([]),
        resolution: { outcome: 'reply' },
        revised: false,
        turnLedger: extra.turnLedger as TurnLedger | undefined,
        memorySnapshot: extra.memorySnapshot
          ? {
              currentStage: extra.memorySnapshot.currentStage,
              presentedJobIds: null,
              recommendedJobIds: null,
              sessionFacts: null,
              profileKeys: null,
              currentFocusJob: extra.memorySnapshot.currentFocusJob
                ? { jobId: extra.memorySnapshot.currentFocusJob.jobId, availableDetailFields: [] }
                : null,
            }
          : undefined,
      },
      sessionRef,
      'msg-1',
      { userMessage: extra.userMessage },
    );

  it('attaches a structured promise_reconciliation handoff intent without touching the reply', () => {
    const outcome = classify([], reply, {
      userMessage: '阶梯工资到底怎么算的',
      memorySnapshot: { currentStage: 'job_consulting', currentFocusJob: { jobId: 528572 } },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(reply);
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        origin: 'promise_reconciliation',
        // 没有触发工具时仍落 other，但原因不再是固定模板
        reasonCode: 'other',
        reason:
          '承诺跟进：「我让同事帮你确认下具体算法，稍后联系你哈」｜候选人原话：「阶梯工资到底怎么算的」',
        jobId: 528572,
        stage: 'job_consulting',
        currentMessageContent: '阶梯工资到底怎么算的',
        idempotencyKey: 'chat-1:handoff:msg-1',
        recordHandoff: true,
      }),
    ]);
  });

  it('picks the promising sentence out of a multi-sentence reply', () => {
    const outcome = classify([], '这家不需要试工。试用期的事我让同事帮你确认下。你先把班次选好哈');
    expect(outcome.sideEffects?.[0]).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('承诺跟进：「试用期的事我让同事帮你确认下。」'),
      }),
    );
  });

  it.each([
    '我跟门店确认过了，面试还在的，你按时去就行',
    '已经和同事核实了，这家是月结，次月 15 号发',
    '刚才让店长确认了，明天上午可以面试',
  ])('does not treat a completed-tense statement as a promise: %s', (text) => {
    const outcome = classify([], text);
    expect(outcome.kind).toBe('reply');
    expect(outcome.sideEffects ?? []).toHaveLength(0);
  });

  it('completed statement in one sentence does not shield a real promise in another', () => {
    const outcome = classify(
      [],
      '我跟门店确认过了，面试还在的。宿舍距离我让同事帮你确认下，稍后回你',
    );
    expect(outcome.sideEffects?.[0]).toEqual(
      expect.objectContaining({
        reasonCode: 'other',
        reason: expect.stringContaining('宿舍距离我让同事帮你确认下'),
      }),
    );
  });

  it('derives reasonCode + workOrderId from a failed modify tool call', () => {
    const outcome = classify(
      [
        {
          toolName: 'duliday_modify_interview_time',
          args: { workOrderId: 461196, newInterviewTime: '2026-09-03 14:00' },
          result: { success: false, errorType: 'modify.rejected', apiCode: 500 },
        },
      ],
      '好的，我让同事帮你确认下明天的时间哈，稍等',
    );
    expect(outcome.sideEffects?.[0]).toEqual(
      expect.objectContaining({
        reasonCode: 'modify_appointment',
        workOrderId: 461196,
        reason: expect.stringContaining(
          '触发：duliday_modify_interview_time 失败（modify.rejected）',
        ),
      }),
    );
  });

  it('classifies a booking rejection by the sponge message (duplicate / capacity / system)', () => {
    const booking = (apiMessage: string): AgentToolCall => ({
      toolName: 'duliday_interview_booking',
      args: { jobId: 528546 },
      result: { success: false, errorType: 'booking.rejected', apiMessage },
    });
    expect(classify([booking('用户已报名该岗位或品牌')]).sideEffects?.[0]).toEqual(
      expect.objectContaining({ reasonCode: 'duplicate_signup', jobId: 528546 }),
    );
    expect(classify([booking('报名人数已超出上限')]).sideEffects?.[0]).toEqual(
      expect.objectContaining({ reasonCode: 'booking_capacity_full' }),
    );
    expect(classify([booking('内部错误')]).sideEffects?.[0]).toEqual(
      expect.objectContaining({ reasonCode: 'system_blocked' }),
    );
  });

  it('falls back to the ledger work order when no tool failed', () => {
    const outcome = classify([], reply, {
      turnLedger: { jobs: { resolvedWorkOrderId: 459406 } } as unknown as Partial<TurnLedger>,
    });
    expect(outcome.sideEffects?.[0]).toEqual(
      expect.objectContaining({ reasonCode: 'other', workOrderId: 459406 }),
    );
  });

  it('attaches nothing when a successful handoff action already exists', () => {
    const outcome = classify([
      {
        toolName: 'request_handoff',
        args: { reasonCode: 'other' },
        result: { dispatched: true },
      },
    ]);

    expect(outcome.kind).toBe('handoff');
    expect(outcome.sideEffects).toHaveLength(1);
  });

  it('attaches nothing when a failed cancel/modify tool already carries its own handoff sideEffect', () => {
    const outcome = classify(
      [
        {
          toolName: 'duliday_cancel_work_order',
          args: { workOrderId: 123 },
          result: {
            success: false,
            errorType: 'cancel.rejected',
            sideEffect: {
              kind: 'general_handoff',
              source: 'agent_tool',
              origin: 'tool_failure',
              alertLabel: '改约/取消自助失败',
              reasonCode: 'modify_appointment',
              reason: '自助取消失败',
              workOrderId: 123,
              recordHandoff: true,
            },
          },
        },
      ],
      '这次取消我这边暂时处理不了，已经转给同事跟进，稍后会联系你',
    );

    expect(outcome.kind).toBe('reply');
    // 只有工具自带的那一份介入，没有对账再补一份
    expect(outcome.sideEffects).toHaveLength(1);
    expect(outcome.sideEffects?.[0]).toEqual(
      expect.objectContaining({ origin: 'tool_failure', reasonCode: 'modify_appointment' }),
    );
  });
});
