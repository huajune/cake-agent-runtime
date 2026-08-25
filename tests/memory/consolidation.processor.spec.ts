import { ConsolidationProcessor } from '@memory/long-term/consolidation.processor';

describe('ConsolidationProcessor', () => {
  const queue = { process: jest.fn() };
  const session = { getSessionState: jest.fn() };
  const consolidation = { settleIdleSession: jest.fn() };
  const scheduler = { schedule: jest.fn().mockResolvedValue('job-2') };
  const incidents = { notify: jest.fn().mockResolvedValue(true) };
  const data = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
    botUserId: 'wecom-user-1',
    botImId: 'bot-1',
    activityAt: 100,
  };

  let processor: ConsolidationProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    session.getSessionState.mockResolvedValue({
      facts: { brand: { currentBrand: null, excludedBrands: [], updatedAtMs: 1 } },
    });
    consolidation.settleIdleSession.mockResolvedValue({
      status: 'settled',
      latestMessageAt: 100,
    });
    processor = new ConsolidationProcessor(
      queue as never,
      session as never,
      consolidation as never,
      scheduler as never,
      incidents as never,
    );
  });

  const makeJob = (attemptsMade = 0) =>
    ({ data, attemptsMade, opts: { attempts: 3 } }) as never;

  it('注册 Bull processor，并在触发时重读 facts', async () => {
    processor.onModuleInit();
    expect(queue.process).toHaveBeenCalledWith(
      'consolidate-idle-session',
      2,
      expect.any(Function),
    );

    await processor.process(makeJob());
    expect(session.getSessionState).toHaveBeenCalledWith('corp-1', 'user-1', 'session-1');
    expect(consolidation.settleIdleSession).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      'wecom-user-1',
      expect.any(Object),
      'bot-1',
      expect.any(Object),
    );
  });

  it('新消息导致闲置不足时按剩余 delay 重新排程', async () => {
    consolidation.settleIdleSession.mockResolvedValue({
      status: 'not_idle',
      latestMessageAt: 200,
      retryDelayMs: 300,
    });

    await processor.process(makeJob());

    expect(scheduler.schedule).toHaveBeenCalledWith({ ...data, activityAt: 200 }, 300);
  });

  it('非最终失败向 Bull 抛出但不提前告警', async () => {
    consolidation.settleIdleSession.mockRejectedValue(new Error('db down'));

    await expect(processor.process(makeJob(0))).rejects.toThrow('db down');
    expect(incidents.notify).not.toHaveBeenCalled();
  });

  it('最终失败先写持久化告警再向 Bull 抛出', async () => {
    consolidation.settleIdleSession.mockRejectedValue(new Error('db down'));

    await expect(processor.process(makeJob(2))).rejects.toThrow('db down');
    expect(incidents.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'memory.consolidation_failed',
        source: expect.objectContaining({ subsystem: 'memory', trigger: 'queue' }),
        scope: { userId: 'user-1', sessionId: 'session-1' },
      }),
    );
  });
});
