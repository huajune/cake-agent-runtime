import { classifyReviewedOutcome } from '@agent/runner/turn-outcome';
import type { SessionRef, TurnTrigger } from '@agent/runner/agent-runner.types';
import type { OutputGuardDecision } from '@agent/guardrail/output/output-guardrail.service';

/**
 * 终态 side-effect 对账验收：回复明确承诺人工跟进时
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

  const classify = (toolCalls: unknown[] = []) =>
    classifyReviewedOutcome(
      {
        text: reply,
        steps: 1,
        agentSteps: [],
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        outputDecision: decision([]),
        revised: false,
      } as unknown as Parameters<typeof classifyReviewedOutcome>[0],
      trigger,
      sessionRef,
      'msg-1',
    );

  it('attaches a promise_reconciliation handoff intent without touching the reply', () => {
    const outcome = classify();

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(reply);
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        // 运营侧就是一次普通"需人工跟进"，不新开底账分桶。
        reasonCode: 'other',
        idempotencyKey: 'chat-1:handoff:msg-1',
        recordHandoff: true,
      }),
    ]);
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
});
