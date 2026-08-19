import { classifyReviewedOutcome } from '@agent/runner/turn-outcome';
import type { SessionRef, TurnTrigger } from '@agent/runner/agent-runner.types';
import type { OutputGuardDecision } from '@agent/guardrail/output/output-guardrail.service';

/**
 * 议题 7-1 的动作形态验收：命中 handoff_promise_reconciliation 时
 * ① 文本原样投递（不进 repair、不改写）；② 挂人工介入 sideEffect，
 * 由 TurnOutcomeInterventionService.commit 在 replay 定局后统一执行。
 */
describe('classifyReviewedOutcome — handoff 承诺补动作（议题 7-1）', () => {
  const sessionRef: SessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'chat-1' };
  const trigger: TurnTrigger = { kind: 'inbound', userMessage: '这个薪资怎么算的' };
  const reply = '我让同事帮你确认下具体算法，稍后联系你哈';

  const decision = (ruleIds: string[]): OutputGuardDecision =>
    ({
      decision: 'pass',
      riskLevel: 'low',
      ruleIds,
      blockedRuleIds: [],
      reasonCode: undefined,
    }) as unknown as OutputGuardDecision;

  const classify = (ruleIds: string[]) =>
    classifyReviewedOutcome(
      {
        text: reply,
        steps: 1,
        agentSteps: [],
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        outputDecision: decision(ruleIds),
        revised: false,
      } as unknown as Parameters<typeof classifyReviewedOutcome>[0],
      trigger,
      sessionRef,
      'msg-1',
    );

  it('attaches a promise_reconciliation handoff intent without touching the reply', () => {
    const outcome = classify(['handoff_promise_reconciliation']);

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(reply);
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        // 运营侧就是一次普通"需人工跟进"，不新开底账分桶；排障区分靠
        // guardrail_review_records 的 handoff_promise_reconciliation ruleId。
        reasonCode: 'other',
        idempotencyKey: 'chat-1:handoff:msg-1',
        recordHandoff: true,
      }),
    ]);
  });

  it('attaches nothing when the rule did not fire', () => {
    const outcome = classify([]);

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(reply);
    expect(outcome.sideEffects).toEqual([]);
  });
});
