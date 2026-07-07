import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { BookingCardRenderer } from '@notification/renderers/booking-card.renderer';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';

describe('PrivateChatMonitorNotifierService', () => {
  const mockPrivateChatChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockRenderer = {
    buildInterviewBookingCard: jest.fn(),
    buildInterviewCancellationCard: jest.fn(),
  } as unknown as jest.Mocked<BookingCardRenderer>;

  const mockHostingMemberConfig = {
    resolveFeishuReceiver: jest.fn(async (botImId?: string) =>
      botImId ? BOT_TO_RECEIVER[botImId] : undefined,
    ),
  };

  let service: PrivateChatMonitorNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrivateChatChannel.send.mockResolvedValue(true);
    mockRenderer.buildInterviewBookingCard.mockReturnValue({
      isFailure: false,
      card: { kind: 'booking-card' },
    });
    mockRenderer.buildInterviewCancellationCard.mockReturnValue({ kind: 'cancellation-card' });
    service = new PrivateChatMonitorNotifierService(
      mockPrivateChatChannel as never,
      mockRenderer,
      mockHostingMemberConfig as never,
    );
  });

  it('should mention mapped owner when bot id is known', async () => {
    const botImId = '1688855974513959';

    const success = await service.notifyInterviewBookingResult({
      botImId,
      candidateName: '张三',
      phone: '13800000000',
      interviewTime: '2026-04-13 15:00:00',
      toolOutput: { success: true, message: '预约成功' },
    });

    expect(success).toBe(true);
    const payload = mockRenderer.buildInterviewBookingCard.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        atUsers: [BOT_TO_RECEIVER[botImId]],
      }),
    );
    expect(payload).not.toHaveProperty('atAll');
    expect(mockPrivateChatChannel.send).toHaveBeenCalledWith({ kind: 'booking-card' });
  });

  it('should fallback to atAll when bot id is unknown', async () => {
    await service.notifyInterviewBookingResult({
      candidateName: '李四',
      phone: '13900000000',
      interviewTime: '2026-04-13 16:00:00',
      toolOutput: { success: false, error: '门店已满' },
    });

    expect(mockRenderer.buildInterviewBookingCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atAll: true,
      }),
    );
  });

  it('should send interview cancellation notifications to private-chat monitor', async () => {
    const botImId = '1688855974513959';

    const success = await service.notifyInterviewCancellation({
      botImId,
      contactName: 'wx_alice',
      candidateName: '张三',
      phone: '13800000000',
      workOrderId: 123,
      cancelReason: '候选人主动取消',
    });

    expect(success).toBe(true);
    expect(mockRenderer.buildInterviewCancellationCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atUsers: [BOT_TO_RECEIVER[botImId]],
        contactName: 'wx_alice',
        candidateName: '张三',
        workOrderId: 123,
      }),
    );
    expect(mockPrivateChatChannel.send).toHaveBeenCalledWith({ kind: 'cancellation-card' });
  });
});
