import { ActionOpsEventService } from '@biz/ops-events/services/action-ops-event.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import type { ActionIntent } from '@biz/action-execution/action-execution.types';

describe('confirmed action historical ops projection', () => {
  const repository = { upsertOpsEvent: jest.fn() };
  const queue = { add: jest.fn() };
  const failures = { report: jest.fn() };
  const recorder = new OpsEventsRecorderService(
    repository as never,
    { resolve: () => null } as never,
    queue as never,
    failures as never,
  );
  const service = new ActionOpsEventService(recorder);
  const intent: ActionIntent = {
    kind: 'sponge.booking',
    corpId: 'corp',
    accountId: 'bot',
    chatId: 'chat',
    logicalTurnId: 'original-turn',
    intentId: 'original-turn',
    target: 'booking:phone:12',
    parameters: { jobId: 12, interviewTime: '2026-10-20 10:00:00' },
    occurredAt: '2026-10-19T15:59:00.000Z',
    identityReliable: true,
    recovery: {
      userId: 'user',
      sessionId: 'chat',
      botImId: 'bot',
      botUserId: 'manager',
      opsEventPayload: {
        brand_name: 'Brand',
        candidate_name: 'Candidate',
        group_invite: { outcome: 'invited' },
      },
    },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    repository.upsertOpsEvent.mockResolvedValue('inserted');
    queue.add.mockResolvedValue({ id: 'persisted' });
  });

  it.each([
    ['sponge.booking', { jobId: 12 }, 'booking.succeeded', '91'],
    ['sponge.cancel', { cancelReasonId: 2 }, 'booking.canceled', '91:canceled'],
    [
      'sponge.modify',
      { newInterviewTime: ' 2026-10-22 09:00:00 ' },
      'booking.interview_modified',
      '91:interview_modified:2026-10-22 09:00:00',
    ],
  ])(
    'replays %s with the original event time and business idempotency',
    async (kind, parameters, eventName, idempotencyKey) => {
      const assertOwned = jest.fn();
      await service.sync(
        { ...intent, kind, parameters: parameters as Record<string, unknown> },
        { success: true, workOrderId: 91 },
        { assertOwned },
      );
      expect(assertOwned).toHaveBeenCalledTimes(1);
      expect(repository.upsertOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName,
          idempotencyKey,
          occurredAt: intent.occurredAt,
          payload: expect.objectContaining({ work_order_id: 91 }),
        }),
        { assertOwned },
      );
    },
  );

  it('does not infer group invitation from booking success', async () => {
    await service.sync(intent, { success: true, workOrderId: 91 });
    expect(repository.upsertOpsEvent.mock.calls[0][0].payload).not.toHaveProperty('group_invite');
    expect(repository.upsertOpsEvent.mock.calls[0][0].payload.brand_name).toBe('Brand');
  });

  it('requires either DB confirmation or acknowledged recovery admission', async () => {
    repository.upsertOpsEvent.mockResolvedValue('failed');
    await expect(service.sync(intent, { success: true, workOrderId: 91 })).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledWith(
      'persist',
      expect.objectContaining({ occurredAt: intent.occurredAt, idempotencyKey: '91' }),
      expect.any(Object),
    );
    queue.add.mockRejectedValue(new Error('redis unavailable'));
    await expect(service.sync(intent, { success: true, workOrderId: 91 })).rejects.toThrow(
      'redis unavailable',
    );
    expect(failures.report).toHaveBeenCalled();
  });

  it('does not write after lease loss or mistake a rejected booking for a success', async () => {
    await expect(
      service.sync(
        intent,
        { success: true, workOrderId: 91 },
        {
          assertOwned: async () => {
            throw new Error('lease lost');
          },
        },
      ),
    ).rejects.toThrow('lease lost');
    await service.sync(intent, { success: false });
    expect(repository.upsertOpsEvent).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rechecks ownership before recovery admission after a database failure', async () => {
    repository.upsertOpsEvent.mockResolvedValue('failed');
    const assertOwned = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lease lost during database write'));
    await expect(
      service.sync(intent, { success: true, workOrderId: 91 }, { assertOwned }),
    ).rejects.toThrow('lease lost during database write');
    expect(repository.upsertOpsEvent).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps base and later invitation recovery jobs distinct without changing event identity', async () => {
    repository.upsertOpsEvent.mockResolvedValue('failed');
    await service.sync(intent, { success: true, workOrderId: 91 });
    await recorder.recordEventDurably({
      ...repository.upsertOpsEvent.mock.calls[0][0],
      payload: { work_order_id: 91, group_invite: { outcome: 'invited', success: true } },
    });
    expect(queue.add.mock.calls[0][2].jobId).not.toBe(queue.add.mock.calls[1][2].jobId);
    expect(queue.add.mock.calls[0][1].idempotencyKey).toBe(
      queue.add.mock.calls[1][1].idempotencyKey,
    );
    expect(queue.add.mock.calls[1][1].occurredAt).toBe(intent.occurredAt);
  });
});
