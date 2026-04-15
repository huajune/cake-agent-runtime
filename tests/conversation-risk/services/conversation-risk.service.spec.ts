import { ConversationRiskService } from '@/conversation-risk/services/conversation-risk.service';
import { EnterpriseMessageCallbackDto } from '@/channels/wecom/message/ingress/message-callback.dto';

describe('ConversationRiskService', () => {
  const mockContextService = {
    buildContext: jest.fn(),
  };
  const mockDetectorService = {
    detect: jest.fn(),
    buildLlmReviewSignal: jest.fn(),
  };
  const mockLlmAnalyzerService = {
    analyze: jest.fn(),
  };
  const mockActionService = {
    handleHit: jest.fn(),
  };

  let service: ConversationRiskService;

  const messageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-1',
    token: 'token-1',
    botId: 'bot-1',
    botUserId: 'manager-1',
    imBotId: 'bot-im-1',
    chatId: 'chat-1',
    imContactId: 'contact-1',
    messageType: 'text' as never,
    messageId: 'msg-1',
    timestamp: '1712044800000',
    isSelf: false,
    source: 'mobile_push' as never,
    contactType: 'personal_wechat' as never,
    contactName: '候选人A',
    payload: {
      text: '怎么还不回',
      pureText: '怎么还不回',
    },
  };

  const context = {
    corpId: 'org-1',
    chatId: 'chat-1',
    userId: 'contact-1',
    pauseTargetId: 'chat-1',
    messageId: 'msg-1',
    contactName: '候选人A',
    botImId: 'bot-im-1',
    currentMessageContent: '怎么还不回',
    recentMessages: [
      { role: 'assistant' as const, content: '您好，稍等我查一下。', timestamp: 1712044800000 },
      { role: 'user' as const, content: '在吗', timestamp: 1712044860000 },
      { role: 'user' as const, content: '怎么还不回', timestamp: 1712044920000 },
    ],
    sessionState: null,
  };

  beforeEach(() => {
    service = new ConversationRiskService(
      mockContextService as never,
      mockDetectorService as never,
      mockLlmAnalyzerService as never,
      mockActionService as never,
    );
    jest.clearAllMocks();
    mockContextService.buildContext.mockResolvedValue(context);
    mockDetectorService.detect.mockReturnValue({ hit: false });
    mockDetectorService.buildLlmReviewSignal.mockReturnValue(null);
    mockLlmAnalyzerService.analyze.mockResolvedValue({ hit: false });
    mockActionService.handleHit.mockResolvedValue({
      hit: true,
      paused: true,
      alerted: true,
    });
  });

  it('should handle hard rule hits without calling llm', async () => {
    const detection = {
      hit: true,
      riskType: 'abuse' as const,
      riskLabel: '辱骂/攻击',
      reason: '命中关键词：垃圾',
      analysisMode: 'rules' as const,
    };
    mockDetectorService.detect.mockReturnValue(detection);

    const result = await service.checkAndHandle({
      messageData,
      content: '你们真垃圾',
    });

    expect(mockDetectorService.buildLlmReviewSignal).not.toHaveBeenCalled();
    expect(mockLlmAnalyzerService.analyze).not.toHaveBeenCalled();
    expect(mockActionService.handleHit).toHaveBeenCalledWith(context, detection);
    expect(result).toEqual({
      hit: true,
      paused: true,
      alerted: true,
    });
  });

  it('should run llm analysis for weak signals and handle llm hits', async () => {
    const reviewSignal = {
      suggestedRiskType: 'escalation' as const,
      summary: '候选人近期连续追问，情绪有明显升级趋势',
      reason: '连续追问表达：怎么还不回',
      matchedKeywords: ['怎么还不回'],
      evidenceMessages: context.recentMessages.filter((message) => message.role === 'user'),
    };
    const llmDetection = {
      hit: true,
      riskType: 'escalation' as const,
      riskLabel: '连续质问/情绪升级',
      summary: 'LLM 认为需要人工介入',
      reason: '情绪升级明显',
      analysisMode: 'llm' as const,
    };

    mockDetectorService.buildLlmReviewSignal.mockReturnValue(reviewSignal);
    mockLlmAnalyzerService.analyze.mockResolvedValue(llmDetection);

    await service.checkAndHandle({
      messageData,
      content: '怎么还不回',
    });

    expect(mockLlmAnalyzerService.analyze).toHaveBeenCalledWith(context, reviewSignal);
    expect(mockActionService.handleHit).toHaveBeenCalledWith(context, llmDetection);
  });

  it('should return no hit when there is no hard rule or llm review signal', async () => {
    await expect(
      service.checkAndHandle({
        messageData,
        content: '你好',
      }),
    ).resolves.toEqual({
      hit: false,
      paused: false,
      alerted: false,
    });

    expect(mockLlmAnalyzerService.analyze).not.toHaveBeenCalled();
    expect(mockActionService.handleHit).not.toHaveBeenCalled();
  });
});
