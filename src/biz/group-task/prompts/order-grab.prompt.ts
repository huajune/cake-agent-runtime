/**
 * 抢单群通知 — 纯模板（不需要 AI）
 *
 * 格式：
 * 🍕{标题}
 *
 * 预计收入：¥{收入}
 * 📍 地点：{门店}
 * 📝 内容：{内容}
 * 📅 日期：{日期}
 * ⏰ 时间：{时段}
 * 🔗 {报名链接}
 *
 * ...更多订单...
 *
 * 🍕可直接通过上面的链接进入【独立客小程序】查看更多{城市}区域订单~
 * ❗有任何问题可随时联系沟通哦~
 */

import { BIOrder, BI_FIELD_NAMES, TimeSlot } from '../group-task.types';
import { formatLocalDate } from '@infra/utils/date.util';

interface OrderGrabTemplateData {
  orders: BIOrder[];
  city: string;
  timeSlot?: TimeSlot;
}

/**
 * 生成抢单群通知消息（模板拼装）
 */
export function buildOrderGrabMessage(data: OrderGrabTemplateData): string {
  const { orders, city, timeSlot } = data;
  if (orders.length === 0) return '';

  // 按门店去重，每个门店只保留收入最高的订单
  const bestByStore = deduplicateByStore(orders);
  // 根据场次选取不同订单子集，保证每次发送内容不同
  const MAX_ORDERS = 4;
  const displayOrders = selectOrdersByTimeSlot(bestByStore, timeSlot, MAX_ORDERS);

  const lines: string[] = [];

  // 标题（根据场次和数据特征选择）
  const title = selectTitle(displayOrders, city, timeSlot);
  lines.push(title);
  lines.push('');

  // 订单列表（最多展示 10 个）
  for (const order of displayOrders) {
    const revenue = order[BI_FIELD_NAMES.EXPECTED_REVENUE];
    const store = order[BI_FIELD_NAMES.STORE_NAME] || '未知';
    const rawContent = order[BI_FIELD_NAMES.SERVICE_CONTENT] || '未知';
    const content = Array.isArray(rawContent) ? rawContent.join('、') : rawContent;
    const date = order[BI_FIELD_NAMES.ORDER_DATE] || '未知';
    const rawTime = order[BI_FIELD_NAMES.SERVICE_DATE] || '未知';
    // 去掉秒数：12:00:00~15:30:00 → 12:00~15:30
    const time = String(rawTime).replace(/(\d{2}:\d{2}):\d{2}/g, '$1');
    const link = order[BI_FIELD_NAMES.SHARE_LINK] || '';

    lines.push(`预计收入：¥${revenue}`);
    lines.push(`📍 地点：${store}`);
    lines.push(`📝 内容：${content}`);
    lines.push(`📅 日期：${date}`);
    lines.push(`⏰ 时间：${time}`);
    if (link) {
      lines.push(`🔗 ${link}`);
    }
    lines.push('');
  }

  // 固定尾部
  lines.push(`🍕可直接通过上面的链接进入【独立客小程序】查看更多${city}区域订单~`);
  lines.push('❗有任何问题可随时联系沟通哦~');

  return lines.join('\n');
}

/**
 * 根据订单特征选择标题
 */
function selectTitle(orders: BIOrder[], city: string, timeSlot?: TimeSlot): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = formatLocalDate(tomorrow);

  // 检查是否有特定地区（如崇明）
  const regions = new Set(
    orders.map((o) => String(o[BI_FIELD_NAMES.ORDER_REGION] || '')).filter(Boolean),
  );
  const hasSpecificRegion = regions.size === 1 && [...regions][0] !== city;

  // 检查订单日期
  const dates = orders.map((o) => String(o[BI_FIELD_NAMES.ORDER_DATE] || ''));
  const allTomorrow = dates.every((d) => d === tomorrowStr);
  const hasWeekend = dates.some((d) => {
    const day = new Date(d).getDay();
    return day === 0 || day === 6;
  });

  if (hasSpecificRegion) {
    return `★${[...regions][0]}订单，速来`;
  }

  // 场次专属标题，确保每次通知视觉上有区别
  if (timeSlot === TimeSlot.MORNING) {
    if (allTomorrow) return '🍕明日订单，速来~';
    return city ? `🍕【${city}】早间好单推荐~` : '🍕早间好单推荐~';
  }
  if (timeSlot === TimeSlot.AFTERNOON) {
    if (hasWeekend) return '🍕周末订单，速来';
    return city ? `🍕【${city}】午间新单上架~` : '🍕午间新单上架~';
  }
  if (timeSlot === TimeSlot.EVENING) {
    return city ? `🍕【${city}】晚间急单速抢！` : '🍕晚间急单速抢！';
  }

  // 无场次兜底
  if (allTomorrow) {
    return '🍕明日订单，速来~';
  }
  if (hasWeekend) {
    return '🍕周末订单，速来';
  }
  if (city) {
    return `🍕【${city}】专区订单，速来`;
  }
  return '🍕新订单，速来！！！';
}

/**
 * 根据场次选取不同的订单子集
 *
 * - 上午场：收入最高的前 N 条
 * - 下午场：收入排名第 N+1 ~ 2N 条（不足则取剩余）
 * - 晚上场：按日期最近排序，取前 N 条（换维度展示）
 * - 无场次：兜底取收入最高前 N 条
 */
function selectOrdersByTimeSlot(
  orders: BIOrder[],
  timeSlot: TimeSlot | undefined,
  max: number,
): BIOrder[] {
  if (!timeSlot || orders.length <= max) {
    // 无场次或订单不足，按收入排序取全部
    return orders.sort((a, b) => parseMoney(b) - parseMoney(a)).slice(0, max);
  }

  switch (timeSlot) {
    case TimeSlot.MORNING: {
      // 收入最高的前 N 条
      return orders.sort((a, b) => parseMoney(b) - parseMoney(a)).slice(0, max);
    }
    case TimeSlot.AFTERNOON: {
      // 收入排名第 N+1 ~ 2N 条
      const sorted = orders.sort((a, b) => parseMoney(b) - parseMoney(a));
      const start = Math.min(max, sorted.length);
      const slice = sorted.slice(start, start + max);
      // 不足 N 条时，从头部补充（避免空消息）
      return slice.length > 0 ? slice : sorted.slice(0, max);
    }
    case TimeSlot.EVENING: {
      // 按日期最近排序（优先展示即将到来的订单）
      return orders
        .sort((a, b) => {
          const dateA = String(a[BI_FIELD_NAMES.ORDER_DATE] || '');
          const dateB = String(b[BI_FIELD_NAMES.ORDER_DATE] || '');
          // 日期升序（最近的在前）
          const dateCmp = dateA.localeCompare(dateB);
          // 同日期按收入降序
          return dateCmp !== 0 ? dateCmp : parseMoney(b) - parseMoney(a);
        })
        .slice(0, max);
    }
    default:
      return orders.sort((a, b) => parseMoney(b) - parseMoney(a)).slice(0, max);
  }
}

/**
 * 按门店去重，每个门店只保留收入最高的订单
 */
function deduplicateByStore(orders: BIOrder[]): BIOrder[] {
  const storeMap = new Map<string, BIOrder>();

  for (const order of orders) {
    const store = String(order[BI_FIELD_NAMES.STORE_NAME] || '未知');
    const existing = storeMap.get(store);

    if (!existing || parseMoney(order) > parseMoney(existing)) {
      storeMap.set(store, order);
    }
  }

  return [...storeMap.values()];
}

/**
 * 提取订单预计收入数字
 */
function parseMoney(order: BIOrder): number {
  const raw = order[BI_FIELD_NAMES.EXPECTED_REVENUE];
  if (raw == null) return 0;
  const val = Number(String(raw).replace(/[,\s¥￥]/g, ''));
  return Number.isFinite(val) ? val : 0;
}
