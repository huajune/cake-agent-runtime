import type { Job } from 'bull';
import {
  ReengagementHostingRecoveryService,
  HOSTING_RECOVERY_MAX_WAIT_MS,
} from '@agent/reengagement/hosting-recovery.service';
import type { FollowUpJob } from '@agent/reengagement/follow-up-scheduler.service';

describe('ReengagementHostingRecoveryService', () => {
  const now = Date.UTC(2026, 10, 16, 3, 30);
  const identity = {
    sessionId: 'chat-1',
    corpId: 'corp-1',
    userId: 'user-1',
    scenarioCode: 'interview_reminder',
    anchorEventId: 'wo-42:reminder',
    anchorAt: now - 3600_000,
    botImId: 'bot-1',
    imContactId: 'contact-1',
  };
  let service: ReengagementHostingRecoveryService;
  let queue: { add: jest.Mock };
  let bots: { getConfiguredBotList: jest.Mock };
  let ledger: { markWaitingForHosting: jest.Mock };
  let tracking: { trackHostingDeferred: jest.Mock; trackStopped: jest.Mock };
  let random: jest.SpyInstance<number, []>;

  function makeJob(data?: FollowUpJob): Job<FollowUpJob> {
    const job = {
      data: data ?? {
        sessionRef: { sessionId: 'chat-1', corpId: 'corp-1', userId: 'user-1' },
        scenarioCode: 'interview_reminder',
        anchorEventId: identity.anchorEventId,
        anchorAt: identity.anchorAt,
        workOrderId: 42,
        touchVariant: 'd2_confirm',
      },
      update: jest.fn(async (next: FollowUpJob) => {
        job.data = next;
      }),
    };
    return job as unknown as Job<FollowUpJob>;
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    // 独立供应商协议样本：1=离线、2=在线，不能与常量同源而掩盖值漂移。
    bots = { getConfiguredBotList: jest.fn().mockResolvedValue([{ wxid: 'bot-1', status: 1 }]) };
    ledger = { markWaitingForHosting: jest.fn().mockResolvedValue(true) };
    tracking = { trackHostingDeferred: jest.fn(), trackStopped: jest.fn() };
    service = new ReengagementHostingRecoveryService(
      queue as never,
      bots as never,
      ledger as never,
      tracking as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('离线时持久化随机检查时间，沿用触达身份、工单与档位', async () => {
    const job = makeJob();
    expect(await service.deferIfUnavailable(job, identity)).toBe(true);
    expect(job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        hostingRecovery: { firstDeferredAt: now, attempt: 1, retryAt: now + 45_000 },
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'follow-up',
      expect.objectContaining({
        anchorEventId: 'wo-42:reminder',
        anchorAt: identity.anchorAt,
        workOrderId: 42,
        touchVariant: 'd2_confirm',
        channelIdentity: expect.objectContaining({ botImId: 'bot-1', imContactId: 'contact-1' }),
        hostingRecovery: { firstDeferredAt: now, attempt: 1 },
      }),
      expect.objectContaining({
        jobId: 'chat-1:interview_reminder:wo-42:reminder:hosting-recovery:1',
        delay: 45_000,
      }),
    );
    expect(tracking.trackHostingDeferred).toHaveBeenCalledWith(
      identity,
      'chat-1:interview_reminder:wo-42:reminder:hosting-recovery:1',
      now + 45_000,
      1,
    );
    expect(bots.getConfiguredBotList).toHaveBeenCalledWith(true);
  });

  it('同一时刻进入同一轮次的不同任务各自采样，错开检查时间', async () => {
    random.mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const first = makeJob();
    const second = makeJob({ ...first.data, anchorEventId: 'wo-43:reminder', workOrderId: 43 });
    await service.defer(first, identity);
    await service.defer(second, { ...identity, anchorEventId: 'wo-43:reminder' });
    expect(queue.add.mock.calls.map((call) => call[2].delay)).toEqual([33_000, 57_000]);
  });

  it('恢复任务只在原账号明确在线后放行，其他账号在线无效', async () => {
    await service.defer(makeJob(), identity);
    const retry = makeJob(queue.add.mock.calls[0][1]);
    bots.getConfiguredBotList.mockResolvedValue([{ wxid: 'another-bot', status: 2 }]);
    expect(await service.deferIfUnavailable(retry, identity)).toBe(true);
    jest.advanceTimersByTime(5_001);
    bots.getConfiguredBotList.mockResolvedValue([{ wxid: 'bot-1', status: 2 }]);
    const next = makeJob(queue.add.mock.calls[1][1]);
    expect(await service.deferIfUnavailable(next, identity)).toBe(false);
  });

  it('账号状态读取失败时恢复任务继续等待，不生成发送', async () => {
    await service.defer(makeJob(), identity);
    bots.getConfiguredBotList.mockRejectedValue(new Error('directory unavailable'));
    expect(await service.deferIfUnavailable(makeJob(queue.add.mock.calls[0][1]), identity)).toBe(
      true,
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('Bull 入队失败后重启，复用持久化的随机时间与轮次，不重新抽样或推迟截止时间', async () => {
    const job = makeJob();
    random.mockReturnValueOnce(0.25).mockReturnValue(0.9);
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(service.defer(job, identity)).rejects.toThrow('redis unavailable');
    const restored = makeJob(JSON.parse(JSON.stringify(job.data)) as FollowUpJob);
    jest.setSystemTime(now + 10_000);
    expect(await service.continuePending(restored, identity)).toBe(true);
    expect(restored.data.hostingRecovery).toEqual({
      firstDeferredAt: now,
      attempt: 1,
      retryAt: now + 37_500,
    });
    expect(queue.add.mock.calls[1][1]).toEqual(queue.add.mock.calls[0][1]);
    expect(queue.add.mock.calls[1][2]).toEqual({
      ...queue.add.mock.calls[0][2],
      delay: 27_500,
    });
    expect(restored.update).not.toHaveBeenCalled();
  });

  it('触达槽写入失败时仍保留原 job 的待补排程义务', async () => {
    const job = makeJob();
    ledger.markWaitingForHosting.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(service.defer(job, identity)).rejects.toThrow('ledger unavailable');
    expect(queue.add).not.toHaveBeenCalled();
    expect(await service.continuePending(makeJob(job.data), identity)).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('明确拒收证据随原 job 持久化，补排可恢复 attempted 槽且子任务不能沿用旧证据', async () => {
    const job = makeJob();
    ledger.markWaitingForHosting.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(service.defer(job, identity, true)).rejects.toThrow('ledger unavailable');
    const restored = makeJob(JSON.parse(JSON.stringify(job.data)) as FollowUpJob);
    expect(restored.data.hostingRecovery?.deliveryRejected).toBe(true);
    expect(await service.continuePending(restored, identity)).toBe(true);
    expect(ledger.markWaitingForHosting).toHaveBeenLastCalledWith(
      'chat-1:interview_reminder:wo-42:reminder',
      1,
      true,
    );
    expect(queue.add.mock.calls[0][1].hostingRecovery).toEqual({
      firstDeferredAt: now,
      attempt: 1,
    });
  });

  it('已发送/未知触达槽拒绝延后，不绕过原防重状态', async () => {
    ledger.markWaitingForHosting.mockResolvedValue(false);
    await service.defer(makeJob(), identity);
    expect(queue.add).not.toHaveBeenCalled();
    expect(tracking.trackHostingDeferred).not.toHaveBeenCalled();
  });

  it.each([
    { sample: 0, delays: [30_000, 60_000, 120_000, 150_000, 150_000] },
    { sample: 0.5, delays: [45_000, 90_000, 180_000, 225_000, 225_000] },
    { sample: 1 - Number.EPSILON, delays: [59_999, 119_999, 239_999, 299_999, 299_999] },
  ])(
    '每轮按退避基准的 50%～100% 采样且 24h 预算不重置（sample=$sample）',
    async ({ sample, delays }) => {
      random.mockReturnValue(sample);
      let job = makeJob();
      for (const delay of delays) {
        await service.defer(job, identity);
        const call = queue.add.mock.calls.at(-1)!;
        expect(call[2].delay).toBe(delay);
        expect(call[1].hostingRecovery.firstDeferredAt).toBe(now);
        job = makeJob(call[1]);
        jest.advanceTimersByTime(delay);
      }
      jest.setSystemTime(now + HOSTING_RECOVERY_MAX_WAIT_MS - 1);
      expect(await service.continuePending(job, identity)).toBe(false);
      jest.setSystemTime(now + HOSTING_RECOVERY_MAX_WAIT_MS);
      expect(await service.continuePending(job, identity)).toBe(true);
      expect(tracking.trackStopped).toHaveBeenCalledWith(identity, 'hosting_recovery_expired');
      expect(queue.add).toHaveBeenCalledTimes(5);
    },
  );
});
