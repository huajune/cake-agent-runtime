import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { CriticalEventProcessor } from '@biz/ops-events/critical-event.processor';

describe('critical event recovery', () => {
  const repository = { upsertOpsEvent: jest.fn() };
  const queue = { add: jest.fn() };
  const failures = { report: jest.fn() };
  const recorder = new OpsEventsRecorderService(
    repository as never,
    { resolve: () => null } as never,
    queue as never,
    failures as never,
  );
  const processor = new CriticalEventProcessor(
    queue as never,
    repository as never,
    failures as never,
  );
  const input = {
    corpId: 'corp',
    eventName: 'booking.succeeded' as const,
    idempotencyKey: 'wo-1',
    occurredAt: '2026-10-21T01:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    queue.add.mockResolvedValue({ id: 'job' });
  });

  it('recovers a failed success-event write with the same key and occurrence time', async () => {
    repository.upsertOpsEvent.mockResolvedValueOnce('failed').mockResolvedValueOnce('inserted');
    await expect(recorder.recordEventDetailed(input)).resolves.toBe('failed');
    const [, data, options] = queue.add.mock.calls[0];
    expect(data).toEqual(input);
    expect(options.attempts).toBe(5);
    await processor.process({ data } as never);
    expect(repository.upsertOpsEvent).toHaveBeenLastCalledWith(input);
  });

  it('accepts a duplicate recovery as success without projecting the event twice', async () => {
    repository.upsertOpsEvent.mockResolvedValue('duplicate');
    await expect(processor.process({ data: input } as never)).resolves.toBeUndefined();
  });

  it('makes both storage failures visible without asking the caller to repeat the booking', async () => {
    repository.upsertOpsEvent.mockResolvedValue('failed');
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(recorder.recordEventDetailed(input)).resolves.toBe('failed');
    expect(failures.report).toHaveBeenCalledWith(
      'ops.critical_event_not_durable',
      'booking.succeeded',
      expect.any(Error),
    );
  });
});
