import { ConsolidationSchedulerService } from '@memory/long-term/consolidation-scheduler.service';

describe('ConsolidationSchedulerService', () => {
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
  let service: ConsolidationSchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    queue.getJob.mockResolvedValue(null);
    service = new ConsolidationSchedulerService(
      queue as never,
      { consolidationGapSeconds: 3 * 24 * 60 * 60 } as never,
    );
  });

  it('按 3 天 delay 与重试参数注册任务', async () => {
    await service.schedule(input);

    expect(queue.add).toHaveBeenCalledWith(
      'consolidate-idle-session',
      input,
      expect.objectContaining({
        jobId: 'memory-consolidation:session-1',
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
      'consolidate-idle-session',
      input,
      expect.objectContaining({ jobId: 'memory-consolidation:session-1', delay: 456 }),
    );
  });

  it('每轮复用尚未到期任务，不移除重建', async () => {
    const existing = {
      data: input,
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn(),
      update: jest.fn(),
    };
    queue.getJob.mockResolvedValue(existing);
    await service.schedule(input);
    await service.schedule({ ...input, activityAt: 456 });
    expect(existing.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(existing.update).not.toHaveBeenCalled();
  });

  it.each(['delayed', 'waiting', 'paused'])(
    '复用 %s 任务时补齐身份，保留原到期调度',
    async (state) => {
      const existing = {
        data: input,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      };
      queue.getJob.mockResolvedValue(existing);
      await service.schedule({
        ...input,
        botUserId: 'stable-bot',
        botImId: 'new-wxid',
        activityAt: 456,
      });
      expect(existing.update).toHaveBeenCalledWith({
        ...input,
        botUserId: 'stable-bot',
        botImId: 'new-wxid',
      });
      expect(existing.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('后续缺席身份不抹掉已知身份，更新失败必须传播', async () => {
    const existing = {
      data: { ...input, botUserId: 'stable-bot' },
      getState: jest.fn().mockResolvedValue('delayed'),
      update: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    queue.getJob.mockResolvedValue(existing);
    await service.schedule({ ...input, botImId: undefined });
    expect(existing.update).not.toHaveBeenCalled();
    await expect(service.schedule({ ...input, botImId: 'new-wxid' })).rejects.toThrow(
      'redis unavailable',
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
      'consolidate-idle-session',
      input,
      expect.objectContaining({ jobId: 'memory-consolidation:session-1:123' }),
    );
  });
});
