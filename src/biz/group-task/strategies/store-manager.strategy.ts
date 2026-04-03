import { Injectable, Logger } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { formatLocalDate } from '@infra/utils/date.util';
import { NotificationStrategy } from './notification.strategy';
import { GroupTaskType, GroupContext, NotificationData } from '../group-task.types';
import { InterviewScheduleItem } from '@sponge/sponge.types';
import { buildStoreManagerMessage } from '../prompts/store-manager.prompt';

const STORE_MANAGER_TARGET_BRAND = '成都你六姐';

/**
 * 店长群通知策略（纯模板，不需要 AI）
 *
 * - 数据源：海绵面试名单 (SpongeService.fetchInterviewSchedule)
 * - 发送当日面试安排到店长群
 */
@Injectable()
export class StoreManagerStrategy implements NotificationStrategy {
  private readonly logger = new Logger(StoreManagerStrategy.name);

  readonly type = GroupTaskType.STORE_MANAGER;
  readonly tagPrefix = '店长群';
  readonly needsAI = false;

  constructor(private readonly spongeService: SpongeService) {}

  async fetchData(context: GroupContext): Promise<NotificationData> {
    const dateStr = formatLocalDate(new Date());
    const startTime = `${dateStr} 00:00:00`;
    const endTime = `${dateStr} 23:59:59`;

    const interviews = await this.spongeService.fetchInterviewSchedule({
      interviewStartTime: startTime,
      interviewEndTime: endTime,
      brandName: STORE_MANAGER_TARGET_BRAND,
    });

    this.logger.log(
      `[店长群] ${context.groupName} → ${STORE_MANAGER_TARGET_BRAND} 今日面试: ${interviews.length}人`,
    );

    // 即使无面试也发通知（"今日无面试安排"）
    return {
      hasData: true,
      payload: { interviews, date: dateStr },
      summary: `${STORE_MANAGER_TARGET_BRAND}: ${interviews.length}人面试`,
    };
  }

  buildMessage(data: NotificationData): string {
    const result = buildStoreManagerMessage({
      interviews: data.payload.interviews as InterviewScheduleItem[],
      date: data.payload.date as string,
    });
    // 跟随消息存入 payload，由 scheduler 发送完主消息后单独发送
    if (result.followUp) {
      data.payload.followUpMessage = result.followUp;
    }
    return result.main;
  }
}
