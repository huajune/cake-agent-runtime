import { DurableReplyDeliveryService } from '@channels/wecom/message/delivery/durable-reply-delivery.service';
import type { ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import type { ActionCallbacks, ActionIntent } from '@biz/action-execution/action-execution.types';
import type { DeliveryContext } from '@channels/wecom/message/types';

const turn: ReplyTurn = {
  deliveryPolicy: 'single_pass',
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
  recovery: { primary: { orgId: 'corp', imBotId: 'bot', chatId: 'chat' } },
};
const context = {
  token: 'secret',
  imBotId: 'bot',
  chatId: 'chat',
  imContactId: 'user',
  messageId: 'trace',
  replyTurn: turn,
} as DeliveryContext;

describe('ordinary reply segment external-result boundaries', () => {
  const turns = { mode: 'execute', assertDeliveryActive: jest.fn(), open: jest.fn() };
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
    turns.assertDeliveryActive.mockResolvedValue(undefined);
    turns.mode = 'execute';
    executor.execute.mockImplementation(
      async (_intent: ActionIntent, handlers: ActionCallbacks<unknown>) =>
        handlers.dispatch('stable-request', 'execute'),
    );
  });

  it('does not synthesize primary input for a scheduled task', async () => {
    await expect(
      service.resolveTurn({ ...context, replyTurn: undefined, logicalTurnId: 'task-key' }),
    ).rejects.toThrow('delivery_identity_not_persisted');
    expect(turns.open).not.toHaveBeenCalled();
  });
  it.each(['observe', 'off'] as const)('never upgrades a %s identity to execute', async (mode) => {
    await expect(
      service.sendOrdinarySegment({ ...turn, mode }, context, 'first', 0),
    ).rejects.toThrow('ordinary_reply_not_executable');
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it.each(['enterprise', 'group'] as const)(
    'completes %s text on API acceptance without callbacks',
    async (_apiType) => {
      await service.sendOrdinarySegment(turn, { ...context, _apiType }, 'first', 0);
      expect(sender.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { text: 'first' },
          externalRequestId: 'stable-request',
          _apiType,
        }),
      );
      expect(executor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalTurnId: turn.logicalTurnId,
          intentId: 'turn:reply:v1:0',
          parameters: { text: 'first', index: 0, version: 1 },
        }),
        expect.anything(),
        { persistedMode: 'execute' },
      );
    },
  );
  it.each([undefined, {}, { errcode: 500 }])(
    'does not claim acceptance for an unconfirmed response %j',
    async (response) => {
      sender.sendMessage.mockResolvedValue(response);
      await expect(service.sendOrdinarySegment(turn, context, 'first', 0)).rejects.toThrow(
        'reply_send_result_unconfirmed',
      );
      expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    },
  );
  it('does not resend a transport timeout', async () => {
    sender.sendMessage.mockRejectedValue(new Error('timeout'));
    await expect(service.sendOrdinarySegment(turn, context, 'first', 0)).rejects.toThrow(
      'external_call_did_not_return_terminal_evidence',
    );
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each(['unknown', 'executing'])('does not redispatch an existing %s action', async (status) => {
    executor.execute.mockResolvedValue({ status });
    await expect(service.sendOrdinarySegment(turn, context, 'first', 0)).rejects.toThrow(status);
    expect(sender.sendMessage).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
  it('checks both input and chat ownership before sending', async () => {
    const assertOwned = jest.fn().mockRejectedValue(new Error('chat lease lost'));
    await expect(
      service.sendOrdinarySegment(turn, { ...context, assertOwned }, 'first', 0),
    ).rejects.toThrow('chat lease lost');
    expect(sender.sendMessage).not.toHaveBeenCalled();
    turns.assertDeliveryActive.mockRejectedValue(new Error('input expired'));
    await expect(service.sendOrdinarySegment(turn, context, 'first', 0)).rejects.toThrow(
      'input expired',
    );
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
  it('keeps persisted execute identities after runtime rollback to observe', async () => {
    turns.mode = 'observe';
    await service.sendOrdinarySegment(turn, context, 'first', 0);
    expect(executor.execute).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      persistedMode: 'execute',
    });
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('does not resend an already successful action', async () => {
    executor.execute.mockResolvedValue({ status: 'succeeded' });
    await service.sendOrdinarySegment(turn, context, 'first', 0);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
  it('rechecks permission before dispatch and stops on cancellation', async () => {
    permit.evaluate.mockResolvedValue({ allowed: false });
    executor.execute.mockImplementation(
      async (_intent: ActionIntent, handlers: ActionCallbacks<unknown>) => ({
        status: (await handlers.authorize!()) ? 'succeeded' : 'cancelled',
      }),
    );
    await expect(service.sendOrdinarySegment(turn, context, 'first', 0)).rejects.toThrow(
      'cancelled',
    );
    expect(permit.evaluate).toHaveBeenCalledTimes(1);
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
  it('observation calls the legacy sender without adding an external request ID', async () => {
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
  it('registers reconciliation that preserves uncertainty without sending', async () => {
    service.onModuleInit();
    const handlers = registry.register.mock.calls[0][1];
    await expect(handlers.reconcile()).resolves.toMatchObject({
      status: 'unknown',
      evidence: { kind: 'indeterminate', requestTerminated: false },
    });
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
});
