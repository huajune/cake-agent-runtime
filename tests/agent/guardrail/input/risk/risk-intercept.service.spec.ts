import {
  RiskInterceptService,
  type RiskInterceptInput,
} from '@agent/guardrail/input/risk-intercept.service';

describe('RiskInterceptService', () => {
  const detector = { detect: jest.fn() };
  const interventionService = { dispatch: jest.fn() };
  const chatSessionService = { getChatHistory: jest.fn() };
  const sessionService = { getSessionState: jest.fn() };

  let service: RiskInterceptService;

  const baseInput = (over: Partial<RiskInterceptInput> = {}): RiskInterceptInput => ({
    corpId: 'org-1',
    chatId: 'chat-1',
    userId: 'ct-1',
    pauseTargetId: 'chat-1',
    scanContent: '滚',
    messageId: 'msg-1',
    contactName: 'Alice',
    botImId: 'wxid-bot',
    botUserName: 'mgr-bob',
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    chatSessionService.getChatHistory.mockResolvedValue([
      { role: 'user', content: '滚', timestamp: 1_700_000_000_000 },
    ]);
    sessionService.getSessionState.mockResolvedValue(null);
    detector.detect.mockReturnValue({ hit: false });
    interventionService.dispatch.mockResolvedValue({ dispatched: true, paused: true, alerted: true });

    service = new RiskInterceptService(
      detector as never,
      interventionService as never,
      chatSessionService as never,
      sessionService as never,
    );
  });

  it('returns hit:false early when scanContent is empty (channel filtered it)', async () => {
    const result = await service.precheck(baseInput({ scanContent: '   ' }));

    expect(result).toEqual({ hit: false });
    expect(detector.detect).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
    expect(chatSessionService.getChatHistory).not.toHaveBeenCalled();
  });

  it('returns hit:false early when chatId is missing', async () => {
    const result = await service.precheck(baseInput({ chatId: '' }));

    expect(result).toEqual({ hit: false });
    expect(detector.detect).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('returns hit:false without dispatching when detector misses', async () => {
    detector.detect.mockReturnValue({ hit: false });

    const result = await service.precheck(baseInput({ scanContent: '你好' }));

    expect(result).toEqual({ hit: false });
    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('filters visual image descriptions out of the recent-message risk context', async () => {
    chatSessionService.getChatHistory.mockResolvedValue([
      {
        role: 'user',
        content: '[图片消息] 这是一张招聘平台职位列表截图，整体为垂直滚动列表',
        timestamp: 1_700_000_000_000,
      },
      { role: 'user', content: '你好', timestamp: 1_700_000_001_000 },
    ]);
    detector.detect.mockReturnValue({ hit: false });

    await service.precheck(baseInput({ scanContent: '你好' }));

    expect(detector.detect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessageContent: '你好',
        recentMessages: [{ role: 'user', content: '你好', timestamp: 1_700_000_001_000 }],
      }),
    );
  });

  it('dispatches conversation_risk intervention when detector hits', async () => {
    detector.detect.mockReturnValue({
      hit: true,
      riskType: 'abuse',
      riskLabel: '辱骂/攻击',
      summary: '辱骂',
      reason: '命中辱骂关键词',
    });

    const result = await service.precheck(baseInput({ scanContent: '滚' }));

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

    await expect(service.precheck(baseInput({ scanContent: '滚' }))).resolves.toEqual({
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

    const result = await service.precheck(baseInput({ scanContent: '你好' }));

    expect(result).toEqual({ hit: false });
    expect(detector.detect).toHaveBeenCalledWith(
      expect.objectContaining({ recentMessages: [], sessionState: null }),
    );
  });
});
