import { buildModifyInterviewTimeTool } from '@tools/duliday-modify-interview-time.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext, mergeToolContext } from '../helpers/tool-context.fixture';

describe('buildModifyInterviewTimeTool', () => {
  const spongeService = { modifyInterviewTime: jest.fn(), fetchSignupWorkOrders: jest.fn() };
  const opsEventsRecorder = { recordEvent: jest.fn() };
  const longTermService = { getActiveBookings: jest.fn(), setActiveBooking: jest.fn() };

  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'sess-1',
      chatId: 'chat-1',
      botImId: 'bot-im-1',
      botUserId: 'mgr-bob',
    },
  });

  const buildTool = (ctx: ToolBuildContext = mockContext) =>
    buildModifyInterviewTimeTool(
      spongeService as never,
      opsEventsRecorder as never,
      longTermService as never,
    )(ctx);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (tool: any, args: Record<string, unknown>) => tool.execute(args);

  beforeEach(() => {
    jest.clearAllMocks();
    delete mockContext.ledger.jobs.resolvedWorkOrderId;
    longTermService.getActiveBookings.mockResolvedValue([{ work_order_id: 123 }]);
    longTermService.setActiveBooking.mockResolvedValue(undefined);
    spongeService.fetchSignupWorkOrders.mockResolvedValue({ total: 0, workOrders: [] });
    spongeService.modifyInterviewTime.mockResolvedValue({ success: true, code: 0, message: 'ok' });
    opsEventsRecorder.recordEvent.mockResolvedValue(true);
  });

  it('modifies interview time, returns success and records booking.interview_modified', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, newInterviewTime: '2026-06-20 14:00' });

    expect(spongeService.modifyInterviewTime).toHaveBeenCalledWith(
      { workOrderId: 123, newInterviewTime: '2026-06-20 14:00' },
      { botImId: 'bot-im-1', botUserId: 'mgr-bob', groupId: undefined },
    );
    expect(result).toMatchObject({
      success: true,
      workOrderId: 123,
      newInterviewTime: '2026-06-20 14:00',
      errorType: null,
    });
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'booking.interview_modified',
        idempotencyKey: '123:interview_modified:2026-06-20 14:00',
      }),
    );
  });

  it('rejects invalid workOrderId without calling the API', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: -1, newInterviewTime: '2026-06-20 14:00' });

    expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_MISSING_WORK_ORDER_ID,
    });
  });

  it('rejects malformed interview time (with seconds) without calling the API', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, newInterviewTime: '2026-06-20 14:00:00' });

    expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_INVALID_TIME,
    });
  });

  it('does not modify when the candidate only asks whether a morning slot is available', async () => {
    const context = mergeToolContext(mockContext, {
      turnInput: { currentUserMessage: '明天上午的面试还有吗' },
    });
    const tool = buildTool(context);
    const result = await exec(tool, {
      workOrderId: 450643,
      newInterviewTime: '2026-07-17 10:00',
    });

    expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_UNCONFIRMED,
    });
  });

  describe('work order not in active_booking (snapshot ownership)', () => {
    const snapshotRef = (over: Record<string, unknown> = {}) => ({
      workOrderId: 464227,
      jobId: 529005,
      source: 'out_of_band' as const,
      signupSource: 'SUPPLIER' as const,
      ownedByCandidate: true,
      interviewTime: '2026-09-14 12:00',
      ...over,
    });
    const bookingSnapshot = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const buildWithSnapshot = (ctx: ToolBuildContext) =>
      buildModifyInterviewTimeTool(
        spongeService as never,
        opsEventsRecorder as never,
        longTermService as never,
        { bookingSnapshot: bookingSnapshot as never },
      )(ctx);

    beforeEach(() => {
      longTermService.getActiveBookings.mockResolvedValue([]);
      bookingSnapshot.invalidate.mockClear();
    });

    const expectRejected = (result: unknown) =>
      expect(result).toMatchObject({
        success: false,
        shortCircuited: true,
        gateRejected: true,
        reasonCode: 'modify_appointment',
        workOrderId: 464227,
        errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_WORK_ORDER_NOT_IN_MEMORY,
      });

    it('快照里通过本人校验的带外工单视同自有：放行改约，不再要求原话含手机号，也不回填 active_booking', async () => {
      const context = mergeToolContext(mockContext, {
        archive: { bookingWorkOrders: [snapshotRef()] },
        turnInput: { currentUserMessage: '确定，改到周五下午2点', messages: [] },
      });
      const result = await exec(buildWithSnapshot(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-09-18 14:00',
      });

      expect(spongeService.fetchSignupWorkOrders).not.toHaveBeenCalled();
      expect(longTermService.setActiveBooking).not.toHaveBeenCalled();
      expect(spongeService.modifyInterviewTime).toHaveBeenCalledWith(
        { workOrderId: 464227, newInterviewTime: '2026-09-18 14:00' },
        expect.anything(),
      );
      expect(result).toMatchObject({ success: true, workOrderId: 464227 });
      // 带外工单的改约事件带来源标记；成功后失效该候选人的快照缓存
      expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'booking.interview_modified',
          payload: expect.objectContaining({ source: 'oob' }),
        }),
      );
      expect(bookingSnapshot.invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ botImId: 'bot-im-1', corpId: 'corp-1', userId: 'user-1' }),
      );
    });

    it('本人校验未通过（登记姓名≠候选人姓名）→ 短路转人工，不改约', async () => {
      const context = mergeToolContext(mockContext, {
        archive: { bookingWorkOrders: [snapshotRef({ ownedByCandidate: false })] },
        turnInput: { currentUserMessage: '确定', messages: [] },
      });
      const result = await exec(buildWithSnapshot(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });

      expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
      expect(context.ledger.jobs.resolvedWorkOrderId).toBe(464227);
      expectRejected(result);
      expect(result).toMatchObject({
        ownershipReason: 'identity_mismatch',
        handoffReason: expect.stringContaining('姓名'),
      });
    });

    it('既不在指针也不在快照 → 短路转人工', async () => {
      const context = mergeToolContext(mockContext, {
        archive: { bookingWorkOrders: [] },
        turnInput: { currentUserMessage: '确定', messages: [] },
      });
      const result = await exec(buildWithSnapshot(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });

      expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
      expectRejected(result);
      expect(result).toMatchObject({ ownershipReason: 'not_in_snapshot' });
    });

    it('自建单（AI 来源）改约事件来源为 ai', async () => {
      const context = mergeToolContext(mockContext, {
        archive: {
          bookingWorkOrders: [snapshotRef({ source: 'active_booking', signupSource: 'AI' })],
        },
        turnInput: { currentUserMessage: '确定', messages: [] },
      });
      await exec(buildWithSnapshot(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });
      expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ source: 'ai' }) }),
      );
    });
  });

  it('returns MODIFY_INTERVIEW_REJECTED on business failure', async () => {
    spongeService.modifyInterviewTime.mockResolvedValue({ success: false, code: 500 });
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, newInterviewTime: '2026-06-20 14:00' });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REJECTED,
      apiCode: 500,
      apiMessage: null,
    });
    expect(mockContext.ledger.jobs.resolvedWorkOrderId).toBe(123);
  });

  it('returns MODIFY_INTERVIEW_REQUEST_FAILED when the API throws', async () => {
    spongeService.modifyInterviewTime.mockRejectedValue(new Error('boom'));
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, newInterviewTime: '2026-06-20 14:00' });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REQUEST_FAILED,
    });
  });

  describe('失败回执自带转人工（PRD R5.1：删「说衔接语 + 调 request_handoff」互斥指令）', () => {
    const contextWithFocus = mergeToolContext(mockContext, {
      archive: { currentStage: 'interview_booked', activeBookingJobIds: [777] },
      turnInput: { currentUserMessage: '能改到 20 号下午两点吗' },
    });

    it.each([
      [
        'MODIFY_INTERVIEW_REJECTED',
        () => spongeService.modifyInterviewTime.mockResolvedValue({ success: false, code: 500 }),
        TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REJECTED,
      ],
      [
        'MODIFY_INTERVIEW_REQUEST_FAILED',
        () => spongeService.modifyInterviewTime.mockRejectedValue(new Error('boom')),
        TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REQUEST_FAILED,
      ],
    ])('%s carries a modify_appointment handoff sideEffect', async (_label, arrange, errorType) => {
      arrange();
      const result = await exec(buildTool(contextWithFocus), {
        workOrderId: 123,
        newInterviewTime: '2026-06-20 14:00',
      });

      expect(result.errorType).toBe(errorType);
      expect(result.sideEffect).toEqual(
        expect.objectContaining({
          kind: 'general_handoff',
          origin: 'tool_failure',
          reasonCode: 'modify_appointment',
          workOrderId: 123,
          jobId: 777,
          stage: 'interview_booked',
          recordHandoff: true,
          reason: expect.stringContaining('想改到：2026-06-20 14:00'),
        }),
      );
      expect(result._replyInstruction).not.toContain('按 request_handoff');
      expect(result._replyInstruction).not.toContain('我让同事帮你确认一下');
      expect(result._replyInstruction).toContain('已经转给同事跟进');
    });

    it('ownership gate rejection keeps the short-circuit contract (no extra sideEffect)', async () => {
      longTermService.getActiveBookings.mockResolvedValue([]);
      spongeService.fetchSignupWorkOrders.mockResolvedValue({ total: 0, workOrders: [] });
      const result = await exec(buildTool(contextWithFocus), {
        workOrderId: 999,
        newInterviewTime: '2026-06-20 14:00',
      });
      expect(result.gateRejected).toBe(true);
      expect(result.sideEffect).toBeUndefined();
    });
  });
});
