import { OrderGrabStrategy } from '@biz/group-task/strategies/order-grab.strategy';
import { SpongeService } from '@sponge/sponge.service';
import { GroupContext, TimeSlot, BI_FIELD_NAMES } from '@biz/group-task/group-task.types';
import { formatLocalDate } from '@infra/utils/date.util';

describe('OrderGrabStrategy', () => {
  let strategy: OrderGrabStrategy;
  let mockSpongeService: Partial<SpongeService>;

  const mockContext: GroupContext = {
    imRoomId: 'room-1',
    groupName: '测试群',
    city: '上海',
    tag: '抢单群',
    imBotId: 'bot-1',
    token: 'token-1',
    chatId: 'chat-1',
  };

  beforeEach(() => {
    mockSpongeService = {
      fetchBIOrders: jest.fn(),
    };
    strategy = new OrderGrabStrategy(mockSpongeService as unknown as SpongeService);
  });

  describe('fetchData — 场次驱动的日期范围', () => {
    it('上午场：使用当日日期，并按下午时段过滤订单', async () => {
      const today = formatLocalDate(new Date());
      const orders = [
        { [BI_FIELD_NAMES.SERVICE_DATE]: '08:00:00~11:00:00' }, // 全上午，应过滤掉
        { [BI_FIELD_NAMES.SERVICE_DATE]: '14:00:00~18:00:00' }, // 全下午，保留
        { [BI_FIELD_NAMES.SERVICE_DATE]: '10:30:00~14:30:00,16:30:00~20:30:00' }, // 跨段，保留
      ];
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue(orders);

      const result = await strategy.fetchData(mockContext, TimeSlot.MORNING);

      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledWith({
        startDate: today,
        endDate: today,
        regionName: '上海',
      });
      // 应只保留 2 条带下午时段的订单
      expect((result.payload.orders as unknown[]).length).toBe(2);
      expect(result.hasData).toBe(true);
    });

    it('下午场：使用次日日期，不做时段过滤', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = formatLocalDate(tomorrow);
      const orders = [
        { [BI_FIELD_NAMES.SERVICE_DATE]: '08:00:00~11:00:00' },
        { [BI_FIELD_NAMES.SERVICE_DATE]: '14:00:00~18:00:00' },
      ];
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue(orders);

      const result = await strategy.fetchData(mockContext, TimeSlot.AFTERNOON);

      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledWith({
        startDate: tomorrowStr,
        endDate: tomorrowStr,
        regionName: '上海',
      });
      expect((result.payload.orders as unknown[]).length).toBe(2);
    });

    it('晚上场：使用本周周六~周日日期范围', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      await strategy.fetchData(mockContext, TimeSlot.EVENING);

      const call = (mockSpongeService.fetchBIOrders as jest.Mock).mock.calls[0][0];
      expect(call.regionName).toBe('上海');
      // 验证 startDate 是周六、endDate 是周日
      const start = new Date(`${call.startDate}T00:00:00+08:00`);
      const end = new Date(`${call.endDate}T00:00:00+08:00`);
      expect(start.getDay()).toBe(6); // Saturday
      expect(end.getDay()).toBe(0); // Sunday
      // 周日紧跟周六的下一天
      expect((end.getTime() - start.getTime()) / (24 * 3600 * 1000)).toBe(1);
    });

    it('无场次：兜底为今天 → 本周日（保留旧手动触发行为）', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      await strategy.fetchData(mockContext);

      const call = (mockSpongeService.fetchBIOrders as jest.Mock).mock.calls[0][0];
      expect(call.startDate).toBe(formatLocalDate(new Date()));
      // endDate 应是今天或之后的某个周日
      const end = new Date(`${call.endDate}T00:00:00+08:00`);
      expect(end.getDay()).toBe(0);
    });

    it('无订单时返回 hasData=false', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      const result = await strategy.fetchData(mockContext, TimeSlot.AFTERNOON);

      expect(result.hasData).toBe(false);
    });
  });

  describe('buildMessage', () => {
    it('should delegate to buildOrderGrabMessage', () => {
      const mockData = {
        hasData: true,
        payload: { orders: [{ 订单所属门店: '门店A' }], city: '上海' },
        summary: '上海: 1个订单',
      };

      const message = strategy.buildMessage(mockData, mockContext);

      expect(typeof message).toBe('string');
    });
  });
});
