import { PreAgentRiskInterceptService } from '@wecom/message/application/pre-agent-risk-intercept.service';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';
import type { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';

describe('PreAgentRiskInterceptService', () => {
  const detector = { detect: jest.fn() };
  const interventionService = { dispatch: jest.fn() };
  const chatSessionService = { getChatHistory: jest.fn() };
  const sessionService = { getSessionState: jest.fn() };

  let service: PreAgentRiskInterceptService;

  const message: EnterpriseMessageCallbackDto = {
    orgId: 'org-1',
    token: 'tk-1',
    botId: 'bot-1',
    botUserId: 'mgr-bob',
    imBotId: 'wxid-bot',
    chatId: 'chat-1',
    messageType: MessageType.TEXT,
    messageId: 'msg-1',
    timestamp: '1700000000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    imContactId: 'ct-1',
    contactName: 'Alice',
    payload: { text: '滚' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    chatSessionService.getChatHistory.mockResolvedValue([
      { role: 'user', content: '滚', timestamp: 1_700_000_000_000 },
    ]);
    sessionService.getSessionState.mockResolvedValue(null);
    detector.detect.mockReturnValue({ hit: false });
    interventionService.dispatch.mockResolvedValue({
      dispatched: true,
      paused: true,
      alerted: true,
    });

    service = new PreAgentRiskInterceptService(
      detector as never,
      interventionService as never,
      chatSessionService as never,
      sessionService as never,
    );
  });

  it('returns hit:false early when content is empty', async () => {
    const result = await service.precheck({ messageData: message, content: '   ' });

    expect(result).toEqual({ hit: false });
    expect(detector.detect).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
    expect(chatSessionService.getChatHistory).not.toHaveBeenCalled();
  });

  it('returns hit:false early when chatId is missing', async () => {
    const result = await service.precheck({
      messageData: { ...message, chatId: '' },
      content: '滚',
    });

    expect(result).toEqual({ hit: false });
    expect(detector.detect).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('returns hit:false without dispatching when detector misses', async () => {
    detector.detect.mockReturnValue({ hit: false });

    const result = await service.precheck({ messageData: message, content: '你好' });

    expect(result).toEqual({ hit: false });
    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches conversation_risk intervention when detector hits', async () => {
    detector.detect.mockReturnValue({
      hit: true,
      riskType: 'abuse',
      riskLabel: '辱骂/攻击',
      summary: '辱骂',
      reason: '命中辱骂关键词',
    });

    const result = await service.precheck({ messageData: message, content: '滚' });

    expect(interventionService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'conversation_risk',
        source: 'regex_intercept',
        riskType: 'abuse',
        riskLabel: '辱骂/攻击',
        reason: '命中辱骂关键词',
        chatId: 'chat-1',
        corpId: 'org-1',
        pauseTargetId: 'chat-1',
      }),
    );
    expect(result).toEqual({
      hit: true,
      riskType: 'abuse',
      reason: '命中辱骂关键词',
      label: '辱骂/攻击',
    });
  });

  it('swallows dispatch failures so agent reply path can continue', async () => {
    detector.detect.mockReturnValue({
      hit: true,
      riskType: 'abuse',
      riskLabel: '辱骂/攻击',
      summary: '辱骂',
      reason: '命中辱骂关键词',
    });
    interventionService.dispatch.mockRejectedValue(new Error('redis down'));

    await expect(service.precheck({ messageData: message, content: '滚' })).resolves.toEqual({
      hit: true,
      riskType: 'abuse',
      reason: '命中辱骂关键词',
      label: '辱骂/攻击',
    });
  });

  it('continues when chat history / session state lookups throw', async () => {
    chatSessionService.getChatHistory.mockRejectedValue(new Error('redis down'));
    sessionService.getSessionState.mockRejectedValue(new Error('db down'));
    detector.detect.mockReturnValue({ hit: false });

    const result = await service.precheck({ messageData: message, content: '你好' });

    expect(result).toEqual({ hit: false });
    expect(detector.detect).toHaveBeenCalledWith(
      expect.objectContaining({
        recentMessages: [],
        sessionState: null,
      }),
    );
  });
});
