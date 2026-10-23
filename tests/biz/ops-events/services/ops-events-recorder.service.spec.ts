import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';

describe('OpsEventsRecorderService', () => {
  const repository = {
    upsertOpsEvent: jest.fn(),
    checkAndRecordFirstEngaged: jest.fn(),
    openingLogicalTurn: jest.fn(),
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

  it('preserves an opening identity after its event committed and dependent scheduling must retry', async () => {
    const service = new OpsEventsRecorderService(
      repository as never,
      botGroupResolver as never,
      { add: jest.fn() } as never,
      { report: jest.fn() } as never,
    );
    const input = {
      corpId: 'corp',
      chatId: 'chat',
      eventName: 'agent.opening_sent' as const,
      idempotencyKey: 'chat:opening',
      occurredAt: new Date('2026-10-21T00:00:00Z'),
    };
    repository.upsertOpsEvent.mockResolvedValue('duplicate');
    repository.openingLogicalTurn.mockResolvedValue('original-turn');
    await expect(service.recordOpeningDurably(input, 'original-turn')).resolves.toBe(true);
    await expect(service.recordOpeningDurably(input, 'new-turn')).resolves.toBe(false);
    repository.openingLogicalTurn.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(service.recordOpeningDurably(input, 'original-turn')).rejects.toThrow(
      'read unavailable',
    );
  });

  it('does not classify or continue local opening writes after ownership is lost', async () => {
    const service = new OpsEventsRecorderService(
      repository as never,
      botGroupResolver as never,
      { add: jest.fn() } as never,
      { report: jest.fn() } as never,
    );
    await expect(
      service.recordOpeningDurably(
        {
          corpId: 'corp',
          chatId: 'chat',
          eventName: 'agent.opening_sent',
          idempotencyKey: 'chat:opening',
          occurredAt: new Date(),
        },
        'turn',
        {
          assertOwned: async () => {
            throw new Error('lost lease');
          },
        },
      ),
    ).rejects.toThrow('lost lease');
    expect(repository.upsertOpsEvent).not.toHaveBeenCalled();
  });

  it('enriches bot manager/group and returns detailed insert state', async () => {
    const occurredAt = new Date('2026-06-05T03:00:00.000Z');
    const service = new OpsEventsRecorderService(
      repository as never,
      botGroupResolver as never,
      { add: jest.fn() } as never,
      { report: jest.fn() } as never,
    );

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
    const service = new OpsEventsRecorderService(
      repository as never,
      botGroupResolver as never,
      { add: jest.fn() } as never,
      { report: jest.fn() } as never,
    );

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
    const service = new OpsEventsRecorderService(
      repository as never,
      botGroupResolver as never,
      { add: jest.fn() } as never,
      { report: jest.fn() } as never,
    );

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
    const service = new OpsEventsRecorderService(
      repository as never,
      botGroupResolver as never,
      { add: jest.fn() } as never,
      { report: jest.fn() } as never,
    );

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
