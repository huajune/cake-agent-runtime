import { Injectable, Logger } from '@nestjs/common';
import { NotificationStrategy } from './notification.strategy';
import { GroupTaskType, GroupContext, NotificationData } from '../group-task.types';
import { WORK_TIPS_SYSTEM_PROMPT, buildWorkTipsUserMessage } from '../prompts/work-tips.prompt';

/**
 * 获取 ISO 周数
 */
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * 工作小贴士策略
 *
 * - 纯 AI 生成，无需外部数据
 * - 每周六 15:00 发到所有兼职群
 * - 用周数作为种子，保证同一周所有群收到相同主题
 */
@Injectable()
export class WorkTipsStrategy implements NotificationStrategy {
  private readonly logger = new Logger(WorkTipsStrategy.name);

  readonly type = GroupTaskType.WORK_TIPS;
  readonly tagPrefix = '兼职群';
  readonly needsAI = true;

  async fetchData(context: GroupContext): Promise<NotificationData> {
    const weekNumber = getISOWeekNumber(new Date());
    this.logger.log(`[工作小贴士] ${context.industry || '餐饮'} 第${weekNumber}周`);
    return {
      hasData: true,
      payload: { industry: context.industry || '餐饮', weekNumber },
      summary: `第${weekNumber}周工作小贴士`,
    };
  }

  buildPrompt(
    data: NotificationData,
    _context: GroupContext,
  ): { systemPrompt: string; userMessage: string } {
    return {
      systemPrompt: WORK_TIPS_SYSTEM_PROMPT,
      userMessage: buildWorkTipsUserMessage({
        industry: data.payload.industry as string,
        weekNumber: data.payload.weekNumber as number,
      }),
    };
  }
}
