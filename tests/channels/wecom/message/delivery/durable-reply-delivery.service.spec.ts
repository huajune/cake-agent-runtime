import { DurableReplyDeliveryService } from '@channels/wecom/message/delivery/durable-reply-delivery.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import type { ActionCallbacks, ActionIntent } from '@biz/action-execution/action-execution.types';
import type { DeliveryContext } from '@channels/wecom/message/types';

const turn: ReplyTurn = {
  corpId: 'corp',
  accountId: 'bot',
  chatId: 'chat',
  logicalTurnId: 'turn',
  inputIds: ['a', 'b'],
  inputOccurredAt: '2026-10-21T04:00:00Z',
  mode: 'execute',
  status: 'planned',
  owner: 'owner',
  fence: 1,
  plan: {
    version: 1,
    text: 'first\nsecond\nthird',
    segments: [0, 1, 2].map((index) => ({
      index,
      text: ['first', 'second', 'third'][index],
      actionId: `a${index}`,
      requestId: `r${index}`,
    })),
  },
  recovery: {},
};
const context = {
  token: 'secret',
  imBotId: 'bot',
  chatId: 'chat',
  imContactId: 'user',
  messageId: 'trace',
  replyTurn: turn,
} as DeliveryContext;

describe('reply segment external-result boundaries', () => {
  const turns = { mode: 'execute', savePlan: jest.fn(), open: jest.fn() };
  const executor = { execute: jest.fn() };
  const registry = { register: jest.fn() };
  const permit = { evaluate: jest.fn() };
  const sender = { sendMessage: jest.fn() };
  const service = new DurableReplyDeliveryService(
    turns as never,
    executor as never,
    registry as never,
    permit as never,
    sender as never,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    permit.evaluate.mockResolvedValue({ allowed: true });
    sender.sendMessage.mockResolvedValue({ errcode: 0 });
    turns.mode = 'execute';
  });

  it('accepts an old booking anchor with a fresh frozen schedule and preserves the same action fingerprint', async () => {
    const due = Date.now() - 1000;
    const oldAnchor = new Date(due - 7 * 86400_000).toISOString();
    const taskRecovery = {
      kind: 'reengagement' as const,
      data: { jobData: { dispatchDueAt: due } },
    };
    const persisted = {
      ...turn,
      inputOccurredAt: oldAnchor,
      recovery: { task: taskRecovery },
      plan: null,
    };
    turns.open.mockResolvedValue(persisted);
    expect(
      await service.resolveTurn({
        ...context,
        replyTurn: undefined,
        corpId: 'corp',
        logicalTurnId: 'task-key',
        inputOccurredAt: oldAnchor,
        taskRecovery,
      }),
    ).toEqual(persisted);
    turns.savePlan.mockImplementation(async (value, plan) => ({ ...value, plan }));
    const frozen = await service.prepare(persisted, 'same text', ['same text']);
    executor.execute.mockImplementation(async (intent: ActionIntent) => {
      expect(intent.occurredAt).toBe(oldAnchor);
      expect(intent.recoveryWindowStartedAt).toBe(new Date(due).toISOString());
      const { identifyAction } = await import('@biz/action-execution/action-identity');
      expect(identifyAction(intent).actionId).toBe(frozen.plan!.segments[0].actionId);
      return { status: 'succeeded' };
    });
    await service.deliver(frozen, context);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, Date.now() - 25 * 3600_000, Date.now() + 120_000])(
    'refuses to create a new execute plan without a current original due time (%s)',
    async (due) => {
      await expect(
        service.resolveTurn({
          ...context,
          replyTurn: undefined,
          corpId: 'corp',
          logicalTurnId: 'task-key',
          inputOccurredAt: new Date(Date.now() - 7 * 86400_000).toISOString(),
          taskRecovery: { kind: 'reengagement', data: { jobData: { dispatchDueAt: due } } },
        }),
      ).rejects.toThrow('task_dispatch_window_unconfirmed_or_expired');
      expect(turns.open).not.toHaveBeenCalled();
      expect(sender.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('observation preserves old admission when legacy jobs lack the frozen schedule', async () => {
    turns.mode = 'observe';
    await service.resolveTurn({
      ...context,
      replyTurn: undefined,
      corpId: 'corp',
      logicalTurnId: 'task-key',
      inputOccurredAt: turn.inputOccurredAt,
      taskRecovery: { kind: 'reengagement', data: { jobData: {} } },
    });
    expect(turns.open).toHaveBeenCalled();
  });

  it('retains a successful first segment and stops at unknown second without reaching third', async () => {
    executor.execute
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce({ status: 'unknown' });
    await expect(service.deliver(turn, context)).rejects.toBeInstanceOf(ReplyDeferredError);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
  it('platform acceptance is pending, uses the registered request ID and does not send the next segment', async () => {
    executor.execute.mockImplementation(
      async (_intent: ActionIntent, handlers: ActionCallbacks<unknown>) => {
        const result = await handlers.dispatch('stable-provider-request', 'execute');
        return { ...result, dispatched: true };
      },
    );
    await expect(service.deliver(turn, context)).rejects.toThrow('segment_0_executing');
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRequestId: 'stable-provider-request',
        payload: { text: 'first' },
      }),
    );
  });
  it('recovery uses the frozen version even when the caller supplies newly generated text', async () => {
    expect(await service.prepare(turn, 'changed', ['changed'])).toBe(turn);
    expect(turns.savePlan).not.toHaveBeenCalled();
  });
  it('does not dispatch when the plan write is unconfirmed', async () => {
    turns.savePlan.mockRejectedValue(new ReplyDeferredError('plan_not_confirmed'));
    await expect(service.prepare({ ...turn, plan: null }, 'first', ['first'])).rejects.toThrow(
      'plan_not_confirmed',
    );
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it('returns completed only from terminal evidence of all segments', async () => {
    executor.execute.mockResolvedValue({ status: 'succeeded' });
    expect(await service.deliver(turn, context)).toMatchObject({
      deliveredSegments: 3,
      success: true,
    });
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
  it('rechecks the shared permit at the dispatch boundary', async () => {
    permit.evaluate.mockResolvedValue({ allowed: false });
    executor.execute.mockImplementation(
      async (_intent: ActionIntent, handlers: ActionCallbacks<unknown>) => ({
        status: (await handlers.authorize!()) ? 'succeeded' : 'cancelled',
      }),
    );
    expect(await service.deliver(turn, context)).toMatchObject({
      skipped: true,
      deliveredSegments: 0,
    });
    expect(permit.evaluate).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
  it('observation calls the old sender without adding a new provider request ID', async () => {
    executor.execute.mockImplementation(
      async (_intent: ActionIntent, handlers: ActionCallbacks<unknown>) => ({
        ...(await handlers.dispatch('must-not-be-added', 'observe')),
        dispatched: true,
      }),
    );
    const legacy = jest.fn().mockResolvedValue(undefined);
    await service.observeLegacy(context, 'original', 0, legacy);
    expect(legacy).toHaveBeenCalledWith();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it('repairs a confirmed permission cancellation after an interrupted claim and cancels later segments', async () => {
    executor.execute
      .mockResolvedValueOnce({
        status: 'failed',
        evidence: {
          kind: 'definitive_no_effect',
          requestTerminated: true,
          detail: 'permission_changed_before_dispatch',
        },
      })
      .mockImplementation(async (_intent: ActionIntent, handlers: ActionCallbacks<unknown>) => ({
        status: (await handlers.authorize!()) ? 'succeeded' : 'cancelled',
      }));
    expect(await service.deliver(turn, context)).toMatchObject({
      skipped: true,
      deliveredSegments: 0,
    });
    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(permit.evaluate).not.toHaveBeenCalled();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'indeterminate', requestTerminated: false },
    { kind: 'definitive_no_effect', requestTerminated: true, detail: 'provider_rejected' },
  ])('does not treat other failed evidence as a local cancellation: %j', async (evidence) => {
    executor.execute.mockResolvedValue({ status: 'failed', evidence });
    await expect(service.deliver(turn, context)).rejects.toThrow('segment_0_failed');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
});
