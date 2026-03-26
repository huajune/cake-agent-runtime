import { GroupTaskType, GroupContext, NotificationData, TimeSlot } from '../group-task.types';

/**
 * 通知策略接口
 *
 * 四种通知类型各自实现此接口，由 GroupTaskSchedulerService 统一编排。
 * - 模板策略（兼职群/抢单群/店长群）：fetchData + buildMessage（纯模板）
 * - AI 策略（工作小贴士）：fetchData + buildPrompt（需要 AI 生成）
 */
export interface NotificationStrategy {
  /** 策略类型标识 */
  readonly type: GroupTaskType;

  /** 群标签前缀，用于匹配目标群（如 '抢单群'、'兼职群'、'店长群'） */
  readonly tagPrefix: string;

  /** 是否需要 AI 生成（false = 纯模板，true = 需要调用 CompletionService） */
  readonly needsAI: boolean;

  /** 从外部数据源获取该群所需数据 */
  fetchData(context: GroupContext): Promise<NotificationData>;

  /** 根据数据直接生成消息文本（模板策略） */
  buildMessage?(data: NotificationData, context: GroupContext, timeSlot?: TimeSlot): string;

  /** 构建 AI 提示词（AI 策略） */
  buildPrompt?(
    data: NotificationData,
    context: GroupContext,
  ): { systemPrompt: string; userMessage: string };

  /** AI 生成后追加固定内容（可选） */
  appendFooter?(aiMessage: string, data: NotificationData): string;
}
