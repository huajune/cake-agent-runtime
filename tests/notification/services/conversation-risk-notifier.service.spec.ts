import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { ConversationRiskCardRenderer } from '@notification/renderers/conversation-risk-card.renderer';
import { ConversationRiskNotifierService } from '@notification/services/conversation-risk-notifier.service';

describe('ConversationRiskNotifierService', () => {
  const mockPrivateChatChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockRenderer = {
    buildConversationRiskCard: jest.fn(),
  } as unknown as jest.Mocked<ConversationRiskCardRenderer>;

  let service: ConversationRiskNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrivateChatChannel.send.mockResolvedValue(true);
    mockRenderer.buildConversationRiskCard.mockReturnValue({ kind: 'risk-card' });
    service = new ConversationRiskNotifierService(mockPrivateChatChannel as never, mockRenderer);
  });

  it('should mention mapped owner when bot id is known', async () => {
    const botImId = '1688855974513959';

    const success = await service.notifyConversationRisk({
      botImId,
      riskLabel: '辱骂/攻击',
      summary: '候选人出现辱骂表达',
      reason: '命中关键词：垃圾',
      contactName: '张三',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      currentMessageContent: '你们真垃圾',
      recentMessages: [],
      sessionState: null,
    });

    expect(success).toBe(true);
    expect(mockRenderer.buildConversationRiskCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atUsers: [BOT_TO_RECEIVER[botImId]],
      }),
    );
    expect(mockPrivateChatChannel.send).toHaveBeenCalledWith({ kind: 'risk-card' });
  });

  it('should fallback to atAll when bot id is unknown', async () => {
    await service.notifyConversationRisk({
      riskLabel: '连续质问/情绪升级',
      summary: '候选人连续追问',
      reason: '连续追问表达：在吗、怎么还不回',
      contactName: '李四',
      chatId: 'chat-234',
      pausedUserId: 'chat-234',
      currentMessageContent: '怎么还不回',
      recentMessages: [],
      sessionState: null,
    });

    expect(mockRenderer.buildConversationRiskCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atAll: true,
      }),
    );
  });
});
