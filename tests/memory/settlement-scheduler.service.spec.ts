import { SettlementSchedulerService } from '@memory/long-term/settlement-scheduler.service';

describe('SettlementSchedulerService', () => {
  const queue = {
    getJob: jest.fn(),
    add: jest.fn().mockResolvedValue(undefined),
  };
  const input = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
    botImId: 'bot-1',
    activityAt: 123,
  };
  let service: SettlementSchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    queue.getJob.mockResolvedValue(null);
    service = new SettlementSchedulerService(
      queue as never,
      { consolidationGapSeconds: 3 * 24 * 60 * 60 } as never,
    );
  });

  it('按 3 天 delay 与重试参数注册任务', async () => {
    await service.schedule(input);

    expect(queue.add).toHaveBeenCalledWith(
      'settle-idle-session',
      input,
      expect.objectContaining({
        jobId: 'memory-settlement:session-1',
        delay: 3 * 24 * 60 * 60 * 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60 * 1000 },
      }),
    );
  });

  it('刷新时移除旧 delayed job 后复用固定 jobId', async () => {
    const existing = {
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    queue.getJob.mockResolvedValue(existing);

    await service.schedule(input, 456);

    expect(existing.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'settle-idle-session',
      input,
      expect.objectContaining({ jobId: 'memory-settlement:session-1', delay: 456 }),
    );
  });

  it('旧任务已 active 时保留它并注册唯一接替任务', async () => {
    const existing = {
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    };
    queue.getJob.mockResolvedValue(existing);

    await service.schedule(input);

    expect(existing.remove).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'settle-idle-session',
      input,
      expect.objectContaining({ jobId: 'memory-settlement:session-1:123' }),
    );
  });
});

