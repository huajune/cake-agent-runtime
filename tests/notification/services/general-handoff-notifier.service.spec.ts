import { GeneralHandoffCardRenderer } from '@notification/renderers/general-handoff-card.renderer';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import type { GeneralHandoffNotificationPayload } from '@notification/types/general-handoff-notification.types';

describe('GeneralHandoffNotifierService', () => {
  const mockPrivateChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockRenderer = {
    buildCard: jest.fn(),
  } as unknown as jest.Mocked<GeneralHandoffCardRenderer>;

  let service: GeneralHandoffNotifierService;

  const buildPayload = (
    overrides: Partial<GeneralHandoffNotificationPayload> = {},
  ): GeneralHandoffNotificationPayload => ({
    alertLabel: '其他需人工处理场景',
    reason: '测试原因',
    chatId: 'real-chat-id',
    pausedUserId: 'paused-user',
    currentMessageContent: '我有前科可以吗',
    recentMessages: [],
    sessionState: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrivateChannel.send.mockResolvedValue(true);
    mockRenderer.buildCard.mockReturnValue({ kind: 'handoff-card' });
    service = new GeneralHandoffNotifierService(mockPrivateChannel as never, mockRenderer);
  });

  it('sends card via private chat channel for real sessions', async () => {
    const result = await service.notify(buildPayload());

    expect(result).toBe(true);
    expect(mockRenderer.buildCard).toHaveBeenCalled();
    expect(mockPrivateChannel.send).toHaveBeenCalledWith({ kind: 'handoff-card' });
  });

  it('skips Feishu webhook for test-suite sessions (chatId starts with "test-")', async () => {
    const result = await service.notify(
      buildPayload({ chatId: 'test-BC-20260511-q3g3mlzo-20260511073840' }),
    );

    expect(result).toBe(true);
    expect(mockRenderer.buildCard).not.toHaveBeenCalled();
    expect(mockPrivateChannel.send).not.toHaveBeenCalled();
  });
});
