import { HostingPauseInspectionCron } from '@biz/intervention/hosting-pause-inspection.cron';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 永久暂停超期巡检（PRD R5.2）：source=intervention 的永久暂停超过 3 天未恢复 → 飞书提醒，
 * 每会话（同一次暂停）只提醒一次，Redis 幂等；失败释放键下轮重试。
 */
describe('HostingPauseInspectionCron.runOnce', () => {
  const now = Date.UTC(2026, 8, 22, 4, 0, 0);
  const userHostingService = { getPausedUsersWithProfiles: jest.fn() };
  const redisService = { setNx: jest.fn(), del: jest.fn(), eval: jest.fn() };
  const notifier = { notifyPauseOverdue: jest.fn() };

  const cron = new HostingPauseInspectionCron(
    userHostingService as never,
    redisService as never,
    notifier as never,
  );

  const entry = (
    userId: string,
    ageDays: number,
    overrides: Partial<{ isPermanent: boolean; pauseSource: string }> = {},
  ) => ({
    userId,
    pausedAt: now - ageDays * DAY_MS,
    pauseExpiresAt: null,
    isPermanent: true,
    pauseSource: 'intervention',
    pauseReason: '面试后人工对接，需人工恢复托管',
    odName: '张三',
    botUserId: 'manager-1',
    imBotId: 'bot-im-1',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    redisService.setNx.mockResolvedValue(true);
    redisService.del.mockResolvedValue(1);
    notifier.notifyPauseOverdue.mockResolvedValue(true);
  });

  it('alerts only permanent intervention pauses older than 3 days', async () => {
    userHostingService.getPausedUsersWithProfiles.mockResolvedValue([
      entry('chat-old', 4),
      entry('chat-fresh', 2),
      entry('chat-temp', 5, { isPermanent: false }),
      entry('chat-blacklist', 9, { pauseSource: 'blacklist' }),
    ]);

    const result = await cron.runOnce(now);

    expect(result).toEqual({ scanned: 4, overdue: 1, alerted: 1, skipped: 0 });
    expect(notifier.notifyPauseOverdue).toHaveBeenCalledTimes(1);
    expect(notifier.notifyPauseOverdue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-old',
        overdueDays: 4,
        pauseReason: '面试后人工对接，需人工恢复托管',
        contactName: '张三',
        botUserName: 'manager-1',
        botImId: 'bot-im-1',
      }),
    );
    expect(redisService.setNx).toHaveBeenCalledWith(
      `intervention:pause_overdue:alerted:chat-old:${now - 4 * DAY_MS}`,
      now,
      30 * 24 * 60 * 60,
    );
  });

  it('is idempotent per session: an already-alerted pause is skipped', async () => {
    userHostingService.getPausedUsersWithProfiles.mockResolvedValue([entry('chat-old', 4)]);
    redisService.setNx.mockResolvedValue(false);

    const result = await cron.runOnce(now);

    expect(result).toEqual({ scanned: 1, overdue: 1, alerted: 0, skipped: 1 });
    expect(notifier.notifyPauseOverdue).not.toHaveBeenCalled();
  });

  it('releases the idempotency key when the notification fails so the next run retries', async () => {
    userHostingService.getPausedUsersWithProfiles.mockResolvedValue([entry('chat-old', 4)]);
    notifier.notifyPauseOverdue.mockResolvedValue(false);

    const result = await cron.runOnce(now);

    expect(result.alerted).toBe(0);
    expect(redisService.del).toHaveBeenCalledWith(
      `intervention:pause_overdue:alerted:chat-old:${now - 4 * DAY_MS}`,
    );
  });

  it('caps alerts per run so a backlog is drained across runs', async () => {
    userHostingService.getPausedUsersWithProfiles.mockResolvedValue(
      Array.from({ length: 35 }, (_, index) => entry(`chat-${index}`, 4)),
    );

    const result = await cron.runOnce(now);

    expect(result).toEqual({ scanned: 35, overdue: 35, alerted: 30, skipped: 5 });
    expect(notifier.notifyPauseOverdue).toHaveBeenCalledTimes(30);
  });
});
