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

describe('ReengagementAnchorService', () => {
  let scheduler: {
    scheduleFollowUp: jest.Mock;
    scheduleBookingResolution: jest.Mock;
    removeSupersededPendingJobs: jest.Mock;
  };
  let session: { saveTerminalState: jest.Mock; getAuthoritativeState: jest.Mock };

  beforeEach(() => {
    scheduler = {
      scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }),
      scheduleBookingResolution: jest.fn().mockResolvedValue({ scheduled: true }),
      removeSupersededPendingJobs: jest.fn().mockResolvedValue(1),
    };
    session = {
      saveTerminalState: jest.fn().mockResolvedValue(undefined),
      getAuthoritativeState: jest.fn().mockResolvedValue(baseState()),
    };
  });

  const buildService = () => new ReengagementAnchorService(scheduler as never, session as never);

  const bookingCall = {
    toolName: 'duliday_interview_booking',
    args: { interviewTime: INTERVIEW_TIME },
    result: {
      success: true,
      workOrderId: 555,
      requestInfo: { interviewType: 'AI面试' },
    },
  };

  it('schedules booking resolution retries carrying only the stable workOrderId', async () => {
    buildService().handleToolAnchors({ toolCalls: [bookingCall] }, context);
    await flush();

    expect(session.saveTerminalState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1', 'booked');
    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'interview_reminder',
        workOrderId: 555,
      }),
    );
    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'post_interview_followup',
        workOrderId: 555,
      }),
    );
    const serializedCalls = JSON.stringify(scheduler.scheduleBookingResolution.mock.calls);
    expect(serializedCalls).not.toContain('expectedInterviewAt');
    expect(serializedCalls).not.toContain('interviewType');
  });

  it('still schedules a resolver when the booking result has no interview time', async () => {
    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: { jobId: 100 },
            result: { success: true, workOrderId: 555 },
          },
        ],
      },
      context,
    );
    await flush();

    expect(session.saveTerminalState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1', 'booked');
    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledTimes(2);
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

  it('writes booked last when cancel and booking succeed in the same turn', async () => {
    // 换岗回合：先取消旧工单再报新岗位。clearBookedTerminal 的状态读取被拖慢，
    // 复现竞态——若清空与写 booked 不串行，clear 的写会落在 booked 之后抹掉新终态。
    session.getAuthoritativeState.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(baseState({ terminal: 'booked' })), 20)),
    );
    const terminalWrites: Array<string | undefined> = [];
    session.saveTerminalState.mockImplementation(
      (_corpId: string, _userId: string, _chatId: string, terminal?: string) => {
        terminalWrites.push(terminal);
        return Promise.resolve();
      },
    );

    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_cancel_work_order',
            args: { workOrderId: 111 },
            result: { success: true },
          },
          bookingCall,
        ],
      },
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 串行链保证顺序：先清旧终态、后写新 booked，最终终态必须是 booked
    expect(terminalWrites).toEqual([undefined, 'booked']);
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

  it('resolves the latest sponge work order again when a modification succeeds', async () => {
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

    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'interview_reminder',
        workOrderId: 555,
      }),
    );
    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'post_interview_followup',
        workOrderId: 555,
      }),
    );
    // 改约不是新报名，不写 booked 终态
    expect(session.saveTerminalState).not.toHaveBeenCalled();
  });

  it('resolves from sponge even when modify output has no interview time', async () => {
    buildService().handleToolAnchors(
      {
        toolCalls: [
          {
            toolName: 'duliday_modify_interview_time',
            args: { workOrderId: 555 },
            result: { success: true, workOrderId: 555 },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledTimes(2);
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

  it('passes current turn job-list evidence when scheduling store-presented follow-up', async () => {
    session.getAuthoritativeState.mockResolvedValue(baseState({ presentedStores: [] }));

    buildService().handleDeliveredReplyAnchors(
      {
        text: '奥乐齐（1044 凯德晶萃广场）- 分拣打包，8.1km',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: {
              resultCount: 1,
              queryMeta: {
                brandNearestStores: [
                  {
                    nearestStores: [{ jobId: 516221, storeName: '1044 凯德晶萃广场' }],
                  },
                ],
              },
            },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'store_presented_no_reply',
        state: expect.objectContaining({
          presentedStores: [{ jobId: 516221 }],
        }),
      }),
    );
  });

  it('does not treat a targeted job fact lookup as a newly presented store', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '工资是每月 15 号发。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { jobIdList: [528538], includeJobSalary: true },
            result: {
              resultCount: 1,
              queryMeta: {
                brandNearestStores: [
                  { nearestStores: [{ jobId: 528538, storeName: '天河领展广场店' }] },
                ],
              },
            },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'store_presented_no_reply' }),
    );
  });

  it('does not treat a positive job-list result as presented when the reply says no job matches', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '肯德基这些岗位要求22岁以上，你19岁暂时不匹配，后面有新岗位我在群里通知你。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: {
              resultCount: 1,
              jobs: [{ jobId: 528538, brandName: '肯德基', storeName: '盐田店' }],
            },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'store_presented_no_reply' }),
    );
  });

  it('refreshes collection instead of store-presented when a fact reply continues collecting', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '工资是每月 15 号发。上面的资料填一下发我，我帮你约面。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { jobIdList: [528538], includeJobSalary: true },
            result: { resultCount: 1 },
          },
        ],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'booking_incomplete',
        anchorEventId: 'trace-1:collection_continued',
      }),
    );
    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'store_presented_no_reply' }),
    );
  });

  it('does not treat nearby-store recommendation copy as asking for location', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '查到了，芳芯路附近有几家奥乐齐在招，分拣打包和理货岗都有。',
        toolCalls: [],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'address_missing' }),
    );
  });

  it('does not treat sent-navigation copy as asking the candidate for location', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '门店位置我发你了，你点开就能看导航。',
        toolCalls: [],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'address_missing' }),
    );
  });

  it('still schedules address-missing when asking for a business district or metro station', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '我帮你看看附近在招的岗位，你平时大概在哪个商圈或地铁站附近呀？',
        toolCalls: [],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'address_missing',
        anchorEventId: 'trace-1:address_missing',
      }),
    );
    expect(scheduler.removeSupersededPendingJobs).toHaveBeenCalledWith({
      sessionRef: { corpId: 'corp-1', userId: 'user-1', sessionId: 'chat-1' },
      scenarioCode: 'address_missing',
      reason: 'address_missing_supersedes_opening_no_reply',
    });
  });

  it('still schedules address-missing for inverted send-location phrasing', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '你方便的话位置发我一下，我帮你看最近的门店。',
        toolCalls: [],
      },
      context,
    );
    await flush();

    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'address_missing',
        anchorEventId: 'trace-1:address_missing',
      }),
    );
  });

  it('does not schedule address-missing from the opening reply itself', async () => {
    buildService().handleDeliveredReplyAnchors(
      {
        text: '还在看机会吗？方便说下你在哪个地铁站附近，我帮你看看附近岗位。',
        toolCalls: [],
      },
      { ...context, suppressAddressMissing: true },
    );
    await flush();

    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'address_missing' }),
    );
  });
});
