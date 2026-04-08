/**
 * 抢单群通知 — 纯模板（不需要 AI）
 *
 * 格式：
 * 🍕{标题}
 *
 * 💰 预计收入：¥{收入}
 * 📍 地点：{门店}
 * 📋 内容：{内容}
 * 📅 日期：{日期}
 * ⏰ 时间：{时段}
 * 🔗 报名链接：{报名链接}
 *
 * ...更多订单...
 *
 * 🍕可直接通过上面的链接进入【独立客小程序】查看更多{城市}区域订单~
 * ❗有任何问题可随时联系沟通哦~
 */

import { BIOrder, BI_FIELD_NAMES, TimeSlot } from '../group-task.types';

interface OrderGrabTemplateData {
  orders: BIOrder[];
  city: string;
  timeSlot?: TimeSlot;
}

const MAX_ORDERS = 3;

/**
 * 生成抢单群通知消息（模板拼装）
 *
 * 三个场次（上午/下午/晚上）的内容差异由数据层（OrderGrabStrategy.fetchData）
 * 通过"不同日期范围"实现，本模板只负责按收入排序展示前 N 条。
 */
export function buildOrderGrabMessage(data: OrderGrabTemplateData): string {
  const { orders, city, timeSlot } = data;
  if (orders.length === 0) return '';

  // 1. 按门店去重（同店保留最高收入）
  // 2. 按收入降序排
  // 3. 取前 N 条
  const displayOrders = deduplicateByStore(orders)
    .sort((a, b) => parseMoney(b) - parseMoney(a))
    .slice(0, MAX_ORDERS);

  const lines: string[] = [];

  // 标题（与场次实际拉取的日期范围对应）
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
    // 去掉秒数并在 ~ 两侧补空格：12:00:00~15:30:00 → 12:00 ~ 15:30
    const time = String(rawTime)
      .replace(/(\d{2}:\d{2}):\d{2}/g, '$1')
      .replace(/\s*~\s*/g, ' ~ ');
    const link = order[BI_FIELD_NAMES.SHARE_LINK] || '';

    lines.push(`💰 预计收入：¥${revenue}`);
    lines.push(`📍 地点：${store}`);
    lines.push(`📋 内容：${content}`);
    lines.push(`📅 日期：${date}`);
    lines.push(`⏰ 时间：${time}`);
    if (link) {
      lines.push(`🔗 报名链接：${link}`);
    }
    lines.push('');
  }

  // 固定尾部
  lines.push(`🍕可直接通过上面的链接进入【独立客小程序】查看更多${city}区域订单~`);
  lines.push('❗有任何问题可随时联系沟通哦~');

  return lines.join('\n');
}

/**
 * 选择标题
 *
 * 标题与 OrderGrabStrategy.resolveDateRange 拉取的日期范围严格对应：
 * - 上午场 → 当日下午订单
 * - 下午场 → 次日订单
 * - 晚上场 → 本周末订单
 * - 无场次（手动触发兜底）→ 近期订单
 *
 * 例外：当所有订单都集中在某个子区域（如「上海」群下全是「崇明」的订单），
 * 优先用区域名作为标题。
 */
function selectTitle(orders: BIOrder[], city: string, timeSlot?: TimeSlot): string {
  // 子区域聚焦：所有订单同属一个非 city 的区域时，用区域名突出
  const regions = new Set(
    orders.map((o) => String(o[BI_FIELD_NAMES.ORDER_REGION] || '')).filter(Boolean),
  );
  if (regions.size === 1 && [...regions][0] !== city) {
    return `🍕${[...regions][0]}订单，速来~`;
  }

  const cityPrefix = city ? `【${city}】` : '';

  switch (timeSlot) {
    case TimeSlot.MORNING:
      return `🍕${cityPrefix}今日下午订单，速来~`;
    case TimeSlot.AFTERNOON:
      return `🍕${cityPrefix}明日订单，速来~`;
    case TimeSlot.EVENING:
      return `🍕${cityPrefix}本周末订单，速来~`;
    default:
      return `🍕${cityPrefix}近期订单，速来~`;
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
