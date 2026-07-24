import { HandoffRecorderService } from '@biz/handoff-events/handoff-recorder.service';

describe('HandoffRecorderService', () => {
  const repository = {
    insertHandoffEvent: jest.fn(),
  };
  const opsEventsRecorder = {
    recordEvent: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repository.insertHandoffEvent.mockResolvedValue('inserted');
    opsEventsRecorder.recordEvent.mockResolvedValue(true);
  });

  it('records both handoff_events and the handoff.triggered ops event with shared idempotency', async () => {
    const occurredAt = new Date('2026-06-05T03:00:00.000Z');
    const service = new HandoffRecorderService(repository as never, opsEventsRecorder as never);

    const outcome = await service.record({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      reasonCode: 'modify_appointment',
      reason: '候选人想改面试时间',
      actionAdvice: '人工确认可改时间',
      stage: 'booking_followup',
      botImId: 'bot-1',
      workOrderId: 12345,
      missingJobInfo: ['trial_period'],
      idempotencyKey: 'trace-1',
      occurredAt,
    });

    expect(outcome).toBe('inserted');
    expect(repository.insertHandoffEvent).toHaveBeenCalledWith({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      reasonCode: 'modify_appointment',
      reason: '候选人想改面试时间',
      actionAdvice: '人工确认可改时间',
      stage: 'booking_followup',
      botImId: 'bot-1',
      workOrderId: 12345,
      missingJobInfo: ['trial_period'],
      idempotencyKey: 'trace-1',
      occurredAt,
    });
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith({
      corpId: 'corp-1',
      eventName: 'handoff.triggered',
      idempotencyKey: 'trace-1',
      occurredAt,
      botImId: 'bot-1',
      userId: 'user-1',
      chatId: 'chat-1',
      payload: {
        reason_code: 'modify_appointment',
        reason: '候选人想改面试时间',
        stage: 'booking_followup',
        work_order_id: 12345,
        missing_job_info: ['trial_period'],
      },
    });
  });

  it('still records the ops event when handoff_events insert throws', async () => {
    repository.insertHandoffEvent.mockRejectedValueOnce(new Error('db unavailable'));
    const service = new HandoffRecorderService(repository as never, opsEventsRecorder as never);

    const outcome = await service.record({
      corpId: 'corp-1',
      chatId: 'chat-1',
      reasonCode: 'system_blocked',
      idempotencyKey: 'trace-2',
    });

    expect(outcome).toBe('failed');
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        eventName: 'handoff.triggered',
        idempotencyKey: 'trace-2',
        payload: expect.objectContaining({
          reason_code: 'system_blocked',
          reason: null,
          stage: null,
          work_order_id: null,
          missing_job_info: null,
        }),
      }),
    );
  });
});
