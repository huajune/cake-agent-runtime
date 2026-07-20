import { ReengagementTrackingService } from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import type { RecordReengagementTouchInput } from '@biz/monitoring/entities/reengagement-touch.entity';

const identity = {
  sessionId: 'sess-1',
  userId: 'user-1',
  corpId: 'corp-1',
  scenarioCode: 'opening_no_reply',
  anchorEventId: 'trace-1:opening_sent',
  anchorAt: 1750000000000,
};

describe('ReengagementTrackingService', () => {
  let repository: { record: jest.Mock };
  let service: ReengagementTrackingService;

  beforeEach(() => {
    repository = { record: jest.fn().mockResolvedValue(true) };
    service = new ReengagementTrackingService(repository as never);
  });

  const lastInput = (): RecordReengagementTouchInput => repository.record.mock.calls[0][0];

  it('derives touch_key as sessionId:scenarioCode:anchorEventId (same as Bull jobId)', () => {
    expect(ReengagementTrackingService.touchKey(identity)).toBe(
      'sess-1:opening_no_reply:trace-1:opening_sent',
    );
  });

  it('records scheduled with jobId, fireAt and identity fields', () => {
    service.trackScheduled(identity, 'job-1', 1750000900000);

    const input = lastInput();
    expect(input.touchKey).toBe('sess-1:opening_no_reply:trace-1:opening_sent');
    expect(input.status).toBe('scheduled');
    expect(input.jobId).toBe('job-1');
    expect(input.fireAt).toBe(1750000900000);
    expect(input.sessionId).toBe('sess-1');
    expect(input.anchorAt).toBe(identity.anchorAt);
    expect(input.event?.event).toBe('scheduled');
  });

  it('records stopped with decision reason at fire time', () => {
    service.trackStopped(identity, 'candidate_replied_after_anchor');

    const input = lastInput();
    expect(input.status).toBe('stopped');
    expect(input.decisionReason).toBe('candidate_replied_after_anchor');
    expect(input.firedAt).toEqual(expect.any(Number));
  });

  it('records an eagerly removed pending job as stopped without a fire time', () => {
    service.trackStoppedBeforeFire(identity, {
      jobId: 'job-1',
      reason: 'candidate_invited_to_group',
    });

    const input = lastInput();
    expect(input.status).toBe('stopped');
    expect(input.jobId).toBe('job-1');
    expect(input.decisionReason).toBe('candidate_invited_to_group');
    expect(input.firedAt).toBeUndefined();
    expect(input.event?.detail).toEqual(
      expect.objectContaining({ beforeFire: true, reason: 'candidate_invited_to_group' }),
    );
  });

  it('records superseded when a pending Bull job is removed before fire time', () => {
    service.trackSuperseded(identity, {
      jobId: 'job-old',
      supersededByJobId: 'job-new',
      reason: 'booking_incomplete_supersedes_pending',
    });

    const input = lastInput();
    expect(input.status).toBe('superseded');
    expect(input.jobId).toBe('job-old');
    expect(input.decisionReason).toBe('booking_incomplete_supersedes_pending');
    expect(input.event?.event).toBe('superseded');
    expect(input.event?.detail).toEqual(
      expect.objectContaining({ jobId: 'job-old', supersededByJobId: 'job-new' }),
    );
  });

  it('records shadow with generated text and reason', () => {
    service.trackShadow(identity, {
      outcomeKind: 'reply',
      generatedText: '还在考虑吗？',
      reason: 'shadow_mode',
      batchId: 'batch_sess-1_1750000000000',
    });

    const input = lastInput();
    expect(input.status).toBe('shadow');
    expect(input.shadow).toBe(true);
    expect(input.generatedText).toBe('还在考虑吗？');
    expect(input.decisionReason).toBe('shadow_mode');
    expect(input.batchId).toBe('batch_sess-1_1750000000000');
    expect(input.event?.detail).toEqual(
      expect.objectContaining({ batchId: 'batch_sess-1_1750000000000' }),
    );
  });

  it('records sent as terminal state with text', () => {
    service.trackSent(identity, '明天见！');

    const input = lastInput();
    expect(input.status).toBe('sent');
    expect(input.shadow).toBe(false);
    expect(input.sentAt).toEqual(expect.any(Number));
    expect(input.generatedText).toBe('明天见！');
  });

  it('records delivery unknown with error', () => {
    service.trackDeliveryUnknown(identity, 'gateway timeout');

    const input = lastInput();
    expect(input.status).toBe('unknown');
    expect(input.error).toBe('gateway timeout');
    expect(input.event?.event).toBe('delivery_unknown');
  });

  it('trackReserved appends event without changing terminal status', () => {
    service.trackReserved(identity);

    const input = lastInput();
    expect(input.status).toBeUndefined();
    expect(input.reserveResult).toBe('reserved');
    expect(input.event?.event).toBe('reserved');
  });

  it('records a normal Agent skip as skipped instead of a system failure', () => {
    service.trackOutcomeNotReply(identity, 'skipped', 'batch-1', 'reengagement_agent_skipped');

    const input = lastInput();
    expect(input.status).toBe('skipped');
    expect(input.outcomeKind).toBe('skipped');
    expect(input.decisionReason).toBe('reengagement_agent_skipped');
    expect(input.event?.event).toBe('outcome_not_reply');
  });

  it.each(['reengagement_agent_error', 'composer_error'])(
    'keeps real generation error %s classified as failed',
    (reason) => {
      service.trackOutcomeNotReply(identity, 'skipped', 'batch-1', reason);

      const input = lastInput();
      expect(input.status).toBe('failed');
      expect(input.decisionReason).toBe(reason);
    },
  );

  it.each(['guardrail_blocked', 'handoff', 'delivery_skipped'])(
    'records expected no-send outcome %s as skipped',
    (outcomeKind) => {
      service.trackOutcomeNotReply(identity, outcomeKind, 'batch-1', outcomeKind);

      expect(lastInput().status).toBe('skipped');
    },
  );

  it('swallows repository failures (fire-and-forget, never blocks main flow)', async () => {
    repository.record.mockRejectedValue(new Error('db down'));

    expect(() => service.trackScheduled(identity, 'job-1', 1750000900000)).not.toThrow();
    // 等微任务清空，确认未抛未处理 rejection
    await new Promise((resolve) => setImmediate(resolve));
  });
});
