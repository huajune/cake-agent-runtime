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

const WUHAN_COMPANY_NAME = '百胜餐饮（武汉）有限公司';
const HUBEI_CITY_KEYS = [
  '武汉',
  '武汉地区',
  '湖北',
  '湖北地区',
  '黄石',
  '十堰',
  '宜昌',
  '襄阳',
  '襄樊',
  '鄂州',
  '荆门',
  '孝感',
  '荆州',
  '黄冈',
  '咸宁',
  '随州',
  '恩施',
  '恩施州',
  '仙桃',
  '潜江',
  '天门',
  '神农架',
  '神农架林区',
] as const;

const JIANGXI_CITY_KEYS = [
  '江西',
  '江西地区',
  '南昌',
  '景德镇',
  '萍乡',
  '九江',
  '新余',
  '鹰潭',
  '赣州',
  '吉安',
  '宜春',
  '抚州',
  '上饶',
] as const;

const WUHAN_CITY_KEYS = [...HUBEI_CITY_KEYS, ...JIANGXI_CITY_KEYS] as const;
const JIANGXI_GROUP_CITIES = JIANGXI_CITY_KEYS.filter(
  (city) => city !== '江西' && city !== '江西地区',
);
const LABEL_CITY_EXPANSIONS: Record<string, readonly string[]> = {
  江西: JIANGXI_GROUP_CITIES,
  江西地区: JIANGXI_GROUP_CITIES,
};

const CITY_COMPANY_MAP: Record<string, string> = {
  上海: '上海必胜客有限公司',
  宁波: '上海必胜客有限公司宁波分公司',
  北京: '北京必胜客比萨饼有限公司',
  ...Object.fromEntries(WUHAN_CITY_KEYS.map((city) => [city, WUHAN_COMPANY_NAME])),
};

interface OrderGrabQueryScope {
  displayCity: string;
  groupKey: string;
  cityNames: string[];
  companyName?: string;
}

interface LabelScope {
  displayLabels: string[];
  cityNames: string[];
}

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
    const scope = this.resolveOrderGrabScope(context);

    let orders = await this.fetchOrdersForScope(scope, startDate, endDate);

    // 上午场只发最早开工时间不早于 10:30 的订单
    if (timeSlot === TimeSlot.MORNING) {
      orders = orders.filter((order) =>
        this.startsAtOrAfter(order, this.morningOrderStartCutoffMinutes),
      );
    }

    // 下午场无数据时，往后逐天顺延到本周日
    let actualLabel = label;
    if (orders.length === 0 && timeSlot === TimeSlot.AFTERNOON) {
      const result = await this.lookaheadOrders(scope, startDate);
      if (result) {
        orders = result.orders;
        actualLabel = result.label;
      }
    }

    this.logger.log(
      `[抢单群] ${scope.displayCity} ${actualLabel} (${startDate}~${endDate}): ${orders.length}个订单`,
    );

    return {
      hasData: orders.length > 0,
      payload: { orders, city: scope.displayCity },
      summary: `${scope.displayCity} ${actualLabel}: ${orders.length}个订单`,
    };
  }

  resolveOrderGrabGroupKey(context: GroupContext): string {
    return this.resolveOrderGrabScope(context).groupKey;
  }

  buildMessage(data: NotificationData, context: GroupContext, timeSlot?: TimeSlot): string {
    return buildOrderGrabMessage({
      orders: data.payload.orders as Record<string, unknown>[],
      city: String(data.payload.city || context.city),
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

  private normalizeCityName(city: string): string {
    return city.trim().replace(/(?:市|地区)$/, '');
  }

  /**
   * 抢单群统一按“实际城市 + 所属企业”查。
   * 不再退化到“只按公司查”，避免把同公司的其他城市订单串进来。
   */
  private async fetchOrdersForScope(
    scope: OrderGrabQueryScope,
    startDate: string,
    endDate: string,
  ): Promise<BIOrder[]> {
    return this.fetchOrdersByCities(scope.cityNames, startDate, endDate, scope.companyName);
  }

  private async fetchOrdersByCities(
    cityNames: string[],
    startDate: string,
    endDate: string,
    companyName?: string,
  ): Promise<BIOrder[]> {
    const uniqueOrders: BIOrder[] = [];
    const seen = new Set<string>();

    for (const cityName of [...new Set(cityNames)]) {
      const orders = await this.spongeService.fetchBIOrders({
        startDate,
        endDate,
        cityName,
        companyName,
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });

      for (const order of orders) {
        const dedupeKey = this.buildOrderDedupeKey(order, cityName);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        uniqueOrders.push(order);
      }
    }

    return uniqueOrders;
  }

  /**
   * 下午场无数据时，往后逐天查找到本周日，找到最近有订单的日期。
   * 本周内都没有才放弃。
   */
  private async lookaheadOrders(
    scope: OrderGrabQueryScope,
    baseDate: string,
  ): Promise<{ orders: BIOrder[]; label: string } | null> {
    const base = new Date(baseDate);
    const sunday = this.getEndOfWeek(base);
    const maxDays = Math.max(0, Math.round((sunday.getTime() - base.getTime()) / 86_400_000));

    for (let i = 1; i <= maxDays; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const date = formatLocalDate(d);

      const orders = await this.fetchOrdersForScope(scope, date, date);

      if (orders.length > 0) {
        this.logger.log(
          `[抢单群] ${scope.displayCity} 次日无单，顺延到 ${date} 找到 ${orders.length} 个订单`,
        );
        return { orders, label: `下午场[${date}]` };
      }
    }

    this.logger.log(`[抢单群] ${scope.displayCity} 本周内无订单，跳过`);
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

  private resolveOrderGrabScope(context: GroupContext): OrderGrabQueryScope {
    const labelScope = this.parseLabelScope(context.labels || []);
    if (labelScope.cityNames.length > 0) {
      const displayCity = labelScope.displayLabels.join('&');
      const companyName = this.resolveCompanyNameForCities(labelScope.cityNames);
      return {
        displayCity,
        groupKey: displayCity,
        cityNames: labelScope.cityNames,
        companyName,
      };
    }

    const normalizedCity = this.normalizeCityName(context.city);
    const companyName = CITY_COMPANY_MAP[normalizedCity] ?? CITY_COMPANY_MAP[context.city];

    return {
      displayCity: normalizedCity,
      groupKey: normalizedCity,
      cityNames: [normalizedCity],
      companyName,
    };
  }

  private parseLabelScope(labels: string[]): LabelScope {
    const displayLabels = labels
      .filter((label) => label && label !== this.tagPrefix)
      .map((label) => this.normalizeCityName(label))
      .filter(Boolean);

    const cityNames = [...new Set(
      displayLabels.flatMap((label) => LABEL_CITY_EXPANSIONS[label] ?? [label]),
    )];

    return { displayLabels, cityNames };
  }

  private resolveCompanyNameForCities(cities: string[]): string | undefined {
    const companyNames = [...new Set(cities.map((city) => CITY_COMPANY_MAP[city]).filter(Boolean))];
    return companyNames.length === 1 ? companyNames[0] : undefined;
  }

  private buildOrderDedupeKey(order: BIOrder, fallbackCity: string): string {
    const shareLink = String(order[BI_FIELD_NAMES.SHARE_LINK] || '').trim();
    if (shareLink) return shareLink;

    const store = String(order[BI_FIELD_NAMES.STORE_NAME] || '').trim();
    const date = String(order[BI_FIELD_NAMES.ORDER_DATE] || '').trim();
    const time = String(order[BI_FIELD_NAMES.SERVICE_DATE] || '').trim();
    return [fallbackCity, store, date, time].join('|');
  }
}
