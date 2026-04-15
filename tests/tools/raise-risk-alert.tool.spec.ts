import { buildRaiseRiskAlertTool } from '@tools/raise-risk-alert.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildRaiseRiskAlertTool', () => {
  const interventionService = { dispatch: jest.fn() };
  const chatSessionService = { getChatHistory: jest.fn() };
  const sessionService = { getSessionState: jest.fn() };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    chatId: 'chat-1',
    messages: [],
    botImId: 'bot-im-1',
    contactName: 'Alice',
  };

  const buildTool = (ctx: ToolBuildContext = mockContext) =>
    buildRaiseRiskAlertTool(
      interventionService as never,
      chatSessionService as never,
      sessionService as never,
    )(ctx);

  beforeEach(() => {
    jest.clearAllMocks();
    chatSessionService.getChatHistory.mockResolvedValue([
      { role: 'user', content: '你说啥呢', timestamp: 1_700_000_000_000 },
    ]);
    sessionService.getSessionState.mockResolvedValue(null);
    interventionService.dispatch.mockResolvedValue({
      dispatched: true,
      paused: true,
      alerted: true,
    });
  });

  it('returns missing_chat_id when chatId and sessionId are both absent', async () => {
    const tool = buildTool({ ...mockContext, chatId: undefined, sessionId: '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'abuse',
      reason: '候选人骂人',
    });

    expect(result).toMatchObject({ dispatched: false, error: 'missing_chat_id' });
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches intervention and returns dispatch status with instruction', async () => {
    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'escalation',
      reason: '候选人连续催促',
      summary: '情绪升级',
    });

    expect(interventionService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'conversation_risk',
        source: 'agent_tool',
        riskType: 'escalation',
        reason: '候选人连续催促',
        summary: '情绪升级',
        chatId: 'chat-1',
        pauseTargetId: 'chat-1',
        botImId: 'bot-im-1',
        contactName: 'Alice',
        currentMessageContent: '你说啥呢',
      }),
    );
    expect(result).toMatchObject({
      dispatched: true,
      paused: true,
      alerted: true,
    });
    expect(typeof result.instruction).toBe('string');
    expect(result).not.toHaveProperty('suggestedReply');
  });

  it('propagates already_paused suppression from InterventionService', async () => {
    interventionService.dispatch.mockResolvedValue({
      dispatched: false,
      paused: false,
      alerted: false,
      suppressed: 'already_paused',
    });

    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'abuse',
      reason: '再次辱骂',
    });

    expect(result).toMatchObject({
      dispatched: false,
      paused: false,
      alerted: false,
      suppressed: 'already_paused',
    });
  });

  it('swallows history/session lookup failures and still dispatches', async () => {
    chatSessionService.getChatHistory.mockRejectedValue(new Error('redis down'));
    sessionService.getSessionState.mockRejectedValue(new Error('db down'));

    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'complaint_risk',
      reason: '威胁举报',
    });

    expect(interventionService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        recentMessages: [],
        currentMessageContent: '',
        sessionState: null,
      }),
    );
    expect(result).toMatchObject({ dispatched: true });
  });
});
