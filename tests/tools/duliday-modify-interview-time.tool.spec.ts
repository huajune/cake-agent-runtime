import { buildModifyInterviewTimeTool } from '@tools/duliday-modify-interview-time.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildModifyInterviewTimeTool', () => {
  const spongeService = { modifyInterviewTime: jest.fn() };
  const opsEventsRecorder = { recordEvent: jest.fn() };
  const longTermService = {};

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
    buildModifyInterviewTimeTool(
      spongeService as never,
      opsEventsRecorder as never,
      longTermService as never,
    )(ctx);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = (tool: any, args: Record<string, unknown>) => tool.execute(args);

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('returns MODIFY_INTERVIEW_REJECTED on business failure', async () => {
    spongeService.modifyInterviewTime.mockResolvedValue({ success: false, code: 500 });
    const tool = buildTool();
    const result = await exec(tool, { workOrderId: 123, newInterviewTime: '2026-06-20 14:00' });

    expect(result).toMatchObject({
      success: false,
      errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REJECTED,
    });
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
