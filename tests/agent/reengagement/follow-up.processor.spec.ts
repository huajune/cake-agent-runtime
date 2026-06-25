import { FollowUpProcessor } from '@agent/reengagement/follow-up.processor';
import { REENGAGEMENT_JOB_NAME } from '@agent/reengagement/reengagement.types';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';

const sessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'sess-1' };

const baseState = (over: Partial<AuthoritativeSessionState> = {}): AuthoritativeSessionState => ({
  collectedFields: {},
  recalledJobIds: new Set<number>(),
  hardConstraints: [],
  presentedStores: [],
  stage: null,
  ...over,
});

const makeJob = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'job-1',
    data: {
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
    },
    ...over,
  }) as never;

describe('FollowUpProcessor', () => {
  let queue: { process: jest.Mock; add: jest.Mock };
  let session: { getAuthoritativeState: jest.Mock };
  let runner: { runTurn: jest.Mock };
  let touchLedger: {
    isOverFrequencyLimit: jest.Mock;
    reserve: jest.Mock;
    markDeliveryAttempted: jest.Mock;
    markSent: jest.Mock;
    markFailedOrUnknown: jest.Mock;
  };
  let configService: { get: jest.Mock };
  let delivery: { deliver: jest.Mock };

  beforeEach(() => {
    jest.useRealTimers();
    queue = { process: jest.fn(), add: jest.fn().mockResolvedValue(undefined) };
    session = { getAuthoritativeState: jest.fn().mockResolvedValue(baseState()) };
    runner = { runTurn: jest.fn() };
    touchLedger = {
      isOverFrequencyLimit: jest.fn().mockResolvedValue(false),
      reserve: jest.fn().mockResolvedValue('reserved'),
      markDeliveryAttempted: jest.fn().mockResolvedValue(undefined),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailedOrUnknown: jest.fn().mockResolvedValue(undefined),
    };
    configService = { get: jest.fn().mockReturnValue('true') };
    delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
  });

  const buildProcessor = (withDelivery = true) =>
    new FollowUpProcessor(
      queue as never,
      session as never,
      runner as never,
      touchLedger as never,
      configService as never,
      withDelivery ? (delivery as never) : undefined,
    );

  it('registers the configured follow-up job name', () => {
    buildProcessor().onModuleInit();

    expect(queue.process).toHaveBeenCalledWith(REENGAGEMENT_JOB_NAME, 2, expect.any(Function));
  });

  it('calls runTurnEnd in shadow mode without delivering', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还在考虑吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });
    configService.get.mockReturnValue('true');

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('calls runTurnEnd for skipped outcomes', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    runner.runTurn.mockResolvedValue({
      kind: 'skipped',
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('delivers non-shadow replies through the outbox and then runs turn-end lifecycle', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    configService.get.mockReturnValue('false');
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.reserve).toHaveBeenCalledWith('sess-1:opening_no_reply:1782266400000');
    expect(touchLedger.markDeliveryAttempted).toHaveBeenCalled();
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reply' }), {
      idempotencyKey: 'sess-1:opening_no_reply:1782266400000',
    });
    expect(touchLedger.markSent).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:1782266400000',
      'sess-1',
      now,
    );
    expect(runTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('does not re-deliver duplicate inflight slots and still runs turn-end lifecycle', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    configService.get.mockReturnValue('false');
    touchLedger.reserve.mockResolvedValue('duplicate_inflight');
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.markDeliveryAttempted).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('runs turn-end lifecycle when a duplicate sent slot is skipped', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    configService.get.mockReturnValue('false');
    touchLedger.reserve.mockResolvedValue('duplicate_sent');
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('runs turn-end lifecycle when delivery fails and marks the touch unknown', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    const error = new Error('delivery down');
    configService.get.mockReturnValue('false');
    delivery.deliver.mockRejectedValue(error);
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await expect(buildProcessor().process(makeJob())).rejects.toThrow('delivery down');

    expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:1782266400000',
      'unknown',
    );
    expect(runTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('reschedules directly to the next delivery window when fired outside the window', async () => {
    const now = Date.UTC(2026, 5, 24, 14, 0, 0); // 22:00 Shanghai
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await buildProcessor().process(makeJob({ id: 'late-job' }));

    const expectedFireAt = Date.UTC(2026, 5, 25, 1, 0, 0); // next day 09:00 Shanghai
    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      REENGAGEMENT_JOB_NAME,
      expect.objectContaining({ anchorAt: now }),
      expect.objectContaining({
        jobId: `late-job:rw:${expectedFireAt}`,
        delay: expectedFireAt - now,
      }),
    );
  });
});
