import { buildOrderGrabMessage } from '@biz/group-task/prompts/order-grab.prompt';
import { BI_FIELD_NAMES, TimeSlot } from '@biz/group-task/group-task.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [BI_FIELD_NAMES.STORE_NAME]: '默认门店',
    [BI_FIELD_NAMES.EXPECTED_REVENUE]: '1000',
    [BI_FIELD_NAMES.SERVICE_CONTENT]: '餐饮服务',
    [BI_FIELD_NAMES.ORDER_DATE]: '2026-04-01',
    [BI_FIELD_NAMES.SERVICE_DATE]: '09:00-18:00',
    [BI_FIELD_NAMES.SHARE_LINK]: 'https://example.com/order/1',
    [BI_FIELD_NAMES.CITY]: '上海',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildOrderGrabMessage', () => {
  // -------------------------------------------------------------------------
  // Empty guard
  // -------------------------------------------------------------------------

  describe('empty orders', () => {
    it('returns empty string when orders array is empty', () => {
      const result = buildOrderGrabMessage({ orders: [], city: '上海' });
      expect(result).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Single order — basic shape
  // -------------------------------------------------------------------------

  describe('single order', () => {
    it('generates a non-empty message', () => {
      const order = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '肯德基南京路店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '800',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '收银员',
        [BI_FIELD_NAMES.ORDER_DATE]: '2026-04-01',
        [BI_FIELD_NAMES.SERVICE_DATE]: '10:00-18:00',
        [BI_FIELD_NAMES.SHARE_LINK]: 'https://example.com/order/abc',
      });

      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });

      expect(result.length).toBeGreaterThan(0);
    });

    it('includes store name in the message', () => {
      const order = makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '麦当劳徐汇店' });
      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });
      expect(result).toContain('麦当劳徐汇店');
    });

    it('includes revenue in the message', () => {
      const order = makeOrder({ [BI_FIELD_NAMES.EXPECTED_REVENUE]: '1200' });
      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });
      expect(result).toContain('1200');
    });

    it('includes service content in the message', () => {
      const order = makeOrder({ [BI_FIELD_NAMES.SERVICE_CONTENT]: '楼面服务员' });
      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });
      expect(result).toContain('楼面服务员');
    });

    it('includes the share link when present', () => {
      const order = makeOrder({ [BI_FIELD_NAMES.SHARE_LINK]: 'https://example.com/link-123' });
      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });
      expect(result).toContain('https://example.com/link-123');
    });

    it('omits the link line when share link is absent', () => {
      const order = makeOrder({ [BI_FIELD_NAMES.SHARE_LINK]: '' });
      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });
      expect(result).not.toContain('🔗');
    });

    it('uses "未知" placeholder when store name is missing', () => {
      const order = makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: undefined });
      const result = buildOrderGrabMessage({ orders: [order], city: '上海' });
      expect(result).toContain('未知');
    });
  });

  // -------------------------------------------------------------------------
  // Footer always contains city
  // -------------------------------------------------------------------------

  describe('footer', () => {
    it('always contains the city name in the footer', () => {
      const order = makeOrder();
      const result = buildOrderGrabMessage({ orders: [order], city: '深圳' });
      const lines = result.split('\n');
      const footer = lines[lines.length - 2]; // second-to-last line has city
      expect(footer).toContain('深圳');
    });

    it('always ends with the contact reminder line', () => {
      const order = makeOrder();
      const result = buildOrderGrabMessage({ orders: [order], city: '广州' });
      const lines = result.split('\n');
      expect(lines[lines.length - 1]).toContain('有任何问题可随时联系沟通哦');
    });

    it('footer city changes when a different city is passed', () => {
      const order = makeOrder();
      const resultA = buildOrderGrabMessage({ orders: [order], city: '成都' });
      const resultB = buildOrderGrabMessage({ orders: [order], city: '杭州' });
      expect(resultA).toContain('成都');
      expect(resultB).toContain('杭州');
      expect(resultA).not.toContain('杭州');
    });
  });

  // -------------------------------------------------------------------------
  // deduplicateByStore — exercised via public API
  // -------------------------------------------------------------------------

  describe('deduplicateByStore', () => {
    it('keeps only the highest-revenue order when two share the same store', () => {
      const lowRevenue = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '星巴克人民广场店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '500',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '低收入服务',
      });
      const highRevenue = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '星巴克人民广场店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '1500',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '高收入服务',
      });

      const result = buildOrderGrabMessage({
        orders: [lowRevenue, highRevenue],
        city: '上海',
      });

      expect(result).toContain('高收入服务');
      expect(result).not.toContain('低收入服务');
    });

    it('keeps both orders when they belong to different stores', () => {
      const orderA = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '门店A',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '服务A',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '800',
      });
      const orderB = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '门店B',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '服务B',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '600',
      });

      const result = buildOrderGrabMessage({ orders: [orderA, orderB], city: '上海' });

      expect(result).toContain('服务A');
      expect(result).toContain('服务B');
    });

    it('deduplicates correctly when the lower-revenue order appears first', () => {
      const first = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '同一门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '300',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '先来低收入',
      });
      const second = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '同一门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '900',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '后来高收入',
      });

      const result = buildOrderGrabMessage({ orders: [first, second], city: '上海' });

      expect(result).toContain('后来高收入');
      expect(result).not.toContain('先来低收入');
    });

    it('treats orders with no store name as belonging to the same "未知" bucket', () => {
      const noStoreA = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: undefined,
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '200',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '无门店低',
      });
      const noStoreB = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: undefined,
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '1000',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '无门店高',
      });

      const result = buildOrderGrabMessage({ orders: [noStoreA, noStoreB], city: '上海' });

      expect(result).toContain('无门店高');
      expect(result).not.toContain('无门店低');
    });
  });

  // -------------------------------------------------------------------------
  // Display selection — top-N by revenue (uniform across all time slots)
  //
  // 三个场次的内容差异由数据层（OrderGrabStrategy.fetchData）通过不同日期
  // 范围实现，本模板不再做按场次的切片差异化，统一按收入降序取前 N 条。
  // -------------------------------------------------------------------------

  describe('display selection', () => {
    // Build N unique-store orders with descending revenue so revenue rank == index
    function makeOrderSet(count: number): Record<string, unknown>[] {
      return Array.from({ length: count }, (_, i) =>
        makeOrder({
          [BI_FIELD_NAMES.STORE_NAME]: `门店${i + 1}`,
          [BI_FIELD_NAMES.EXPECTED_REVENUE]: String((count - i) * 1000),
          [BI_FIELD_NAMES.SERVICE_CONTENT]: `内容rank${i + 1}`,
        }),
      );
    }

    it.each([
      ['MORNING', TimeSlot.MORNING],
      ['AFTERNOON', TimeSlot.AFTERNOON],
      ['EVENING', TimeSlot.EVENING],
      ['no timeSlot', undefined],
    ] as const)('%s shows top-N orders by revenue and drops the rest', (_label, slot) => {
      const orders = makeOrderSet(8);
      const result = buildOrderGrabMessage({
        orders,
        city: '上海',
        timeSlot: slot,
      });

      // rank-1 (highest revenue) must always be present
      expect(result).toContain('内容rank1');
      // ranks beyond MAX_ORDERS=3 must be dropped — pick a clearly out-of-range one
      expect(result).not.toContain('内容rank4');
      expect(result).not.toContain('内容rank8');
    });
  });

  // -------------------------------------------------------------------------
  // Title — must align with the date range fetched per time slot
  // -------------------------------------------------------------------------

  describe('title selection', () => {
    function firstLine(result: string): string {
      return result.split('\n')[0];
    }

    it('MORNING title says 今日下午订单 with city prefix', () => {
      const result = buildOrderGrabMessage({
        orders: [makeOrder()],
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });
      expect(firstLine(result)).toBe('🍕【上海】今日下午订单，速来~');
    });

    it('AFTERNOON title says 明日订单 with city prefix', () => {
      const result = buildOrderGrabMessage({
        orders: [makeOrder()],
        city: '北京',
        timeSlot: TimeSlot.AFTERNOON,
      });
      expect(firstLine(result)).toBe('🍕【北京】明日订单，速来~');
    });

    it('EVENING title says 本周末订单 with city prefix', () => {
      const result = buildOrderGrabMessage({
        orders: [makeOrder()],
        city: '深圳',
        timeSlot: TimeSlot.EVENING,
      });
      expect(firstLine(result)).toBe('🍕【深圳】本周末订单，速来~');
    });

    it('no timeSlot (manual trigger) falls back to 近期订单', () => {
      const result = buildOrderGrabMessage({
        orders: [makeOrder()],
        city: '杭州',
      });
      expect(firstLine(result)).toBe('🍕【杭州】近期订单，速来~');
    });

    it('drops the city prefix when city is empty', () => {
      const result = buildOrderGrabMessage({
        orders: [makeOrder()],
        city: '',
        timeSlot: TimeSlot.MORNING,
      });
      expect(firstLine(result)).toBe('🍕今日下午订单，速来~');
    });

    it('uses sub-region name when all orders share one non-city region', () => {
      const orders = [
        makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店1', [BI_FIELD_NAMES.ORDER_REGION]: '崇明' }),
        makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店2', [BI_FIELD_NAMES.ORDER_REGION]: '崇明' }),
      ];
      const result = buildOrderGrabMessage({
        orders,
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });
      expect(firstLine(result)).toBe('🍕崇明订单，速来~');
    });

    it('keeps the time-slot title when orders span multiple regions', () => {
      const orders = [
        makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店1', [BI_FIELD_NAMES.ORDER_REGION]: '崇明' }),
        makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店2', [BI_FIELD_NAMES.ORDER_REGION]: '浦东' }),
      ];
      const result = buildOrderGrabMessage({
        orders,
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });
      expect(firstLine(result)).toBe('🍕【上海】今日下午订单，速来~');
    });
  });

  // -------------------------------------------------------------------------
  // parseMoney — exercised via revenue-based sorting / deduplication
  // -------------------------------------------------------------------------

  describe('parseMoney (via revenue sorting)', () => {
    it('parses formatted ¥1,000 correctly and ranks it above a plain 500', () => {
      const formattedOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '格式化收入门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '¥1,000',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '格式化收入',
      });
      const plainOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '普通收入门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '500',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '普通收入',
      });

      // MORNING picks top revenue first
      const result = buildOrderGrabMessage({
        orders: [plainOrder, formattedOrder],
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });

      const indexFormatted = result.indexOf('格式化收入');
      const indexPlain = result.indexOf('普通收入');
      expect(indexFormatted).toBeGreaterThanOrEqual(0);
      expect(indexPlain).toBeGreaterThanOrEqual(0);
      // formatted (1000) should rank above plain (500) → appears first
      expect(indexFormatted).toBeLessThan(indexPlain);
    });

    it('treats null revenue as 0 — order with real revenue ranks above it', () => {
      const nullRevenueOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: 'null收入门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: null,
        [BI_FIELD_NAMES.SERVICE_CONTENT]: 'null收入内容',
      });
      const normalOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '正常收入门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '800',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '正常收入内容',
      });

      const result = buildOrderGrabMessage({
        orders: [nullRevenueOrder, normalOrder],
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });

      const indexNormal = result.indexOf('正常收入内容');
      const indexNull = result.indexOf('null收入内容');
      expect(indexNormal).toBeGreaterThanOrEqual(0);
      expect(indexNull).toBeGreaterThanOrEqual(0);
      expect(indexNormal).toBeLessThan(indexNull);
    });

    it('treats NaN revenue (non-numeric string) as 0', () => {
      const nanOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: 'NaN收入门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: 'not-a-number',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: 'NaN收入内容',
      });
      const normalOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '有效收入门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '1000',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '有效收入内容',
      });

      const result = buildOrderGrabMessage({
        orders: [nanOrder, normalOrder],
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });

      const indexNormal = result.indexOf('有效收入内容');
      const indexNaN = result.indexOf('NaN收入内容');
      expect(indexNormal).toBeGreaterThanOrEqual(0);
      expect(indexNaN).toBeGreaterThanOrEqual(0);
      expect(indexNormal).toBeLessThan(indexNaN);
    });

    it('handles full-width ￥ symbol in revenue string', () => {
      const fullWidthOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '全角符号门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '￥2,000',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '全角符号内容',
      });
      const lowerOrder = makeOrder({
        [BI_FIELD_NAMES.STORE_NAME]: '低收入对比门店',
        [BI_FIELD_NAMES.EXPECTED_REVENUE]: '500',
        [BI_FIELD_NAMES.SERVICE_CONTENT]: '低收入对比内容',
      });

      // 2000 > 500 so fullWidthOrder should rank first
      const result = buildOrderGrabMessage({
        orders: [lowerOrder, fullWidthOrder],
        city: '上海',
        timeSlot: TimeSlot.MORNING,
      });

      const indexFull = result.indexOf('全角符号内容');
      const indexLower = result.indexOf('低收入对比内容');
      expect(indexFull).toBeGreaterThanOrEqual(0);
      expect(indexLower).toBeGreaterThanOrEqual(0);
      expect(indexFull).toBeLessThan(indexLower);
    });
  });
});
