import { OnboardingSweepCronService } from '@agent/reengagement/onboarding-sweep.cron';
import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { OpsEventsRepository } from '@biz/ops-events/repositories/ops-events.repository';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

describe('OnboardingSweepCronService', () => {
  const now = new Date('2026-08-20T10:00:00.000Z');
  let repository: { findRecentInterviewPassed: jest.Mock };
  let scheduler: { scheduleFollowUp: jest.Mock };
  let config: { get: jest.Mock };
  let service: OnboardingSweepCronService;

  beforeEach(async () => {
    repository = {
      findRecentInterviewPassed: jest.fn().mockResolvedValue({
        events: [
          {
            corpId: 'corp-1',
            userId: 'user-1',
            chatId: 'chat-1',
            botImId: 'bot-1',
            workOrderId: 901,
            occurredAt: '2026-08-18T10:00:00.000Z',
          },
        ],
        skipped: 1,
      }),
    };
    const scheduledJobIds = new Set<string>();
    scheduler = {
      scheduleFollowUp: jest.fn(async (input: { anchorEventId: string }) => {
        if (scheduledJobIds.has(input.anchorEventId)) {
          return { scheduled: false, reason: 'duplicate_job' };
        }
        scheduledJobIds.add(input.anchorEventId);
        return { scheduled: true };
      }),
    };
    config = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OnboardingSweepCronService,
        { provide: OpsEventsRepository, useValue: repository },
        { provide: FollowUpSchedulerService, useValue: scheduler },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(OnboardingSweepCronService);
  });

  it('uses a stable work-order anchor so two sweeps create only one task', async () => {
    await expect(service.runOnce(now)).resolves.toEqual({ scanned: 1, scheduled: 1 });
    await expect(service.runOnce(now)).resolves.toEqual({ scanned: 1, scheduled: 0 });

    expect(scheduler.scheduleFollowUp).toHaveBeenNthCalledWith(1, {
      sessionRef: { corpId: 'corp-1', userId: 'user-1', sessionId: 'chat-1' },
      scenarioCode: 'post_interview_onboarding',
      anchorEventId: 'wo901:pass',
      anchorAt: new Date('2026-08-18T10:00:00.000Z').getTime(),
      workOrderId: 901,
      channelIdentity: { botImId: 'bot-1' },
    });
    expect(scheduler.scheduleFollowUp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ anchorEventId: 'wo901:pass' }),
    );
  });

  it('queries an inclusive 48-hour event window', async () => {
    await service.runOnce(now);

    expect(repository.findRecentInterviewPassed).toHaveBeenCalledWith(
      new Date('2026-08-18T10:00:00.000Z'),
      now,
    );
  });

  it('reports interview.passed rows skipped for missing scheduling identity', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.runOnce(now);

    expect(log).toHaveBeenCalledWith('入职跟进 sweep 完成: 扫描=1, 跳过=1, 新排程=1');
    log.mockRestore();
  });

  it('skips the sweep in READ_ONLY_PREVIEW', async () => {
    config.get.mockReturnValue('true');

    await service.sweep();

    expect(repository.findRecentInterviewPassed).not.toHaveBeenCalled();
    expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
  });
});
