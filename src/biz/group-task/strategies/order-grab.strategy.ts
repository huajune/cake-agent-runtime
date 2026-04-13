import { Injectable, Logger } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { NotificationStrategy } from './notification.strategy';
import {
  GroupTaskType,
  GroupContext,
  NotificationData,
  TimeSlot,
  BIOrder,
  BI_FIELD_NAMES,
  BI_ORDER_STATUS,
} from '../group-task.types';
import { buildOrderGrabMessage } from '../prompts/order-grab.prompt';
import { formatLocalDate } from '@infra/utils/date.util';

/**
 * 抢单群通知策略（纯模板，不需要 AI）
 *
 * - 数据源：观远BI (SpongeService.fetchBIOrders)
 * - 三个场次按时间维度筛选不同日期的订单：
 *   - 上午场 10:00 → 当日订单（再按最早开始时间过滤，只保留计划时间 ≥10:30 的订单）
 *   - 下午场 13:00 → 次日订单
 *   - 晚上场 17:30 → 本周周六/周日订单（周一作为周首）
 * - 无场次时回退到"今天 → 本周日"，保留原行为兼容手动触发
 */
@Injectable()
export class OrderGrabStrategy implements NotificationStrategy {
  private readonly logger = new Logger(OrderGrabStrategy.name);
  private readonly morningOrderStartCutoffMinutes = 10 * 60 + 30;

  readonly type = GroupTaskType.ORDER_GRAB;
  readonly tagPrefix = '抢单群';
  readonly needsAI = false;

  constructor(private readonly spongeService: SpongeService) {}

  async prepareTask(): Promise<void> {
    const refreshed = await this.spongeService.refreshBIDataSourceAndWait();
    if (refreshed) {
      this.logger.log('[抢单群] BI 数据源已刷新，本轮任务将复用该结果');
      return;
    }

    this.logger.warn('[抢单群] BI 数据源刷新失败，继续使用当前可用数据');
  }

  async fetchData(context: GroupContext, timeSlot?: TimeSlot): Promise<NotificationData> {
    const { startDate, endDate, label } = this.resolveDateRange(timeSlot);

    let orders = await this.fetchOrdersWithFallback(context.city, startDate, endDate);

    // 上午场只发最早开工时间不早于 10:30 的订单
    if (timeSlot === TimeSlot.MORNING) {
      orders = orders.filter((order) =>
        this.startsAtOrAfter(order, this.morningOrderStartCutoffMinutes),
      );
    }

    // 下午场无数据时，往后逐天顺延到本周日
    let actualLabel = label;
    if (orders.length === 0 && timeSlot === TimeSlot.AFTERNOON) {
      const result = await this.lookaheadOrders(context.city, startDate);
      if (result) {
        orders = result.orders;
        actualLabel = result.label;
      }
    }

    this.logger.log(
      `[抢单群] ${context.city} ${actualLabel} (${startDate}~${endDate}): ${orders.length}个订单`,
    );

    return {
      hasData: orders.length > 0,
      payload: { orders, city: context.city },
      summary: `${context.city} ${actualLabel}: ${orders.length}个订单`,
    };
  }

  buildMessage(data: NotificationData, context: GroupContext, timeSlot?: TimeSlot): string {
    return buildOrderGrabMessage({
      orders: data.payload.orders as Record<string, unknown>[],
      city: context.city,
      timeSlot,
    });
  }

  /**
   * 根据场次解析订单归属日期范围
   */
  private resolveDateRange(timeSlot?: TimeSlot): {
    startDate: string;
    endDate: string;
    label: string;
  } {
    const today = new Date();

    if (timeSlot === TimeSlot.MORNING) {
      const date = formatLocalDate(today);
      return { startDate: date, endDate: date, label: '上午场[10:30后]' };
    }

    if (timeSlot === TimeSlot.AFTERNOON) {
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      const date = formatLocalDate(tomorrow);
      return { startDate: date, endDate: date, label: '下午场[次日]' };
    }

    if (timeSlot === TimeSlot.EVENING) {
      const { saturday, sunday } = this.getThisWeekend(today);
      return {
        startDate: formatLocalDate(saturday),
        endDate: formatLocalDate(sunday),
        label: '晚上场[本周末]',
      };
    }

    // 无场次兜底：今天 → 本周日（保留旧行为，避免破坏手动触发的语义）
    const sundayFallback = new Date(today);
    const dow = today.getDay();
    sundayFallback.setDate(today.getDate() + (dow === 0 ? 0 : 7 - dow));
    return {
      startDate: formatLocalDate(today),
      endDate: formatLocalDate(sundayFallback),
      label: '兜底',
    };
  }

  /**
   * 获取本周（周一为首日）的周六、周日 Date
   * - 工作日 / 周六 → 本周即将到来的周末
   * - 周日 → 周六=昨天、周日=今天（本周末已基本结束，但保持语义一致）
   */
  private getThisWeekend(today: Date): { saturday: Date; sunday: Date } {
    const dow = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    // 把 Sunday 当成第 7 天，方便从周一开始数
    const dayIndex = dow === 0 ? 7 : dow;
    const offsetToSat = 6 - dayIndex; // Mon: +5, Sat: 0, Sun: -1
    const offsetToSun = 7 - dayIndex; // Mon: +6, Sat: +1, Sun: 0

    const saturday = new Date(today);
    saturday.setDate(today.getDate() + offsetToSat);
    const sunday = new Date(today);
    sunday.setDate(today.getDate() + offsetToSun);
    return { saturday, sunday };
  }

  /**
   * 城市 → 所属企业精确映射。
   * BI 部分订单的城市字段为空，需要通过所属企业名匹配。
   * 注意：公司名和城市不是简单包含关系（如宁波隶属"上海必胜客有限公司宁波分公司"）。
   */
  private readonly CITY_COMPANY_MAP: Record<string, string> = {
    上海: '上海必胜客有限公司',
    宁波: '上海必胜客有限公司宁波分公司',
    北京: '北京必胜客比萨饼有限公司',
    武汉: '百胜餐饮（武汉）有限公司',
  };

  /**
   * 查订单：先按城市字段查，无结果时 fallback 到所属企业精确匹配。
   */
  private async fetchOrdersWithFallback(
    city: string,
    startDate: string,
    endDate: string,
  ): Promise<BIOrder[]> {
    const orders = await this.spongeService.fetchBIOrders({
      startDate,
      endDate,
      regionName: city,
      orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
    });

    if (orders.length > 0) return orders;

    // 城市字段无结果，用所属企业精确匹配兜底
    const companyName = this.CITY_COMPANY_MAP[city];
    if (!companyName) return [];

    const fallbackOrders = await this.spongeService.fetchBIOrders({
      startDate,
      endDate,
      companyName,
      orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
    });

    if (fallbackOrders.length > 0) {
      this.logger.log(
        `[抢单群] ${city} 城市字段无数据，通过所属企业「${companyName}」匹配到 ${fallbackOrders.length} 个订单`,
      );
    }

    return fallbackOrders;
  }

  /**
   * 下午场无数据时，往后逐天查找到本周日，找到最近有订单的日期。
   * 本周内都没有才放弃。
   */
  private async lookaheadOrders(
    city: string,
    baseDate: string,
  ): Promise<{ orders: BIOrder[]; label: string } | null> {
    const base = new Date(baseDate);
    const sunday = this.getEndOfWeek(base);
    const maxDays = Math.max(0, Math.round((sunday.getTime() - base.getTime()) / 86_400_000));

    for (let i = 1; i <= maxDays; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const date = formatLocalDate(d);

      const orders = await this.fetchOrdersWithFallback(city, date, date);

      if (orders.length > 0) {
        this.logger.log(`[抢单群] ${city} 次日无单，顺延到 ${date} 找到 ${orders.length} 个订单`);
        return { orders, label: `下午场[${date}]` };
      }
    }

    this.logger.log(`[抢单群] ${city} 本周内无订单，跳过`);
    return null;
  }

  /** 获取 date 所在周的周日 */
  private getEndOfWeek(date: Date): Date {
    const d = new Date(date);
    const dow = d.getDay(); // 0=Sun
    d.setDate(d.getDate() + (dow === 0 ? 0 : 7 - dow));
    return d;
  }

  /**
   * 判断订单的最早开始时间是否不早于指定阈值
   *
   * 字段格式示例：
   * - "16:00:00~20:00:00"
   * - "10:30:00~14:30:00,16:30:00~20:30:00"（多段，逗号分隔）
   */
  private startsAtOrAfter(order: BIOrder, cutoffMinutes: number): boolean {
    const raw = order[BI_FIELD_NAMES.SERVICE_DATE];
    if (raw == null) return false;

    const startMinutes = String(raw)
      .split(',')
      .map((segment) => this.extractSegmentStartMinutes(segment))
      .filter((minutes): minutes is number => minutes != null);

    if (startMinutes.length === 0) return false;
    return Math.min(...startMinutes) >= cutoffMinutes;
  }

  private extractSegmentStartMinutes(segment: string): number | null {
    const match = segment.trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;

    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    return hour * 60 + minute;
  }
}
