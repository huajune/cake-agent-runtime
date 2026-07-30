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
      jobId: 528572,
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
      jobId: 528572,
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
        job_id: 528572,
        missing_job_info: ['trial_period'],
      },
    });
  });

  // 运营的「岗位数据缺口榜 / 满岗信号榜」按 job_id 定位岗位；缺失必须是显式 null
  // 而不是 undefined（undefined 会被 supabase-js 整列省略，列上不会写 null）。
  it('normalises a missing jobId to null on both the ledger row and the ops event payload', async () => {
    const service = new HandoffRecorderService(repository as never, opsEventsRecorder as never);

    await service.record({
      corpId: 'corp-1',
      chatId: 'chat-1',
      reasonCode: 'salary_admin_inquiry',
      missingJobInfo: ['发薪主体'],
      idempotencyKey: 'trace-3',
    });

    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ job_id: null }),
      }),
    );
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
          job_id: null,
          missing_job_info: null,
        }),
      }),
    );
  });
});
