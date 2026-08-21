import { OpsEventsRepository } from '@biz/ops-events/repositories/ops-events.repository';
import { toErrorStack } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { FollowUpSchedulerService } from './follow-up-scheduler.service';

const LOOKBACK_MS = 48 * 60 * 60_000;

/** 面试通过事件的短窗 sweep：只补排 D+3 入职跟进，Bull 稳定 jobId 负责跨轮幂等。 */
@Injectable()
export class OnboardingSweepCronService {
  private readonly logger = new Logger(OnboardingSweepCronService.name);
  private running = false;

  constructor(
    private readonly opsEventsRepository: OpsEventsRepository,
    private readonly scheduler: FollowUpSchedulerService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('*/15 * * * *', { timeZone: 'Asia/Shanghai' })
  async sweep(): Promise<void> {
    if (this.isReadOnlyPreview()) return;
    if (this.running) {
      this.logger.warn('上一轮入职跟进 sweep 尚未结束，跳过本次');
      return;
    }

    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('入职跟进 sweep 失败', toErrorStack(error));
    } finally {
      this.running = false;
    }
  }

  async runOnce(now = new Date()): Promise<{ scanned: number; scheduled: number }> {
    const { events, skipped } = await this.opsEventsRepository.findRecentInterviewPassed(
      new Date(now.getTime() - LOOKBACK_MS),
      now,
    );
    let scheduled = 0;
    for (const event of events) {
      const result = await this.scheduler.scheduleFollowUp({
        sessionRef: {
          corpId: event.corpId,
          userId: event.userId,
          sessionId: event.chatId,
        },
        scenarioCode: 'post_interview_onboarding',
        anchorEventId: `wo${event.workOrderId}:pass`,
        anchorAt: new Date(event.occurredAt).getTime(),
        workOrderId: event.workOrderId,
        channelIdentity: event.botImId ? { botImId: event.botImId } : undefined,
      });
      if (result.scheduled) scheduled += 1;
    }
    this.logger.log(
      `入职跟进 sweep 完成: 扫描=${events.length}, 跳过=${skipped}, 新排程=${scheduled}`,
    );
    return { scanned: events.length, scheduled };
  }

  private isReadOnlyPreview(): boolean {
    return this.configService.get<string>('READ_ONLY_PREVIEW', 'false') === 'true';
  }
}
