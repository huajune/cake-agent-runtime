import { ReengagementCommandService } from '@agent/reengagement/reengagement-command.service';
import { businessTenant, runForTenant } from '@infra/supabase/business-tenant';

describe('ReengagementCommandService', () => {
  const queue = { add: jest.fn() };
  const scheduler = {
    scheduleFollowUp: jest.fn(),
    scheduleBookingResolution: jest.fn(),
    stopPendingJobsForSessionScenario: jest.fn(),
  };
  const session = { recordCandidateActivity: jest.fn() };
  const failures = { report: jest.fn() };
  const tenants = { historicalBot: jest.fn(), resolve: jest.fn() };
  const service = new ReengagementCommandService(
    queue as never,
    scheduler as never,
    session as never,
    failures as never,
    tenants as never,
  );
  const input = {
    sessionRef: { corpId: 'corp', userId: 'user', sessionId: 'chat' },
    scenarioCode: 'booking_incomplete' as const,
    anchorEventId: 'turn:anchor',
    anchorAt: 100,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    queue.add.mockResolvedValue({ id: 'job' });
  });

  it('persists before scheduling, with the same command id on replay', async () => {
    await service.scheduleFollowUp(input);
    await service.scheduleFollowUp(input);
    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
    expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
    scheduler.scheduleFollowUp.mockResolvedValue({ scheduled: false, reason: 'enqueue_error' });
    await expect(service.process({ data: queue.add.mock.calls[0][1] } as never)).rejects.toThrow(
      'enqueue_error',
    );
    scheduler.scheduleFollowUp.mockResolvedValue({ scheduled: true });
    await service.process({ data: queue.add.mock.calls[0][1] } as never);
    expect(scheduler.scheduleFollowUp).toHaveBeenLastCalledWith(expect.objectContaining(input));
  });

  it('does not swallow cancellation failures and freezes a cutoff for delayed cancellation', async () => {
    await service.stopPendingJobsForSessionScenario({
      sessionRef: input.sessionRef,
      scenarioCode: 'store_presented_no_reply',
      reason: 'invited',
      commandId: 'turn:invite',
    });
    const command = queue.add.mock.calls[0][1];
    expect(command.input.beforeAnchorAt).toEqual(expect.any(Number));
    scheduler.stopPendingJobsForSessionScenario.mockRejectedValue(new Error('redis down'));
    await expect(service.process({ data: command } as never)).rejects.toThrow('redis down');
  });

  it('makes queue admission failure visible to the caller', async () => {
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(service.scheduleFollowUp(input)).rejects.toThrow('redis down');
    expect(failures.report).toHaveBeenCalledWith(
      'reengagement.command_not_durable',
      'schedule',
      expect.any(Error),
    );
  });

  it('recovers candidate activity in the originating organization outside the inbound request', async () => {
    const activity = { ...input.sessionRef, timestamp: 1000 };
    await runForTenant('henan', () => service.recordCandidateActivity(activity));
    const stored = JSON.parse(JSON.stringify(queue.add.mock.calls[0][1]));
    expect(stored.tenantId).toBe('henan');
    session.recordCandidateActivity.mockImplementationOnce(async () => {
      expect(businessTenant()).toBe('henan');
    });
    await runForTenant('headquarters', () => service.process({ data: stored } as never));
    expect(session.recordCandidateActivity).toHaveBeenCalledWith(
      'corp',
      'user',
      'chat',
      new Date(1000),
    );
    expect(tenants.historicalBot).not.toHaveBeenCalled();
  });

  it('uses the original session for an older activity job and keeps an unresolved write retryable', async () => {
    const data = { kind: 'activity', input: { ...input.sessionRef, timestamp: 1000 } };
    tenants.historicalBot.mockResolvedValueOnce(null).mockResolvedValueOnce('registered-bot');
    await expect(service.process({ data } as never)).rejects.toThrow('组织');
    expect(session.recordCandidateActivity).not.toHaveBeenCalled();
    tenants.resolve.mockResolvedValueOnce(['henan']);
    session.recordCandidateActivity.mockImplementationOnce(async () => {
      expect(businessTenant()).toBe('henan');
    });
    await service.process({ data } as never);
    expect(tenants.historicalBot).toHaveBeenCalledWith('chat', 1000);
    expect(tenants.resolve).toHaveBeenCalledWith([{ botId: 'registered-bot', at: 1000 }]);
  });
});
