import { OpsEventsRecorderService } from '@biz/ops-events/ops-events-recorder.service';

describe('OpsEventsRecorderService', () => {
  const repository = {
    upsertOpsEvent: jest.fn(),
    checkAndRecordFirstEngaged: jest.fn(),
  };
  const botGroupResolver = {
    resolve: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repository.upsertOpsEvent.mockResolvedValue('inserted');
    repository.checkAndRecordFirstEngaged.mockResolvedValue({
      messageRecorded: true,
      engaged: true,
    });
    botGroupResolver.resolve.mockReturnValue({
      managerName: 'LiYuHang',
      groupName: '宇航组',
    });
  });

  it('enriches bot manager/group and returns detailed insert state', async () => {
    const occurredAt = new Date('2026-06-05T03:00:00.000Z');
    const service = new OpsEventsRecorderService(repository as never, botGroupResolver as never);

    await expect(
      service.recordEventDetailed({
        corpId: 'corp-1',
        eventName: 'booking.succeeded',
        idempotencyKey: 'wo-1',
        occurredAt,
        botImId: 'bot-1',
        managerName: 'stale-manager',
        groupName: 'stale-group',
        userId: 'user-1',
        chatId: 'chat-1',
      }),
    ).resolves.toBe('inserted');

    expect(repository.upsertOpsEvent).toHaveBeenCalledWith({
      corpId: 'corp-1',
      eventName: 'booking.succeeded',
      idempotencyKey: 'wo-1',
      occurredAt,
      botImId: 'bot-1',
      managerName: 'LiYuHang',
      groupName: '宇航组',
      userId: 'user-1',
      chatId: 'chat-1',
    });
  });

  it('keeps caller manager/group when the bot resolver misses', async () => {
    botGroupResolver.resolve.mockReturnValueOnce(null);
    const service = new OpsEventsRecorderService(repository as never, botGroupResolver as never);

    await service.recordEvent({
      corpId: 'corp-1',
      eventName: 'job.recommended',
      idempotencyKey: 'trace-1',
      botImId: 'unknown-bot',
      managerName: 'fallback-manager',
      groupName: 'fallback-group',
    });

    expect(repository.upsertOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        managerName: 'fallback-manager',
        groupName: 'fallback-group',
      }),
    );
  });

  it('records candidate messages with enriched bot metadata', async () => {
    const service = new OpsEventsRecorderService(repository as never, botGroupResolver as never);

    await expect(
      service.recordCandidateMessage({
        corpId: 'corp-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        botImId: 'bot-1',
      }),
    ).resolves.toEqual({ messageRecorded: true, engaged: true });

    expect(repository.checkAndRecordFirstEngaged).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
        managerName: 'LiYuHang',
        groupName: '宇航组',
      }),
    );
  });

  it('returns failed/empty results instead of throwing when repository calls fail', async () => {
    repository.upsertOpsEvent.mockRejectedValueOnce(new Error('rpc down'));
    repository.checkAndRecordFirstEngaged.mockRejectedValueOnce(new Error('rpc down'));
    const service = new OpsEventsRecorderService(repository as never, botGroupResolver as never);

    await expect(
      service.recordEventDetailed({
        corpId: 'corp-1',
        eventName: 'agent.replied',
        idempotencyKey: 'trace-1',
      }),
    ).resolves.toBe('failed');
    await expect(
      service.recordCandidateMessage({
        corpId: 'corp-1',
        chatId: 'chat-1',
        messageId: 'msg-1',
      }),
    ).resolves.toEqual({ messageRecorded: false, engaged: false });
  });
});
