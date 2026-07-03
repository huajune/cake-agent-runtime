import { NewCustomerCallbackService } from '@wecom/customer/new-customer-callback.service';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { BotService } from '@wecom/bot/bot.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('NewCustomerCallbackService', () => {
  let recordEvent: jest.Mock;
  let resolveCorpIdByImBotId: jest.Mock;
  let service: NewCustomerCallbackService;

  beforeEach(() => {
    recordEvent = jest.fn().mockResolvedValue(true);
    // 服务按 imBotId 查 bot 所属企业 corpId（查不到回退 'default'）
    resolveCorpIdByImBotId = jest.fn().mockResolvedValue('default');
    service = new NewCustomerCallbackService(
      { recordEvent } as unknown as OpsEventsRecorderService,
      { resolveCorpIdByImBotId } as unknown as BotService,
    );
  });

  const basePayload = {
    imContactId: '78813xxx6927825',
    name: 'test_name',
    createTimestamp: 1705580628000,
    imInfo: { externalUserId: 'wmrRhyxxx', followUser: { wecomUserId: 'huakaifugui' } },
    botInfo: { botId: '657fbxxx', imBotId: '168885xxx', name: '花开富贵', avatar: 'x' },
  };

  it('扁平报文 → friend.added，幂等键/userId/occurredAt/botImId 映射正确', async () => {
    service.handleNewCustomer(basePayload);
    await flush();

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'friend.added',
        idempotencyKey: '78813xxx6927825:friend_added',
        userId: '78813xxx6927825',
        botImId: '168885xxx',
        managerName: '花开富贵',
        occurredAt: new Date(1705580628000),
        chatId: null,
      }),
    );
  });

  it('兼容带外层 data 的报文', async () => {
    service.handleNewCustomer({ data: basePayload });
    await flush();

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '78813xxx6927825', eventName: 'friend.added' }),
    );
  });

  it('缺 imContactId → 不记事件', async () => {
    service.handleNewCustomer({ name: 'x', botInfo: { imBotId: 'b' } });
    await flush();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('缺/非法 createTimestamp → occurredAt 留空（由 recorder 取当前时间）', async () => {
    service.handleNewCustomer({ ...basePayload, createTimestamp: 0 });
    await flush();
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: undefined }));
  });

  it('与消息路径共用幂等键 `${imContactId}:friend_added`（保证去重 + cohort join）', async () => {
    service.handleNewCustomer(basePayload);
    await flush();
    const arg = recordEvent.mock.calls[0][0];
    expect(arg.idempotencyKey).toBe(`${basePayload.imContactId}:friend_added`);
    expect(arg.userId).toBe(basePayload.imContactId);
  });
});
