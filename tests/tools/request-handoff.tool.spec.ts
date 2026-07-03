import { buildRequestHandoffTool } from '@tools/request-handoff.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildRequestHandoffTool', () => {
  const interventionService = { dispatch: jest.fn() };
  const chatSessionService = { getChatHistory: jest.fn() };
  const sessionService = { getSessionState: jest.fn() };
  const longTermService = { getActiveBooking: jest.fn() };
  const handoffRecorder = { record: jest.fn() };

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

  const buildTool = (ctx: ToolBuildContext = mockContext) =>
    buildRequestHandoffTool(
      interventionService as never,
      chatSessionService as never,
      sessionService as never,
      longTermService as never,
      handoffRecorder as never,
    )(ctx);

  beforeEach(() => {
    jest.clearAllMocks();
    chatSessionService.getChatHistory.mockResolvedValue([
      { role: 'user', content: '找不到门店啊', timestamp: 1_700_000_000_000 },
    ]);
    sessionService.getSessionState.mockResolvedValue(null);
    longTermService.getActiveBooking.mockResolvedValue(null);
    handoffRecorder.record.mockResolvedValue(undefined);
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

    expect(result).toMatchObject({
      dispatched: false,
      errorType: TOOL_ERROR_TYPES.MISSING_CHAT_ID,
    });
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit on modify_appointment when no active_booking exists', async () => {
    longTermService.getActiveBooking.mockResolvedValue(null);

    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'modify_appointment',
      reason: '想改到明天',
    });

    expect(result).toMatchObject({
      errorType: TOOL_ERROR_TYPES.HANDOFF_NO_BOOKING,
      shortCircuited: false,
    });
    // 守卫命中：不派发、不记录 handoff
    expect(handoffRecorder.record).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('returns a handoff sideEffect intent for outcome-layer dispatch', async () => {
    longTermService.getActiveBooking.mockResolvedValue({
      work_order_id: 5001,
      linked_at: '2026-04-15T00:00:00Z',
    });

    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'cannot_find_store',
      reason: '门店导航错了',
    });

    expect(result.sideEffect).toEqual(
      expect.objectContaining({
        kind: 'general_handoff',
        source: 'agent_tool',
        alertLabel: '找不到门店',
        reasonCode: 'cannot_find_store',
        reason: '门店导航错了',
        workOrderId: 5001,
        botImId: 'bot-im-1',
        idempotencyKey: expect.stringContaining('chat-1:handoff:'),
        recordHandoff: true,
      }),
    );
    expect(handoffRecorder.record).not.toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });

  it('short-circuits and returns general_handoff intent (no onboard/general split anymore)', async () => {
    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'cannot_find_store',
      reason: '候选人反馈导航错',
      actionAdvice: '已发过位置仍无法到店',
    });

    // 工具立即返回短路标记，不等待 dispatch 结果
    expect(result).toMatchObject({ dispatched: true, shortCircuited: true });
    expect(typeof result.instruction).toBe('string');
    expect(result).not.toHaveProperty('paused');
    expect(result).not.toHaveProperty('alerted');

    expect(result.sideEffect).toEqual(
      expect.objectContaining({
        kind: 'general_handoff',
        source: 'agent_tool',
        alertLabel: '找不到门店',
        reason: '候选人反馈导航错',
        actionAdvice: '已发过位置仍无法到店',
        botImId: 'bot-im-1',
        currentMessageContent: '找不到门店啊',
      }),
    );
    expect(interventionService.dispatch).not.toHaveBeenCalled();
    expect(handoffRecorder.record).not.toHaveBeenCalled();
  });

  it('does not call intervention even if the injected dispatcher would reject', async () => {
    interventionService.dispatch.mockRejectedValue(new Error('supabase down'));

    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'cannot_find_store',
      reason: '候选人反馈导航错',
    });

    expect(result).toMatchObject({ dispatched: true, shortCircuited: true });
    expect(result.sideEffect).toEqual(expect.objectContaining({ kind: 'general_handoff' }));
    expect(interventionService.dispatch).not.toHaveBeenCalled();
  });
});
