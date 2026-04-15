import { ConversationRiskContextService } from '@/conversation-risk/services/conversation-risk-context.service';

describe('ConversationRiskContextService', () => {
  const mockChatSessionService = {
    getChatHistory: jest.fn(),
  };
  const mockSessionService = {
    getSessionState: jest.fn(),
  };

  let service: ConversationRiskContextService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ConversationRiskContextService(
      mockChatSessionService as never,
      mockSessionService as never,
    );
    mockChatSessionService.getChatHistory.mockResolvedValue([
      {
        role: 'assistant',
        content: '您好',
        timestamp: 1712044800000,
        ignored: 'field',
      },
      {
        role: 'user',
        content: '我要投诉',
        timestamp: 1712044860000,
      },
    ]);
    mockSessionService.getSessionState.mockResolvedValue({ facts: { city: '上海' } });
  });

  it('should build context with recent messages and session state', async () => {
    const result = await service.buildContext({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      pauseTargetId: 'chat-1',
      messageId: 'msg-1',
      contactName: '候选人A',
      botImId: 'bot-im-1',
      currentMessageContent: '我要投诉',
    });

    expect(mockChatSessionService.getChatHistory).toHaveBeenCalledWith('chat-1', 10);
    expect(mockSessionService.getSessionState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1');
    expect(result).toEqual({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      pauseTargetId: 'chat-1',
      messageId: 'msg-1',
      contactName: '候选人A',
      botImId: 'bot-im-1',
      currentMessageContent: '我要投诉',
      recentMessages: [
        { role: 'assistant', content: '您好', timestamp: 1712044800000 },
        { role: 'user', content: '我要投诉', timestamp: 1712044860000 },
      ],
      sessionState: { facts: { city: '上海' } },
    });
  });
});
