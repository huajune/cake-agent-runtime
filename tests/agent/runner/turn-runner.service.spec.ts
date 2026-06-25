import { TurnRunnerService } from '@agent/runner/turn-runner.service';
import type { AgentRunResult } from '@agent/agent-run.types';

describe('TurnRunnerService.runTurn', () => {
  let generator: { invoke: jest.Mock };
  let service: TurnRunnerService;

  const sessionRef = { corpId: 'c1', userId: 'u1', sessionId: 's1' };

  const makeResult = (over: Partial<AgentRunResult>): AgentRunResult => ({
    text: '',
    steps: 1,
    agentSteps: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...over,
  });

  beforeEach(() => {
    generator = { invoke: jest.fn() };
    service = new TurnRunnerService(generator as never);
  });

  it('proactive turn injects directive + readonly toolMode and returns a reply outcome', async () => {
    generator.invoke.mockResolvedValue(makeResult({ text: '在吗，之前看的岗位还考虑吗？' }));

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive: '提醒候选人开场未回复', scenarioCode: 'opening_no_reply' },
    });

    const params = generator.invoke.mock.calls[0][0];
    expect(params.toolMode).toBe('readonly');
    expect(params.proactiveDirective).toBe('提醒候选人开场未回复');
    expect(params.deferTurnEnd).toBe(true);
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('考虑');
    expect(outcome.scenarioCode).toBe('opening_no_reply');
  });

  it('empty text or skip_reply short-circuit maps to skipped', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({ text: '', toolCalls: [{ toolName: 'skip_reply', args: {}, result: { skipped: true } }] }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive: 'x', scenarioCode: 'opening_no_reply' },
    });

    expect(outcome.kind).toBe('skipped');
  });

  it('request_handoff maps to handoff with alreadyDispatched=true', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '需要人工',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'modify_appointment', reason: '冲突' },
            result: { dispatched: true, shortCircuited: true },
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '帮我改约' },
      context: { messageId: 'm1' },
    });

    expect(outcome.kind).toBe('handoff');
    expect(outcome.handoff?.sourceToolCall).toBe('request_handoff');
    expect(outcome.handoff?.reasonCode).toBe('modify_appointment');
    expect(outcome.handoff?.alreadyDispatched).toBe(true);
    expect(outcome.handoff?.idempotencyKey).toBe('s1:handoff:m1');
  });

  it('booking gate hard-reject maps to handoff with alreadyDispatched=false (outcome-layer dispatch)', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { shortCircuited: true, gateRejected: true, reasonCode: 'job_id_not_recalled' },
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '约面试' },
    });

    expect(outcome.kind).toBe('handoff');
    expect(outcome.handoff?.sourceToolCall).toBe('duliday_interview_booking');
    expect(outcome.handoff?.reasonCode).toBe('job_id_not_recalled');
    expect(outcome.handoff?.alreadyDispatched).toBe(false);
  });

  it('generator failure collapses to skipped (reengagement resilience)', async () => {
    generator.invoke.mockRejectedValue(new Error('messages 为空'));

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive: 'x', scenarioCode: 'opening_no_reply' },
    });

    expect(outcome.kind).toBe('skipped');
    expect(outcome.scenarioCode).toBe('opening_no_reply');
  });
});
