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
