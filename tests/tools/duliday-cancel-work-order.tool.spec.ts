import { buildCancelWorkOrderTool } from '@tools/duliday-cancel-work-order.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext, mergeToolContext } from '../helpers/tool-context.fixture';

describe('buildCancelWorkOrderTool', () => {
  const spongeService = {
    cancelWorkOrder: jest.fn(),
    fetchFailureReasonsByPids: jest.fn(),
    getWorkOrderById: jest.fn(),
  };
  const opsEventsRecorder = { recordEvent: jest.fn() };
  const longTermService = { clearActiveBooking: jest.fn(), getActiveBookings: jest.fn() };
  const privateChatNotifier = { notifyInterviewCancellation: jest.fn() };

  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'sess-1',
      chatId: 'chat-1',
      botImId: 'bot-im-1',
      botUserId: 'mgr-bob',
      contactName: '候选人微信名',
    },
    turnInput: { messages: [{ role: 'user', content: '那个面试我不去了，帮我取消吧' }] },
  });

  const buildTool = (ctx: ToolBuildContext = mockContext) =>
    buildCancelWorkOrderTool(
      spongeService as never,
      opsEventsRecorder as never,
      longTermService as never,
      privateChatNotifier as never,
    )(ctx);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (tool: any, args: Record<string, unknown>) => tool.execute(args);

  beforeEach(() => {
    jest.clearAllMocks();
    spongeService.fetchFailureReasonsByPids.mockResolvedValue([
      { id: 12010, info: '候选人主动取消' },
      { id: 12011, info: '时间冲突' },
    ]);
    spongeService.cancelWorkOrder.mockResolvedValue({ success: true, code: 0, message: 'ok' });
    spongeService.getWorkOrderById.mockResolvedValue({
      workOrderId: 123,
      currentStatus: '约面成功',
      interviewPassTime: null,
    });
    opsEventsRecorder.recordEvent.mockResolvedValue(true);
    longTermService.clearActiveBooking.mockResolvedValue(undefined);
    longTermService.getActiveBookings.mockResolvedValue([
      { work_order_id: 123, linked_at: '2026-07-01T00:00:00Z' },
    ]);
    privateChatNotifier.notifyInterviewCancellation.mockResolvedValue(true);
  });

  describe('B5 取消前置核验', () => {
    const snapshotRef = (over: Record<string, unknown> = {}) => ({
      workOrderId: 464227,
      jobId: 529005,
      source: 'out_of_band' as const,
      signupSource: 'SUPPLIER' as const,
      ownedByCandidate: true,
      ...over,
    });
    const bookingSnapshot = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const buildWithSnapshot = (ctx: ToolBuildContext) =>
      buildCancelWorkOrderTool(
        spongeService as never,
        opsEventsRecorder as never,
        longTermService as never,
        privateChatNotifier as never,
        { bookingSnapshot: bookingSnapshot as never },
      )(ctx);

    it('快照里通过本人校验的带外工单视同自有：放行取消、事件带 source=oob、失效快照缓存', async () => {
      bookingSnapshot.invalidate.mockClear();
      const ctx = mergeToolContext(mockContext, {
        archive: { bookingWorkOrders: [snapshotRef()] },
      });
      const result = await exec(buildWithSnapshot(ctx), {
        workOrderId: 464227,
        cancelReasonId: 12010,
        phone: '18271421690',
      });

      expect(result).toMatchObject({ success: true, workOrderId: 464227 });
      expect(spongeService.cancelWorkOrder).toHaveBeenCalledWith(
        expect.objectContaining({ workOrderId: 464227 }),
        expect.anything(),
      );
      expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'booking.canceled',
          payload: expect.objectContaining({ source: 'oob' }),
        }),
      );
      expect(bookingSnapshot.invalidate).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '18271421690',
          botImId: 'bot-im-1',
          corpId: 'corp-1',
          userId: 'user-1',
        }),
      );
    });

    it('本人校验未通过的快照工单禁止取消（identity_mismatch）', async () => {
      const ctx = mergeToolContext(mockContext, {
        archive: { bookingWorkOrders: [snapshotRef({ ownedByCandidate: false })] },
      });
      const result = await exec(buildWithSnapshot(ctx), {
        workOrderId: 464227,
        cancelReasonId: 12010,
      });

      expect(result).toMatchObject({
        success: false,
        errorType: TOOL_ERROR_TYPES.CANCEL_WORK_ORDER_NOT_OWNED,
        ownershipReason: 'identity_mismatch',
      });
      expect(result._replyInstruction).toContain('姓名');
      expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
    });

    it('指针里的自建单取消事件来源为 ai', async () => {
      const result = await exec(buildTool(), { workOrderId: 123, cancelReasonId: 12010 });
      expect(result).toMatchObject({ success: true });
      expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ source: 'ai' }) }),
      );
    });

    it('rejects a workOrderId outside the active_booking set (记忆残留/臆造工单)', async () => {
      const tool = buildTool();
      const result = await exec(tool, { workOrderId: 999, cancelReasonId: 12010 });

      expect(result).toMatchObject({
        success: false,
        errorType: TOOL_ERROR_TYPES.CANCEL_WORK_ORDER_NOT_OWNED,
      });
      expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
    });

    it.each([
      ['面试成功', '2026-07-22 15:30:00'],
      ['上岗成功', null],
      ['已离职', null],
    ])(
      'ignores sponge status %s / interviewPassTime（状态字段滞后不可信，2026-09-16 运营裁定取消不看状态）',
      async (currentStatus, interviewPassTime) => {
        spongeService.getWorkOrderById.mockResolvedValue({
          workOrderId: 123,
          currentStatus,
          interviewPassTime,
        });
        const tool = buildTool();
        const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

        expect(result).toMatchObject({ success: true, workOrderId: 123 });
        expect(spongeService.cancelWorkOrder).toHaveBeenCalledTimes(1);
      },
    );

    it('does not need the work-order status lookup at all', async () => {
      spongeService.getWorkOrderById.mockRejectedValue(new Error('sponge timeout'));
      const tool = buildTool();
      const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

      expect(result).toMatchObject({ success: true, workOrderId: 123 });
      expect(spongeService.getWorkOrderById).not.toHaveBeenCalled();
    });

    it('degrades to allow when active_booking read fails (本地存储故障不阻断)', async () => {
      longTermService.getActiveBookings.mockRejectedValue(new Error('supabase down'));
      const tool = buildTool();
      const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

      expect(result).toMatchObject({ success: true, workOrderId: 123 });
    });
  });

  it('returns CANCEL_REASON_REQUIRED with available reasons when reasonId is omitted', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123 });

    expect(spongeService.fetchFailureReasonsByPids).toHaveBeenCalledWith([12001], {
      botImId: 'bot-im-1',
      botUserId: 'mgr-bob',
      groupId: undefined,
    });
    expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.CANCEL_REASON_REQUIRED,
      availableReasons: [
        { id: 12010, info: '候选人主动取消' },
        { id: 12011, info: '时间冲突' },
      ],
    });
  });

  it('cancels with the chosen reason id and records booking.canceled on success', async () => {
    const tool = buildTool();
    const result = await exec(tool, {
      workOrderId: 123,
      cancelReasonId: 12010,
      cancelReasonDesc: '当天有事去不了',
      candidateName: '张三',
      phone: '13800000000',
      brandName: '喜茶',
      storeName: '西湖银泰店',
      jobName: '店员',
      interviewTime: '2026-07-02 14:00',
    });

    expect(spongeService.cancelWorkOrder).toHaveBeenCalledWith(
      { workOrderId: 123, cancelReasonId: 12010, cancelReasonDesc: '当天有事去不了' },
      { botImId: 'bot-im-1', botUserId: 'mgr-bob', groupId: undefined },
    );
    expect(result).toMatchObject({
      success: true,
      workOrderId: 123,
      cancelReasonId: 12010,
      errorType: null,
    });
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'booking.canceled',
        idempotencyKey: '123:canceled',
        payload: expect.objectContaining({
          candidate_name: '张三',
          phone: '13800000000',
          brand_name: '喜茶',
          store_name: '西湖银泰店',
          job_name: '店员',
          interview_time: '2026-07-02 14:00',
        }),
      }),
    );
    expect(longTermService.clearActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1', 123);
    expect(privateChatNotifier.notifyInterviewCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        botImId: 'bot-im-1',
        contactName: '候选人微信名',
        botUserName: 'mgr-bob',
        userMessage: '那个面试我不去了，帮我取消吧',
        workOrderId: 123,
        cancelReason: '候选人主动取消',
        cancelReasonDesc: '当天有事去不了',
        candidateName: '张三',
        phone: '13800000000',
        brandName: '喜茶',
        storeName: '西湖银泰店',
        jobName: '店员',
        interviewTime: '2026-07-02 14:00',
      }),
    );
  });

  it('keeps cancellation successful when private-chat notification delivery throws', async () => {
    privateChatNotifier.notifyInterviewCancellation.mockRejectedValue(new Error('feishu down'));
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

    expect(result).toMatchObject({
      success: true,
      workOrderId: 123,
      cancelReasonId: 12010,
      errorType: null,
    });
    expect(privateChatNotifier.notifyInterviewCancellation).toHaveBeenCalled();
  });

  it('returns CANCEL_REASON_REQUIRED when reasonId is not in the dictionary', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, cancelReasonId: 99999 });

    expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
    expect(privateChatNotifier.notifyInterviewCancellation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.CANCEL_REASON_REQUIRED,
    });
  });

  it('returns CANCEL_REASON_FETCH_FAILED when the dictionary lookup throws', async () => {
    spongeService.fetchFailureReasonsByPids.mockRejectedValue(new Error('dict down'));
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

    expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED,
    });
  });

  it('rejects invalid workOrderId without any API call', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 0 });

    expect(spongeService.fetchFailureReasonsByPids).not.toHaveBeenCalled();
    expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.CANCEL_MISSING_WORK_ORDER_ID,
    });
  });

  it('returns CANCEL_REJECTED when the cancel API reports business failure', async () => {
    spongeService.cancelWorkOrder.mockResolvedValue({ success: false, code: 500, message: 'busy' });
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.CANCEL_REJECTED,
      apiCode: 500,
      apiMessage: 'busy',
    });
    expect(opsEventsRecorder.recordEvent).not.toHaveBeenCalled();
    expect(longTermService.clearActiveBooking).not.toHaveBeenCalled();
    expect(privateChatNotifier.notifyInterviewCancellation).not.toHaveBeenCalled();
  });

  it('returns CANCEL_REQUEST_FAILED when the cancel API throws', async () => {
    spongeService.cancelWorkOrder.mockRejectedValue(new Error('network down'));
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, cancelReasonId: 12010 });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.CANCEL_REQUEST_FAILED,
    });
  });

  describe('失败回执自带转人工（PRD R5.1：删「说衔接语 + 调 request_handoff」互斥指令）', () => {
    const contextWithFocus = mergeToolContext(mockContext, {
      archive: {
        currentStage: 'interview_booked',
        currentFocusJob: { jobId: 528546 } as never,
        activeBookingJobIds: [528546],
      },
      turnInput: {
        messages: [{ role: 'user', content: '那个面试我不去了，帮我取消吧' }],
        currentUserMessage: '那个面试我不去了，帮我取消吧',
      },
    });

    it.each([
      [
        'CANCEL_REJECTED',
        () =>
          spongeService.cancelWorkOrder.mockResolvedValue({
            success: false,
            code: 500,
            message: 'busy',
          }),
        TOOL_ERROR_TYPES.CANCEL_REJECTED,
      ],
      [
        'CANCEL_REQUEST_FAILED',
        () => spongeService.cancelWorkOrder.mockRejectedValue(new Error('network down')),
        TOOL_ERROR_TYPES.CANCEL_REQUEST_FAILED,
      ],
      [
        'CANCEL_REASON_FETCH_FAILED',
        () => spongeService.fetchFailureReasonsByPids.mockRejectedValue(new Error('dict down')),
        TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED,
      ],
    ])('%s carries a modify_appointment handoff sideEffect', async (_label, arrange, errorType) => {
      arrange();
      const result = await exec(buildTool(contextWithFocus), {
        workOrderId: 123,
        cancelReasonId: 12010,
      });

      expect(result.errorType).toBe(errorType);
      expect(result.sideEffect).toEqual(
        expect.objectContaining({
          kind: 'general_handoff',
          source: 'agent_tool',
          origin: 'tool_failure',
          reasonCode: 'modify_appointment',
          workOrderId: 123,
          jobId: 528546,
          stage: 'interview_booked',
          botImId: 'bot-im-1',
          recordHandoff: true,
          reason: expect.stringContaining(`自助取消失败（${errorType}`),
        }),
      );
      expect(result.sideEffect.reason).toContain('候选人原话：「那个面试我不去了，帮我取消吧」');
      // 不再要求模型调 request_handoff，也不再教「我让同事帮你确认一下」
      expect(result._replyInstruction).not.toContain('按 request_handoff');
      expect(result._replyInstruction).not.toContain('我让同事帮你确认一下');
      expect(result._replyInstruction).toContain('已经转给同事跟进');
      expect(result._replyInstruction).toContain('不要谎称已取消');
    });

    it('does not carry a sideEffect when the reason still needs to be picked (first step)', async () => {
      const result = await exec(buildTool(contextWithFocus), { workOrderId: 123 });
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.CANCEL_REASON_REQUIRED);
      expect(result.sideEffect).toBeUndefined();
    });
  });
});
