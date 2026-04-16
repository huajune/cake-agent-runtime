import { buildRequestHandoffTool } from '@tools/request-handoff.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildRequestHandoffTool', () => {
  const interventionService = { dispatch: jest.fn() };
  const recruitmentCaseService = { getActiveOnboardFollowupCase: jest.fn() };
  const chatSessionService = { getChatHistory: jest.fn() };
  const sessionService = { getSessionState: jest.fn() };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    chatId: 'chat-1',
    messages: [],
    botUserId: 'mgr-bob',
    botImId: 'bot-im-1',
    contactName: 'Alice',
  };

  const activeCase = {
    id: 'case-9',
    corp_id: 'corp-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
    case_type: 'onboard_followup',
    status: 'active',
    booking_id: 'bk-1',
    booked_at: '2026-04-15T00:00:00Z',
    interview_time: '2026-04-16 10:00:00',
    job_id: 100,
    job_name: '后厨',
    brand_name: '肯德基',
    store_name: '杨浦店',
    bot_im_id: 'bot-im-1',
    followup_window_ends_at: '2026-04-23T00:00:00Z',
    last_relevant_at: '2026-04-15T00:00:00Z',
    metadata: {},
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
  };

  const buildTool = (ctx: ToolBuildContext = mockContext) =>
    buildRequestHandoffTool(
      interventionService as never,
      recruitmentCaseService as never,
      chatSessionService as never,
      sessionService as never,
    )(ctx);

  beforeEach(() => {
    jest.clearAllMocks();
    chatSessionService.getChatHistory.mockResolvedValue([
      { role: 'user', content: '找不到门店啊', timestamp: 1_700_000_000_000 },
    ]);
    sessionService.getSessionState.mockResolvedValue(null);
    recruitmentCaseService.getActiveOnboardFollowupCase.mockResolvedValue(activeCase);
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
      reasonCode: 'cannot_find_store',
      reason: '找不到门店',
    });

    expect(result).toMatchObject({ dispatched: false, error: 'missing_chat_id' });
    expect(recruitmentCaseService.getActiveOnboardFollowupCase).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('returns no_active_case with instruction when no active case', async () => {
    recruitmentCaseService.getActiveOnboardFollowupCase.mockResolvedValue(null);

    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'other',
      reason: '候选人提了一些后续问题',
    });

    expect(result).toMatchObject({ dispatched: false, error: 'no_active_case' });
    expect(typeof result.instruction).toBe('string');
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches handoff with caseId and returns dispatch status with instruction', async () => {
    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'cannot_find_store',
      reason: '候选人反馈导航错',
      summary: '已发过位置仍无法到店',
    });

    expect(interventionService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'onboard_handoff',
        source: 'agent_tool',
        caseId: 'case-9',
        alertLabel: '找不到门店',
        reason: '候选人反馈导航错',
        summary: '已发过位置仍无法到店',
        chatId: 'chat-1',
        pauseTargetId: 'chat-1',
        botImId: 'bot-im-1',
        botUserName: 'mgr-bob',
        recruitmentCase: expect.objectContaining({ id: 'case-9' }),
        currentMessageContent: '找不到门店啊',
      }),
    );
    expect(result).toMatchObject({
      dispatched: true,
      paused: true,
      alerted: true,
      caseId: 'case-9',
    });
    expect(typeof result.instruction).toBe('string');
    expect(result).not.toHaveProperty('suggestedReply');
  });
});
