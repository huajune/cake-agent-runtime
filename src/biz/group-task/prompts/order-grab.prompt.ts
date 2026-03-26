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

import { BIOrder, BI_FIELD_NAMES } from '../group-task.types';

interface OrderGrabTemplateData {
  orders: BIOrder[];
  city: string;
}

/**
 * 生成抢单群通知消息（模板拼装）
 */
export function buildOrderGrabMessage(data: OrderGrabTemplateData): string {
  const { orders, city } = data;
  if (orders.length === 0) return '';

  // 按门店去重，每个门店只保留收入最高的订单
  const bestByStore = deduplicateByStore(orders);
  // 按收入降序排列，取前10条
  const MAX_ORDERS = 4;
  const sorted = bestByStore.sort((a, b) => parseMoney(b) - parseMoney(a));
  const displayOrders = sorted.slice(0, MAX_ORDERS);

  const lines: string[] = [];

  // 标题（根据规则选择）
  const title = selectTitle(displayOrders, city);
  lines.push(title);
  lines.push('');

  // 订单列表（最多展示 10 个）
  for (const order of displayOrders) {
    const revenue = order[BI_FIELD_NAMES.EXPECTED_REVENUE];
    const store = order[BI_FIELD_NAMES.STORE_NAME] || '未知';
    const content = order[BI_FIELD_NAMES.SERVICE_CONTENT] || '未知';
    const date = order[BI_FIELD_NAMES.ORDER_DATE] || '未知';
    const time = order[BI_FIELD_NAMES.SERVICE_DATE] || '未知';
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
function selectTitle(orders: BIOrder[], city: string): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

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
