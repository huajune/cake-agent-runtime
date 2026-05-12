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
    corpId: 'ww-real-corp',
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

  it('sends card with @ for real sessions (isTest=false, atAll=true when no receiver)', async () => {
    const result = await service.notify(buildPayload());

    expect(result).toBe(true);
    expect(mockRenderer.buildCard).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: false, atAll: true }),
    );
    expect(mockPrivateChannel.send).toHaveBeenCalledWith({ kind: 'handoff-card' });
  });

  it('sends card without @ for test-suite sessions (chatId starts with "test-")', async () => {
    const result = await service.notify(
      buildPayload({ chatId: 'test-BC-20260511-q3g3mlzo-20260511073840' }),
    );

    expect(result).toBe(true);
    const arg = mockRenderer.buildCard.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(arg.isTest).toBe(true);
    expect(arg.atUsers).toBeUndefined();
    expect(arg.atAll).toBeUndefined();
    expect(mockPrivateChannel.send).toHaveBeenCalledWith({ kind: 'handoff-card' });
  });

  it('sends card without @ for badcase regression sessions (p2-fixed-* prefix)', async () => {
    const result = await service.notify(
      buildPayload({ chatId: 'p2-fixed-20260512-SCN-20260512-P2-R4-b4bhbjsu' }),
    );

    expect(result).toBe(true);
    const arg = mockRenderer.buildCard.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(arg.isTest).toBe(true);
    expect(arg.atAll).toBeUndefined();
  });

  it('detects test path by corpId (primary signal, regardless of chatId)', async () => {
    const result = await service.notify(
      buildPayload({ corpId: 'test', chatId: 'arbitrary-chat-id-no-prefix' }),
    );

    expect(result).toBe(true);
    const arg = mockRenderer.buildCard.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(arg.isTest).toBe(true);
    expect(arg.atAll).toBeUndefined();
  });

  it('detects debug path by corpId === "debug"', async () => {
    const result = await service.notify(
      buildPayload({ corpId: 'debug', chatId: 'whatever' }),
    );

    expect(result).toBe(true);
    const arg = mockRenderer.buildCard.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(arg.isTest).toBe(true);
  });
});
