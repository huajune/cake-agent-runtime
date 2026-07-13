import { ReengagementDeliveryService } from '@agent/reengagement/follow-up.processor';

describe('ReengagementDeliveryService', () => {
  const delivery = {
    deliverReply: jest.fn().mockResolvedValue({
      success: true,
      segmentCount: 1,
      failedSegments: 0,
      deliveredSegments: 1,
      totalTime: 0,
    }),
  };
  const botService = {
    getConfiguredBotList: jest.fn().mockResolvedValue([{ wxid: 'bot-1' }]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    botService.getConfiguredBotList.mockResolvedValue([{ wxid: 'bot-1' }]);
  });

  const service = () => new ReengagementDeliveryService(delivery as never, botService as never);

  it('uses the passive message delivery pipeline without duplicate monitoring', async () => {
    await service().deliver(
      {
        kind: 'reply',
        reply: { text: '你方便发下位置吗？' },
        generatedText: '你方便发下位置吗？',
        toolCalls: [],
      },
      {
        idempotencyKey: 'sess-1:opening_no_reply:1000',
        context: {
          token: 'token-1',
          imBotId: 'bot-1',
          imContactId: 'contact-1',
          imRoomId: '',
          contactName: '张三',
          messageId: 'batch-1',
          chatId: 'sess-1',
          _apiType: 'enterprise',
        },
      },
    );

    expect(delivery.deliverReply).toHaveBeenCalledWith(
      { content: '你方便发下位置吗？', reasoning: undefined },
      expect.objectContaining({ chatId: 'sess-1', imContactId: 'contact-1' }),
      false,
    );
  });

  it('rejects non-reply outcomes and missing delivery context', async () => {
    await expect(
      service().deliver({ kind: 'skipped', toolCalls: [], generatedText: 'skip' } as never, {
        context: {
          token: 'token-1',
          imBotId: 'bot-1',
          imContactId: 'contact-1',
          imRoomId: '',
          contactName: '张三',
          messageId: 'batch-1',
          chatId: 'sess-1',
        },
      }),
    ).rejects.toThrow('reengagement_delivery_non_reply:skipped');

    await expect(
      service().deliver(
        { kind: 'reply', reply: { text: 'hi' }, toolCalls: [] },
        { context: undefined },
      ),
    ).rejects.toThrow('reengagement_delivery_missing_context');
  });

  it('skips delivery when the receiving bot is no longer hosted', async () => {
    botService.getConfiguredBotList.mockResolvedValue([]);

    const result = await service().deliver(
      { kind: 'reply', reply: { text: '还在找工作吗？' }, toolCalls: [] },
      {
        context: {
          token: 'token-1',
          imBotId: 'bot-1',
          imContactId: 'contact-1',
          imRoomId: '',
          contactName: '张三',
          messageId: 'batch-1',
          chatId: 'sess-1',
        },
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ skipped: true, skipReason: 'receiving_bot_not_hosted' }),
    );
    expect(delivery.deliverReply).not.toHaveBeenCalled();
  });

  it('fails closed when the receiving bot hosting lookup fails', async () => {
    botService.getConfiguredBotList.mockRejectedValue(new Error('hosting api unavailable'));

    const result = await service().deliver(
      { kind: 'reply', reply: { text: '还在找工作吗？' }, toolCalls: [] },
      {
        context: {
          token: 'token-1',
          imBotId: 'bot-1',
          imContactId: 'contact-1',
          imRoomId: '',
          contactName: '张三',
          messageId: 'batch-1',
          chatId: 'sess-1',
        },
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ skipped: true, skipReason: 'receiving_bot_not_hosted' }),
    );
    expect(delivery.deliverReply).not.toHaveBeenCalled();
  });
});
