import { buildRequestHandoffTool } from '@tools/request-handoff.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { createToolContext, mergeToolContext } from '../helpers/tool-context.fixture';

describe('buildRequestHandoffTool', () => {
  const interventionService = { dispatch: jest.fn() };
  const chatSessionService = { getChatHistory: jest.fn() };
  const sessionService = { getSessionState: jest.fn() };
  const longTermService = { getActiveBooking: jest.fn() };
  const handoffRecorder = { record: jest.fn() };

  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-1', corpId: 'corp-1', sessionId: 'sess-1', chatId: 'chat-1',
      botUserId: 'mgr-bob', botImId: 'bot-im-1', contactName: 'Alice',
    },
  });

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
    const tool = buildTool(mergeToolContext(mockContext, { session: { chatId: undefined, sessionId: '' } }));
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

  it('uses a work order resolved earlier in the same turn when the current contact has no active_booking', async () => {
    longTermService.getActiveBooking.mockResolvedValue(null);
    const tool = buildTool(mergeToolContext(mockContext, { ledger: { resolvedWorkOrderId: 450643 } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reasonCode: 'modify_appointment',
      reason: '自助改约提交失败，需要人工处理',
    });

    expect(result).toMatchObject({
      dispatched: true,
      shortCircuited: true,
      sideEffect: expect.objectContaining({ workOrderId: 450643 }),
    });
  });

  // jobId 让运营的「岗位数据缺口榜 / 满岗信号榜」能直接定位到该改哪个岗位。
  // 背景：2026-07-30 周报里纯咨询会话 18/27 无法定位岗位，因为底账只有 work_order_id。
  describe('jobId 落底账', () => {
    const focusJob = { jobId: 528572, brandName: 'M Stand', jobName: '店员', storeName: '中大天地店' };

    it('优先用本轮焦点岗位', async () => {
      const tool = buildTool(mergeToolContext(mockContext, {
        archive: { currentFocusJob: focusJob as never, activeBookingJobIds: [999888] },
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (tool as any).execute({
        reasonCode: 'salary_admin_inquiry',
        reason: '候选人追问发薪主体，岗位字段没有答案',
        missingJobInfo: ['发薪主体'],
      });

      expect(result.sideEffect).toEqual(expect.objectContaining({ jobId: 528572 }));
    });

    it('无焦点岗位时退回在约岗位', async () => {
      const tool = buildTool(mergeToolContext(mockContext, { archive: { activeBookingJobIds: [999888, 777666] } }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (tool as any).execute({
        reasonCode: 'booking_conflict',
        reason: '门店查不到预约',
      });

      expect(result.sideEffect).toEqual(expect.objectContaining({ jobId: 999888 }));
    });

    it('两者都没有时落 null，不做兜底猜测', async () => {
      const tool = buildTool();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (tool as any).execute({
        reasonCode: 'other',
        reason: '候选人咨询 B 端合作，超出服务范围',
      });

      expect(result.sideEffect).toEqual(expect.objectContaining({ jobId: null }));
    });
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
