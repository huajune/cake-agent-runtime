import { Logger } from '@nestjs/common';
import {
  PostBookingInviteRateCronService,
  summarizePostBookingInviteOutcomes,
} from '@biz/ops-events/crons/post-booking-invite-rate.cron';

const WINDOW = { sinceReportDate: '2026-09-14', untilReportDate: '2026-09-20' };

describe('summarizePostBookingInviteOutcomes', () => {
  it('分子=invited+already_in_group，城市无群不进分母，skipped 不进分母，旧事件无字段剔除', () => {
    const summary = summarizePostBookingInviteOutcomes(
      [
        { outcome: 'invited' },
        { outcome: 'invited' },
        { outcome: 'already_in_group' },
        { outcome: 'failed:group_full' },
        { outcome: 'failed:no_group_in_city' },
        { outcome: 'skipped:group_chat' },
        { outcome: 'skipped:city_unknown' },
        { outcome: null },
      ],
      WINDOW,
    );

    expect(summary).toEqual({
      ...WINDOW,
      total: 7,
      eligible: 4,
      succeeded: 3,
      rate: 0.75,
      failedByReason: { 'failed:group_full': 1, 'failed:no_group_in_city': 1 },
      skippedByReason: { 'skipped:group_chat': 1, 'skipped:city_unknown': 1 },
    });
  });

  it('没有可归因样本时 rate 为 null', () => {
    expect(
      summarizePostBookingInviteOutcomes([{ outcome: 'skipped:group_chat' }], WINDOW).rate,
    ).toBe(null);
  });
});

describe('PostBookingInviteRateCronService.check', () => {
  const repository = { findBookingGroupInviteOutcomes: jest.fn() };
  const alertNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
  const config = {
    get: (key: string, fallback?: string) => {
      if (key === 'POST_BOOKING_INVITE_RATE_MIN_SAMPLES') return '3';
      return fallback;
    },
  };
  const service = new PostBookingInviteRateCronService(
    repository as never,
    alertNotifier as never,
    config as never,
  );
  const outcomes = (...values: string[]) => values.map((outcome) => ({ botImId: 'bot', outcome }));

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('低于阈值且样本够时发飞书告警（按窗口去重）', async () => {
    repository.findBookingGroupInviteOutcomes.mockResolvedValue(
      outcomes('invited', 'failed:group_full', 'failed:api_rejected', 'failed:exception'),
    );

    const summary = await service.check(WINDOW);

    expect(summary.rate).toBe(0.25);
    expect(alertNotifier.sendAlert).toHaveBeenCalledTimes(1);
    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ops.post_booking_invite_rate_low',
        summary: expect.stringContaining('25.0% 低于阈值 80%'),
        dedupe: { key: 'ops.post_booking_invite_rate_low:2026-09-20' },
      }),
    );
  });

  it('达到阈值不告警', async () => {
    repository.findBookingGroupInviteOutcomes.mockResolvedValue(
      outcomes('invited', 'invited', 'already_in_group', 'invited', 'failed:group_full'),
    );
    const summary = await service.check(WINDOW);
    expect(summary.rate).toBe(0.8);
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('样本不足不告警（避免小样本误报）', async () => {
    repository.findBookingGroupInviteOutcomes.mockResolvedValue(
      outcomes('failed:group_full', 'failed:api_rejected'),
    );
    const summary = await service.check(WINDOW);
    expect(summary.rate).toBe(0);
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });
});

describe('PostBookingInviteRateCronService.run 护栏', () => {
  const repository = { findBookingGroupInviteOutcomes: jest.fn().mockResolvedValue([]) };
  const alertNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
  const makeService = (configMap: Record<string, string | undefined>) =>
    new PostBookingInviteRateCronService(
      repository as never,
      alertNotifier as never,
      { get: (key: string, fallback?: string) => configMap[key] ?? fallback } as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  it('非生产环境不运行', async () => {
    await makeService({ NODE_ENV: 'development' }).run();
    expect(repository.findBookingGroupInviteOutcomes).not.toHaveBeenCalled();
  });

  it('RUNTIME_ENV=production 优先于 NODE_ENV', async () => {
    await makeService({ RUNTIME_ENV: 'production', NODE_ENV: 'development' }).run();
    expect(repository.findBookingGroupInviteOutcomes).toHaveBeenCalledTimes(1);
  });

  it('READ_ONLY_PREVIEW 跳过', async () => {
    await makeService({ NODE_ENV: 'production', READ_ONLY_PREVIEW: 'true' }).run();
    expect(repository.findBookingGroupInviteOutcomes).not.toHaveBeenCalled();
  });
});
