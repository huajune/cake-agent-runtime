import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { REENGAGEMENT_JOB_NAME } from '@agent/reengagement/follow-up-scheduler.service';
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
  let queue: { add: jest.Mock; getJob: jest.Mock; getJobs: jest.Mock };
  let systemConfig: { getAgentReplyConfig: jest.Mock };
  let tracking: Record<string, jest.Mock>;
  let service: FollowUpSchedulerService;

  beforeEach(() => {
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    systemConfig = {
      getAgentReplyConfig: jest.fn().mockResolvedValue({ reengagementEnabled: true }),
    };
    tracking = {
      trackScheduled: jest.fn(),
      trackScheduleSkipped: jest.fn(),
      trackScheduleError: jest.fn(),
      trackSuperseded: jest.fn(),
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
    expect(queue.getJobs).not.toHaveBeenCalled();
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

  it('removes older pending pre-booking jobs for the same session before enqueueing a new pre-booking job', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const removeOldOpening = jest.fn().mockResolvedValue(undefined);
    const removeOldStore = jest.fn().mockResolvedValue(undefined);
    const removeOtherSession = jest.fn().mockResolvedValue(undefined);
    const removePostBooking = jest.fn().mockResolvedValue(undefined);
    queue.getJobs.mockResolvedValue([
      {
        id: 'sess-1:opening_no_reply:opening',
        data: {
          sessionRef,
          scenarioCode: 'opening_no_reply',
          anchorEventId: 'opening',
          anchorAt: now,
        },
        remove: removeOldOpening,
      },
      {
        id: 'sess-1:store_presented_no_reply:msg-1:store_presented',
        data: {
          sessionRef,
          scenarioCode: 'store_presented_no_reply',
          anchorEventId: 'msg-1:store_presented',
          anchorAt: now,
        },
        remove: removeOldStore,
      },
      {
        id: 'sess-2:opening_no_reply:opening',
        data: {
          sessionRef: { ...sessionRef, sessionId: 'sess-2' },
          scenarioCode: 'opening_no_reply',
          anchorEventId: 'opening',
          anchorAt: now,
        },
        remove: removeOtherSession,
      },
      {
        id: 'sess-1:interview_reminder:wo1',
        data: {
          sessionRef,
          scenarioCode: 'interview_reminder',
          anchorEventId: 'wo1',
          anchorAt: now,
          workOrderId: 1,
          expectedInterviewAt: now + 3 * 60 * 60_000,
        },
        remove: removePostBooking,
      },
    ]);

    await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'booking_incomplete',
      anchorEventId: 'msg-2:collection_started',
      anchorAt: now,
      state: baseState({ collectedFields: { name: '张三' } as never }),
    });

    expect(removeOldOpening).toHaveBeenCalled();
    expect(removeOldStore).toHaveBeenCalled();
    expect(removeOtherSession).not.toHaveBeenCalled();
    expect(removePostBooking).not.toHaveBeenCalled();
    expect(tracking.trackSuperseded).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        scenarioCode: 'opening_no_reply',
        anchorEventId: 'opening',
      }),
      expect.objectContaining({
        jobId: 'sess-1:opening_no_reply:opening',
        supersededByJobId: 'sess-1:booking_incomplete:msg-2:collection_started',
      }),
    );
    expect(queue.add).toHaveBeenCalled();
  });

  it('removes stale pre-booking and old post-booking jobs before enqueueing a new post-booking job', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    const interviewAt = now + 4 * 60 * 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const removePreBooking = jest.fn().mockResolvedValue(undefined);
    const removeOldBooking = jest.fn().mockResolvedValue(undefined);
    const keepSameBookingSibling = jest.fn().mockResolvedValue(undefined);
    queue.getJobs.mockResolvedValue([
      {
        id: 'sess-1:opening_no_reply:opening',
        data: {
          sessionRef,
          scenarioCode: 'opening_no_reply',
          anchorEventId: 'opening',
          anchorAt: now,
        },
        remove: removePreBooking,
      },
      {
        id: 'sess-1:interview_reminder:wo1',
        data: {
          sessionRef,
          scenarioCode: 'interview_reminder',
          anchorEventId: 'wo1',
          anchorAt: now,
          workOrderId: 1,
          expectedInterviewAt: now + 2 * 60 * 60_000,
        },
        remove: removeOldBooking,
      },
      {
        id: 'sess-1:post_interview_followup:wo2',
        data: {
          sessionRef,
          scenarioCode: 'post_interview_followup',
          anchorEventId: 'wo2',
          anchorAt: now,
          workOrderId: 2,
          expectedInterviewAt: interviewAt,
        },
        remove: keepSameBookingSibling,
      },
    ]);

    await service.scheduleFollowUp({
      sessionRef,
      scenarioCode: 'interview_reminder',
      anchorEventId: 'wo2',
      anchorAt: now,
      state: baseState({ terminal: 'booked', interviewAt } as never),
      workOrderId: 2,
      expectedInterviewAt: interviewAt,
    });

    expect(removePreBooking).toHaveBeenCalled();
    expect(removeOldBooking).toHaveBeenCalled();
    expect(keepSameBookingSibling).not.toHaveBeenCalled();
    expect(tracking.trackSuperseded).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        scenarioCode: 'interview_reminder',
        anchorEventId: 'wo1',
      }),
      expect.objectContaining({
        jobId: 'sess-1:interview_reminder:wo1',
        supersededByJobId: 'sess-1:interview_reminder:wo2',
      }),
    );
    expect(queue.add).toHaveBeenCalled();
  });

  it('removes a pending job by id for scenario mutual exclusion', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({
      id: 'sess-1:opening_no_reply:opening',
      data: {
        sessionRef,
        scenarioCode: 'opening_no_reply',
        anchorEventId: 'opening',
        anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
      },
      remove,
    });

    await expect(
      service.removePendingJob(
        'sess-1:opening_no_reply:opening',
        'address_missing_supersedes_opening_no_reply',
      ),
    ).resolves.toBe(true);

    expect(queue.getJob).toHaveBeenCalledWith('sess-1:opening_no_reply:opening');
    expect(remove).toHaveBeenCalled();
    expect(tracking.trackSuperseded).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        scenarioCode: 'opening_no_reply',
        anchorEventId: 'opening',
      }),
      expect.objectContaining({
        jobId: 'sess-1:opening_no_reply:opening',
        reason: 'address_missing_supersedes_opening_no_reply',
      }),
    );
  });

  it('removes superseded pending jobs through scenario registry contracts', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({
      id: 'sess-1:opening_no_reply:opening',
      data: {
        sessionRef,
        scenarioCode: 'opening_no_reply',
        anchorEventId: 'opening',
        anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
      },
      remove,
    });

    await expect(
      service.removeSupersededPendingJobs({
        sessionRef,
        scenarioCode: 'address_missing',
        reason: 'address_missing_supersedes_opening_no_reply',
      }),
    ).resolves.toBe(1);

    expect(queue.getJob).toHaveBeenCalledWith('sess-1:opening_no_reply:opening');
    expect(remove).toHaveBeenCalled();
  });

  it('returns false when there is no pending job to remove', async () => {
    queue.getJob.mockResolvedValue(null);

    await expect(service.removePendingJob('missing-job')).resolves.toBe(false);
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
    expect(queue.add.mock.calls[0][2]).toEqual(expect.objectContaining({ delay: 30 * 60_000 }));
    expect(queue.add.mock.calls[1][2]).toEqual(expect.objectContaining({ delay: 30 * 60_000 }));
  });
});
