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
  // selectOrdersByTimeSlot — exercised via public API
  // -------------------------------------------------------------------------

  describe('selectOrdersByTimeSlot', () => {
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

    describe('MORNING — top N by revenue', () => {
      it('includes the highest-revenue orders', () => {
        const orders = makeOrderSet(8);
        const result = buildOrderGrabMessage({
          orders,
          city: '上海',
          timeSlot: TimeSlot.MORNING,
        });

        // rank-1 order (highest revenue) must be present
        expect(result).toContain('内容rank1');
      });

      it('does not include orders beyond the top 4', () => {
        const orders = makeOrderSet(8);
        const result = buildOrderGrabMessage({
          orders,
          city: '上海',
          timeSlot: TimeSlot.MORNING,
        });

        // rank-5 and beyond should not appear
        expect(result).not.toContain('内容rank5');
        expect(result).not.toContain('内容rank6');
      });
    });

    describe('AFTERNOON — ranks N+1 to 2N by revenue', () => {
      it('shows rank 5-8 orders (not rank 1-4) when enough orders exist', () => {
        const orders = makeOrderSet(8);
        const result = buildOrderGrabMessage({
          orders,
          city: '上海',
          timeSlot: TimeSlot.AFTERNOON,
        });

        // ranks 5-8 must appear
        expect(result).toContain('内容rank5');

        // ranks 1-4 should NOT appear
        expect(result).not.toContain('内容rank1');
        expect(result).not.toContain('内容rank2');
      });

      it('falls back to top-N orders when fewer than N+1 unique orders exist', () => {
        // Only 3 unique-store orders — not enough to fill the N+1..2N slice
        const orders = makeOrderSet(3);
        const result = buildOrderGrabMessage({
          orders,
          city: '上海',
          timeSlot: TimeSlot.AFTERNOON,
        });

        // Should fall back and show something rather than empty
        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain('内容rank1');
      });
    });

    describe('EVENING — sorts by nearest ORDER_DATE first', () => {
      it('shows the order with the earliest date first', () => {
        // Need > MAX_ORDERS(4) orders to trigger time-slot-based selection
        const orders = [
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '远期门店', [BI_FIELD_NAMES.ORDER_DATE]: '2026-05-01', [BI_FIELD_NAMES.EXPECTED_REVENUE]: '2000', [BI_FIELD_NAMES.SERVICE_CONTENT]: '远期内容' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '近期门店', [BI_FIELD_NAMES.ORDER_DATE]: '2026-04-02', [BI_FIELD_NAMES.EXPECTED_REVENUE]: '500', [BI_FIELD_NAMES.SERVICE_CONTENT]: '近期内容' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店C', [BI_FIELD_NAMES.ORDER_DATE]: '2026-04-10', [BI_FIELD_NAMES.EXPECTED_REVENUE]: '800' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店D', [BI_FIELD_NAMES.ORDER_DATE]: '2026-04-15', [BI_FIELD_NAMES.EXPECTED_REVENUE]: '700' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店E', [BI_FIELD_NAMES.ORDER_DATE]: '2026-04-20', [BI_FIELD_NAMES.EXPECTED_REVENUE]: '600' }),
        ];

        const result = buildOrderGrabMessage({
          orders,
          city: '上海',
          timeSlot: TimeSlot.EVENING,
        });

        // EVENING sorts by date ASC; 近期门店 (04-02) should appear before 远期门店 (05-01)
        const indexSoon = result.indexOf('近期内容');
        const indexLater = result.indexOf('远期内容');
        expect(indexSoon).toBeGreaterThanOrEqual(0);
        // 远期门店 may be cut off (max=4), but 近期门店 should always be in the output
        if (indexLater >= 0) {
          expect(indexSoon).toBeLessThan(indexLater);
        }
      });

      it('breaks date ties by descending revenue', () => {
        const sameDate = '2026-04-10';
        // Need > MAX_ORDERS(4) to trigger EVENING sorting
        const orders = [
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '低收入同日门店', [BI_FIELD_NAMES.ORDER_DATE]: sameDate, [BI_FIELD_NAMES.EXPECTED_REVENUE]: '1000', [BI_FIELD_NAMES.SERVICE_CONTENT]: '低收入同日' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '高收入同日门店', [BI_FIELD_NAMES.ORDER_DATE]: sameDate, [BI_FIELD_NAMES.EXPECTED_REVENUE]: '3000', [BI_FIELD_NAMES.SERVICE_CONTENT]: '高收入同日' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店C', [BI_FIELD_NAMES.ORDER_DATE]: sameDate, [BI_FIELD_NAMES.EXPECTED_REVENUE]: '800' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店D', [BI_FIELD_NAMES.ORDER_DATE]: sameDate, [BI_FIELD_NAMES.EXPECTED_REVENUE]: '700' }),
          makeOrder({ [BI_FIELD_NAMES.STORE_NAME]: '门店E', [BI_FIELD_NAMES.ORDER_DATE]: sameDate, [BI_FIELD_NAMES.EXPECTED_REVENUE]: '600' }),
        ];

        const result = buildOrderGrabMessage({
          orders,
          city: '上海',
          timeSlot: TimeSlot.EVENING,
        });

        // Same date → sorted by revenue DESC within EVENING slot
        const indexHigh = result.indexOf('高收入同日');
        const indexLow = result.indexOf('低收入同日');
        expect(indexHigh).toBeGreaterThanOrEqual(0);
        expect(indexLow).toBeGreaterThanOrEqual(0);
        expect(indexHigh).toBeLessThan(indexLow);
      });
    });

    describe('no timeSlot — defaults to top-N by revenue', () => {
      it('shows highest-revenue orders when timeSlot is omitted', () => {
        const orders = makeOrderSet(6);
        const result = buildOrderGrabMessage({ orders, city: '上海' });

        expect(result).toContain('内容rank1');
        expect(result).toContain('内容rank2');
        // rank 5+ should not appear (max is 4)
        expect(result).not.toContain('内容rank5');
      });
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
