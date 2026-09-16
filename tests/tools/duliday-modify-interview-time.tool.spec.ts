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

  describe('work order not in active_booking (out-of-band ownership check)', () => {
    const outOfBandOrder = {
      workOrderId: 464227,
      jobId: 529005,
      currentStatus: '约面成功',
      interviewTime: '2026-09-14 12:00',
    };
    const candidateSaidPhone = [
      { role: 'assistant', content: '你的手机号发我一下' },
      { role: 'user', content: '18271421690' },
      { role: 'user', content: '周五可以的' },
    ];

    beforeEach(() => {
      longTermService.getActiveBookings.mockResolvedValue([]);
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

    it('releases and backfills active_booking when the work order phone was said by the candidate in this session', async () => {
      spongeService.fetchSignupWorkOrders.mockResolvedValue({
        phone: '18271421690',
        total: 1,
        workOrders: [outOfBandOrder],
      });
      const context = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '确定，改到周五下午2点', messages: candidateSaidPhone },
      });
      const tool = buildTool(context);
      const result = await exec(tool, {
        workOrderId: 464227,
        newInterviewTime: '2026-09-18 14:00',
      });

      expect(spongeService.fetchSignupWorkOrders).toHaveBeenCalledWith(
        { workOrderId: 464227 },
        { botImId: 'bot-im-1', botUserId: 'mgr-bob', groupId: undefined },
      );
      expect(longTermService.setActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1', 464227, {
        job_id: 529005,
        interview_time: '2026-09-14 12:00:00',
      });
      expect(spongeService.modifyInterviewTime).toHaveBeenCalledWith(
        { workOrderId: 464227, newInterviewTime: '2026-09-18 14:00' },
        expect.anything(),
      );
      expect(result).toMatchObject({ success: true, workOrderId: 464227 });
    });

    it('accepts the phone carried on the work order row and tolerates missing interviewTime', async () => {
      spongeService.fetchSignupWorkOrders.mockResolvedValue({
        total: 1,
        workOrders: [{ ...outOfBandOrder, phone: '182 7142 1690', interviewTime: null }],
      });
      const context = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '确定', messages: candidateSaidPhone },
      });
      const result = await exec(buildTool(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-09-18 14:00',
      });

      expect(longTermService.setActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1', 464227, {
        job_id: 529005,
        interview_time: null,
      });
      expect(result).toMatchObject({ success: true });
    });

    it('short-circuits to handoff when the phone only appears in non-candidate messages', async () => {
      spongeService.fetchSignupWorkOrders.mockResolvedValue({
        phone: '18271421690',
        total: 1,
        workOrders: [outOfBandOrder],
      });
      const context = mergeToolContext(mockContext, {
        turnInput: {
          currentUserMessage: '确定，帮我改到明天上午10点',
          messages: [
            { role: 'assistant', content: '已帮你登记，手机号 18271421690' },
            { role: 'user', content: '好的' },
          ],
        },
      });
      const result = await exec(buildTool(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });

      expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
      expect(longTermService.setActiveBooking).not.toHaveBeenCalled();
      expect(context.ledger.jobs.resolvedWorkOrderId).toBe(464227);
      expectRejected(result);
      expect(result).toMatchObject({ handoffReason: expect.stringContaining('尾号 1690') });
    });

    it('ignores the sponge status field（海绵状态滞后不可信，2026-09-16 运营裁定改约不看状态）', async () => {
      spongeService.fetchSignupWorkOrders.mockResolvedValue({
        phone: '18271421690',
        total: 1,
        workOrders: [{ ...outOfBandOrder, currentStatus: '面试成功' }],
      });
      const context = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '确定', messages: candidateSaidPhone },
      });
      await exec(buildTool(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });

      expect(spongeService.modifyInterviewTime).toHaveBeenCalledTimes(1);
    });

    it('fails closed to handoff when the work order lookup throws', async () => {
      spongeService.fetchSignupWorkOrders.mockRejectedValue(new Error('sponge down'));
      const context = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '确定', messages: candidateSaidPhone },
      });
      const result = await exec(buildTool(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });

      expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
      expect(longTermService.setActiveBooking).not.toHaveBeenCalled();
      expectRejected(result);
    });

    it('fails closed to handoff when the work order carries no candidate phone', async () => {
      spongeService.fetchSignupWorkOrders.mockResolvedValue({
        total: 1,
        workOrders: [{ ...outOfBandOrder, phone: null }],
      });
      const context = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '确定', messages: candidateSaidPhone },
      });
      const result = await exec(buildTool(context), {
        workOrderId: 464227,
        newInterviewTime: '2026-07-17 10:00',
      });

      expect(spongeService.modifyInterviewTime).not.toHaveBeenCalled();
      expectRejected(result);
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
});
