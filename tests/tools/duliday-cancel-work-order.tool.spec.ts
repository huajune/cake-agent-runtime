import { buildCancelWorkOrderTool } from '@tools/duliday-cancel-work-order.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildCancelWorkOrderTool', () => {
  const spongeService = { cancelWorkOrder: jest.fn(), fetchFailureReasonsByPids: jest.fn() };
  const opsEventsRecorder = { recordEvent: jest.fn() };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    chatId: 'chat-1',
    messages: [],
    botImId: 'bot-im-1',
    botUserId: 'mgr-bob',
  };

  const buildTool = (ctx: ToolBuildContext = mockContext) =>
    buildCancelWorkOrderTool(spongeService as never, opsEventsRecorder as never)(ctx);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (tool: any, args: Record<string, unknown>) => tool.execute(args);

  beforeEach(() => {
    jest.clearAllMocks();
    spongeService.fetchFailureReasonsByPids.mockResolvedValue([
      { id: 12010, info: '候选人主动取消' },
      { id: 12011, info: '时间冲突' },
    ]);
    spongeService.cancelWorkOrder.mockResolvedValue({ success: true, code: 0, message: 'ok' });
    opsEventsRecorder.recordEvent.mockResolvedValue(true);
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
      }),
    );
  });

  it('returns CANCEL_REASON_REQUIRED when reasonId is not in the dictionary', async () => {
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, cancelReasonId: 99999 });

    expect(spongeService.cancelWorkOrder).not.toHaveBeenCalled();
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
    });
    expect(opsEventsRecorder.recordEvent).not.toHaveBeenCalled();
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
});
