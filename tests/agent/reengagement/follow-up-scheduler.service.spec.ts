import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { REENGAGEMENT_JOB_NAME } from '@agent/reengagement/reengagement.types';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';

const sessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'sess-1' };

const baseState = (over: Partial<AuthoritativeSessionState> = {}): AuthoritativeSessionState => ({
  collectedFields: {},
  recalledJobIds: new Set<number>(),
  hardConstraints: [],
  presentedStores: [],
  stage: null,
  ...over,
});

describe('FollowUpSchedulerService', () => {
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let systemConfig: { getAgentReplyConfig: jest.Mock };
  let tracking: Record<string, jest.Mock>;
  let service: FollowUpSchedulerService;

  beforeEach(() => {
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    systemConfig = {
      getAgentReplyConfig: jest.fn().mockResolvedValue({ reengagementEnabled: true }),
    };
    tracking = {
      trackScheduled: jest.fn(),
      trackScheduleSkipped: jest.fn(),
      trackScheduleError: jest.fn(),
    };
    service = new FollowUpSchedulerService(
      queue as never,
      systemConfig as never,
      tracking as never,
    );
  });

  it('does not schedule when reengagement is disabled', async () => {
    systemConfig.getAgentReplyConfig.mockResolvedValue({ reengagementEnabled: false });

    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
    });

    expect(result).toEqual({ scheduled: false, reason: 'disabled' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not schedule unknown scenarios', async () => {
    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'not-real' as never,
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
    });

    expect(result).toEqual({ scheduled: false, reason: 'unknown_scenario' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('prechecks stop conditions when state is supplied', async () => {
    const anchorAt = 1000;

    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt,
      state: baseState({ lastCandidateMessageAt: anchorAt + 1 }),
    });

    expect(result).toEqual({ scheduled: false, reason: 'candidate_replied_after_anchor' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not schedule post-booking follow-ups without an interview time', async () => {
    const anchorAt = Date.UTC(2026, 5, 24, 2, 0, 0);

    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'interview_reminder',
      anchorEventId: 'evt-1',
      anchorAt,
      state: baseState({ terminal: 'booked' }),
      workOrderId: 123,
    });

    expect(result).toEqual({ scheduled: false, reason: 'missing_interview_time' });
    expect(queue.add).not.toHaveBeenCalled();
    expect(tracking.trackScheduleSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'interview_reminder' }),
      'missing_interview_time',
    );
  });

  it('enqueues a delayed follow-up with deterministic job id', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const anchorAt = now;

    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt,
      state: baseState(),
    });

    const expectedFireAt = anchorAt + 15 * 60_000;
    expect(result).toEqual({
      scheduled: true,
      fireAt: expectedFireAt,
      jobId: 'sess-1:opening_no_reply:evt-1',
    });
    expect(queue.add).toHaveBeenCalledWith(
      REENGAGEMENT_JOB_NAME,
      {
        sessionRef,
        scenarioCode: 'opening_no_reply',
        anchorEventId: 'evt-1',
        anchorAt,
      },
      expect.objectContaining({
        jobId: 'sess-1:opening_no_reply:evt-1',
        delay: 15 * 60_000,
      }),
    );
    // 无存量任务：排程 + 底账落库都发生
    expect(tracking.trackScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', scenarioCode: 'opening_no_reply' }),
      'sess-1:opening_no_reply:evt-1',
      expectedFireAt,
    );
  });

  it('skips both enqueue and ledger write when the same jobId already exists', async () => {
    // Bull 同 jobId add 是静默 no-op；若仍 trackScheduled 会把底账 fire_at
    // 覆写成一个不会触发的幽灵时间（已完成任务上 status=sent 却挂未来 fire_at）
    queue.getJob.mockResolvedValue({ id: 'sess-1:opening_no_reply:evt-1' });

    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
      state: baseState(),
    });

    expect(result).toEqual({
      scheduled: false,
      reason: 'duplicate_job',
      jobId: 'sess-1:opening_no_reply:evt-1',
    });
    expect(queue.add).not.toHaveBeenCalled();
    expect(tracking.trackScheduled).not.toHaveBeenCalled();
  });

  it('falls back to Bull-level dedup when the existing-job lookup fails', async () => {
    queue.getJob.mockRejectedValue(new Error('redis down'));

    const result = await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
      state: baseState(),
    });

    expect(result.scheduled).toBe(true);
    expect(queue.add).toHaveBeenCalled();
    expect(tracking.trackScheduled).toHaveBeenCalled();
  });

  it('uses a fresh empty state when state is omitted', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'booking_incomplete',
      anchorEventId: 'evt-1',
      anchorAt: now,
    });
    await service.scheduleFollowUp({
      sessionRef: { ...sessionRef, sessionId: 'sess-2' },
      scenarioCode: 'booking_incomplete',
      anchorEventId: 'evt-2',
      anchorAt: now,
    });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][2]).toEqual(expect.objectContaining({ delay: 2 * 60 * 60_000 }));
    expect(queue.add.mock.calls[1][2]).toEqual(expect.objectContaining({ delay: 2 * 60 * 60_000 }));
  });
});
