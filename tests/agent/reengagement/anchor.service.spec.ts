import { ReengagementAnchorService } from '@agent/reengagement/anchor.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';

const context = {
  traceId: 'trace-1',
  chatId: 'chat-1',
  userId: 'user-1',
  corpId: 'corp-1',
};

const baseState = (over: Partial<AuthoritativeSessionState> = {}): AuthoritativeSessionState => ({
  collectedFields: {},
  recalledJobIds: new Set<number>(),
  hardConstraints: [],
  presentedStores: [],
  stage: null,
  ...over,
});

/** handleToolAnchors 的排程是 fire-and-forget，flush 微任务队列后再断言 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// 2026-06-25 14:00 Shanghai
const INTERVIEW_TIME = '2026-06-25 14:00';
const INTERVIEW_AT = Date.UTC(2026, 5, 25, 6, 0, 0);

describe('ReengagementAnchorService', () => {
  let scheduler: { scheduleFollowUp: jest.Mock };
  let session: { saveTerminalState: jest.Mock; getAuthoritativeState: jest.Mock };

  beforeEach(() => {
    scheduler = { scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }) };
    session = {
      saveTerminalState: jest.fn().mockResolvedValue(undefined),
      getAuthoritativeState: jest.fn().mockResolvedValue(baseState()),
    };
  });

  const buildService = () => new ReengagementAnchorService(scheduler as never, session as never);

  const bookingCall = {
    toolName: 'duliday_interview_booking',
    args: { interviewTime: INTERVIEW_TIME },
    result: { success: true, workOrderId: 555 },
  };

  it('schedules booking follow-ups carrying workOrderId and frozen interview time', async () => {
    buildService().handleToolAnchors({ toolCalls: [bookingCall] }, context);
    await flush();

    expect(session.saveTerminalState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1', 'booked');
    // 幂等锚点 wo:iv:scenario——同工单同时间只存在一个任务
    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'interview_reminder',
        anchorEventId: `wo555:iv${INTERVIEW_AT}:interview_reminder`,
        workOrderId: 555,
        expectedInterviewAt: INTERVIEW_AT,
      }),
    );
    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'post_interview_followup',
        anchorEventId: `wo555:iv${INTERVIEW_AT}:post_interview_followup`,
        workOrderId: 555,
        expectedInterviewAt: INTERVIEW_AT,
      }),
    );
  });

  it('clears the booked terminal when a cancel succeeds', async () => {
    session.getAuthoritativeState.mockResolvedValue(baseState({ terminal: 'booked' }));

    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_cancel_work_order',
            args: { workOrderId: 555 },
            result: { success: true, workOrderId: 555 },
          },
        ],
      },
      context,
    );
    await flush();

    expect(session.saveTerminalState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1', undefined);
    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('does not touch other terminals on cancel', async () => {
    session.getAuthoritativeState.mockResolvedValue(baseState({ terminal: 'handed_off' }));

    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_cancel_work_order',
            args: { workOrderId: 555 },
            result: { success: true },
          },
        ],
      },
      context,
    );
    await flush();

    expect(session.saveTerminalState).not.toHaveBeenCalled();
  });

  it('reschedules booking follow-ups at the new time when a modification succeeds', async () => {
    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_modify_interview_time',
            args: { workOrderId: 555, newInterviewTime: INTERVIEW_TIME },
            result: { success: true, workOrderId: 555, newInterviewTime: INTERVIEW_TIME },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'interview_reminder',
        anchorEventId: `wo555:iv${INTERVIEW_AT}:interview_reminder`,
        workOrderId: 555,
        expectedInterviewAt: INTERVIEW_AT,
      }),
    );
    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'post_interview_followup',
        anchorEventId: `wo555:iv${INTERVIEW_AT}:post_interview_followup`,
      }),
    );
    // 改约不是新报名，不写 booked 终态
    expect(session.saveTerminalState).not.toHaveBeenCalled();
  });

  it('ignores failed cancel/modify tool calls', async () => {
    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_cancel_work_order',
            args: { workOrderId: 555 },
            result: { success: false },
          },
          {
            toolName: 'duliday_modify_interview_time',
            args: { workOrderId: 555, newInterviewTime: INTERVIEW_TIME },
            result: { success: false },
          },
        ],
      },
      context,
    );
    await flush();

    expect(session.saveTerminalState).not.toHaveBeenCalled();
    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('skips modify-anchored scheduling when the turn is not deliverable', async () => {
    buildService().handleToolAnchors(
      {
        outcome: { kind: 'guardrail_blocked' },
        toolCalls: [
          {
            toolName: 'duliday_modify_interview_time',
            args: { workOrderId: 555, newInterviewTime: INTERVIEW_TIME },
            result: { success: true },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('does nothing in group chats', async () => {
    buildService().handleToolAnchors(
      { toolCalls: [bookingCall] },
      { ...context, isGroupChat: true },
    );
    await flush();

    expect(session.saveTerminalState).not.toHaveBeenCalled();
    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
  });
});
