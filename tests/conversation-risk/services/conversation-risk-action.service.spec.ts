import { ConversationRiskActionService } from '@/conversation-risk/services/conversation-risk-action.service';
import type {
  ConversationRiskContext,
  ConversationRiskDetectionResult,
} from '@/conversation-risk/types/conversation-risk.types';

describe('ConversationRiskActionService', () => {
  const mockUserHostingService = {
    isUserPaused: jest.fn(),
    pauseUser: jest.fn(),
  };
  const mockNotifierService = {
    notifyConversationRisk: jest.fn(),
  };

  let service: ConversationRiskActionService;

  const context: ConversationRiskContext = {
    corpId: 'corp-1',
    chatId: 'chat-1',
    userId: 'user-1',
    pauseTargetId: 'chat-1',
    messageId: 'msg-1',
    contactName: '候选人A',
    botImId: 'bot-im-1',
    currentMessageContent: '你们什么意思',
    recentMessages: [],
    sessionState: null,
  };

  const detection: ConversationRiskDetectionResult = {
    hit: true,
    riskType: 'complaint_risk',
    riskLabel: '投诉/举报风险',
    reason: '候选人明确表达投诉意向',
    summary: '需要人工介入处理',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ConversationRiskActionService(
      mockUserHostingService as never,
      mockNotifierService as never,
    );
    mockUserHostingService.isUserPaused.mockResolvedValue(false);
    mockUserHostingService.pauseUser.mockResolvedValue(undefined);
    mockNotifierService.notifyConversationRisk.mockResolvedValue(true);
  });

  it('should skip pause and alert when pause target is missing', async () => {
    const result = await service.handleHit(
      {
        ...context,
        pauseTargetId: '' as never,
      },
      detection,
    );

    expect(result).toEqual({
      hit: true,
      paused: false,
      alerted: false,
      reason: detection.reason,
    });
    expect(mockUserHostingService.pauseUser).not.toHaveBeenCalled();
    expect(mockNotifierService.notifyConversationRisk).not.toHaveBeenCalled();
  });

  it('should return already-paused when target is already paused', async () => {
    mockUserHostingService.isUserPaused.mockResolvedValue(true);

    const result = await service.handleHit(context, detection);

    expect(result).toEqual({
      hit: true,
      paused: false,
      alerted: false,
      reason: 'already-paused',
    });
    expect(mockUserHostingService.pauseUser).not.toHaveBeenCalled();
    expect(mockNotifierService.notifyConversationRisk).not.toHaveBeenCalled();
  });

  it('should pause and notify on first hit', async () => {
    const result = await service.handleHit(context, detection);

    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('chat-1');
    expect(mockNotifierService.notifyConversationRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        pausedUserId: 'chat-1',
        riskLabel: '投诉/举报风险',
      }),
    );
    expect(result).toEqual({
      hit: true,
      paused: true,
      alerted: true,
      reason: detection.reason,
    });
  });

  it('should dedupe repeated alerts within the alert window', async () => {
    await service.handleHit(context, detection);
    mockUserHostingService.isUserPaused.mockResolvedValue(false);

    const result = await service.handleHit(context, detection);

    expect(mockUserHostingService.pauseUser).toHaveBeenCalledTimes(2);
    expect(mockNotifierService.notifyConversationRisk).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      hit: true,
      paused: true,
      alerted: false,
      deduped: true,
      reason: detection.reason,
    });
  });
});
