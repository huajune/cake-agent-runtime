import { Injectable, Logger } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { NotificationStrategy } from './notification.strategy';
import { GroupTaskType, GroupContext, NotificationData } from '../group-task.types';
import { buildOrderGrabMessage } from '../prompts/order-grab.prompt';

/**
 * 日期格式化 YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * 抢单群通知策略（纯模板，不需要 AI）
 *
 * - 数据源：观远BI (SpongeService.fetchBIOrders)
 * - 每天3次，按城市筛选订单
 * - 标题用固定规则选择
 */
@Injectable()
export class OrderGrabStrategy implements NotificationStrategy {
  private readonly logger = new Logger(OrderGrabStrategy.name);

  readonly type = GroupTaskType.ORDER_GRAB;
  readonly tagPrefix = '抢单群';
  readonly needsAI = false;

  constructor(private readonly spongeService: SpongeService) {}

  async fetchData(context: GroupContext): Promise<NotificationData> {
    const today = new Date();
    const sunday = new Date(today);
    const dayOfWeek = today.getDay(); // 0=周日
    sunday.setDate(today.getDate() + (dayOfWeek === 0 ? 0 : 7 - dayOfWeek));

    const orders = await this.spongeService.fetchBIOrders({
      startDate: formatDate(today),
      endDate: formatDate(sunday),
      regionName: context.city,
    });

    this.logger.log(`[抢单群] ${context.city}: ${orders.length}个订单`);

    return {
      hasData: orders.length > 0,
      payload: { orders, city: context.city },
      summary: `${context.city}: ${orders.length}个订单`,
    };
  }

  buildMessage(data: NotificationData, context: GroupContext): string {
    return buildOrderGrabMessage({
      orders: data.payload.orders as Record<string, unknown>[],
      city: context.city,
    });
  }
}
