import { OrderGrabStrategy } from '@biz/group-task/strategies/order-grab.strategy';
import { SpongeService } from '@sponge/sponge.service';
import {
  GroupContext,
  TimeSlot,
  BI_FIELD_NAMES,
  BI_ORDER_STATUS,
} from '@biz/group-task/group-task.types';
import { formatLocalDate } from '@infra/utils/date.util';

function parseShanghaiDateAtNoon(date: string): Date {
  // Use local noon to avoid timezone boundary shifts on UTC CI runners.
  return new Date(`${date}T12:00:00+08:00`);
}

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
      refreshBIDataSourceAndWait: jest.fn().mockResolvedValue(true),
    };
    strategy = new OrderGrabStrategy(mockSpongeService as unknown as SpongeService);
  });

  describe('prepareTask', () => {
    it('should refresh BI data source once before the task starts', async () => {
      await strategy.prepareTask();

      expect(mockSpongeService.refreshBIDataSourceAndWait).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchData — 场次驱动的日期范围', () => {
    it('上午场：使用当日日期，并只保留最早开始时间不早于 10:30 的订单', async () => {
      const today = formatLocalDate(new Date());
      const orders = [
        { [BI_FIELD_NAMES.SERVICE_DATE]: '08:00:00~13:30:00,17:00:00~22:30:00' }, // 首段早于 10:30，应过滤
        { [BI_FIELD_NAMES.SERVICE_DATE]: '10:00:00~15:00:00,16:00:00~20:30:00' }, // 首段早于 10:30，应过滤
        { [BI_FIELD_NAMES.SERVICE_DATE]: '10:30:00~14:30:00,16:30:00~20:30:00' }, // 边界值，保留
        { [BI_FIELD_NAMES.SERVICE_DATE]: '11:00:00~18:00:00' }, // 保留
      ];
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue(orders);

      const result = await strategy.fetchData(mockContext, TimeSlot.MORNING);

      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledWith({
        startDate: today,
        endDate: today,
        cityName: '上海',
        companyName: '上海必胜客有限公司',
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });
      // 应只保留 2 条最早开始时间不早于 10:30 的订单
      expect((result.payload.orders as unknown[]).length).toBe(2);
      expect(result.payload.orders).toEqual([orders[2], orders[3]]);
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
        cityName: '上海',
        companyName: '上海必胜客有限公司',
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });
      expect((result.payload.orders as unknown[]).length).toBe(2);
    });

    it('晚上场：使用本周周六~周日日期范围', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      await strategy.fetchData(mockContext, TimeSlot.EVENING);

      const call = (mockSpongeService.fetchBIOrders as jest.Mock).mock.calls[0][0];
      expect(call.cityName).toBe('上海');
      expect(call.companyName).toBe('上海必胜客有限公司');
      // 验证 startDate 是周六、endDate 是周日
      const start = parseShanghaiDateAtNoon(call.startDate);
      const end = parseShanghaiDateAtNoon(call.endDate);
      expect(start.getUTCDay()).toBe(6); // Saturday
      expect(end.getUTCDay()).toBe(0); // Sunday
      // 周日紧跟周六的下一天
      expect((end.getTime() - start.getTime()) / (24 * 3600 * 1000)).toBe(1);
    });

    it('无场次：兜底为今天 → 本周日（保留旧手动触发行为）', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      await strategy.fetchData(mockContext);

      const call = (mockSpongeService.fetchBIOrders as jest.Mock).mock.calls[0][0];
      expect(call.startDate).toBe(formatLocalDate(new Date()));
      // endDate 应是今天或之后的某个周日
      const end = parseShanghaiDateAtNoon(call.endDate);
      expect(end.getUTCDay()).toBe(0);
    });

    it('无订单时返回 hasData=false', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      const result = await strategy.fetchData(mockContext, TimeSlot.AFTERNOON);

      expect(result.hasData).toBe(false);
    });

    it.each([
      ['景德镇', '景德镇'],
      ['宜昌', '宜昌'],
      ['荆州', '荆州'],
      ['江西地区', '江西'],
      ['武汉地区', '武汉'],
    ])('普通城市群应按城市+所属企业联合查询 %s', async (city, expectedCityName) => {
      const today = formatLocalDate(new Date());
      const orders = [{ [BI_FIELD_NAMES.SERVICE_DATE]: '11:00:00~18:00:00' }];

      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue(orders);

      const result = await strategy.fetchData({ ...mockContext, city }, TimeSlot.MORNING);

      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledTimes(1);
      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledWith({
        startDate: today,
        endDate: today,
        cityName: expectedCityName,
        companyName: '百胜餐饮（武汉）有限公司',
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });
      expect(result.hasData).toBe(true);
      expect(result.payload.orders).toEqual(orders);
    });

    it('应从群标签解析地区，并按公司+地区精确查询武汉归属群', async () => {
      const today = formatLocalDate(new Date());
      const orders = [{ [BI_FIELD_NAMES.SERVICE_DATE]: '11:00:00~18:00:00' }];

      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue(orders);

      const result = await strategy.fetchData(
        {
          ...mockContext,
          city: '武汉',
          groupName: '随便什么群名',
          labels: ['抢单群', '荆州'],
        },
        TimeSlot.MORNING,
      );

      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledTimes(1);
      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledWith({
        startDate: today,
        endDate: today,
        cityName: '荆州',
        companyName: '百胜餐饮（武汉）有限公司',
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });
      expect(result.payload.city).toBe('荆州');
      expect(strategy.resolveOrderGrabGroupKey({
        ...mockContext,
        city: '武汉',
        groupName: '随便什么群名',
        labels: ['抢单群', '荆州'],
      })).toBe('荆州');
    });

    it('应支持从群标签解析多地区并分别查询', async () => {
      const today = formatLocalDate(new Date());
      const jingdezhenOrders = [
        {
          [BI_FIELD_NAMES.STORE_NAME]: '景德镇门店',
          [BI_FIELD_NAMES.SERVICE_DATE]: '11:00:00~18:00:00',
        },
      ];
      const shangraoOrders = [
        {
          [BI_FIELD_NAMES.STORE_NAME]: '上饶门店',
          [BI_FIELD_NAMES.SERVICE_DATE]: '12:00:00~19:00:00',
        },
      ];

      (mockSpongeService.fetchBIOrders as jest.Mock)
        .mockResolvedValueOnce(jingdezhenOrders)
        .mockResolvedValueOnce(shangraoOrders);

      const result = await strategy.fetchData(
        {
          ...mockContext,
          city: '江西',
          groupName: '总群名不重要',
          labels: ['抢单群', '景德镇', '上饶'],
        },
        TimeSlot.MORNING,
      );

      expect(mockSpongeService.fetchBIOrders).toHaveBeenNthCalledWith(1, {
        startDate: today,
        endDate: today,
        cityName: '景德镇',
        companyName: '百胜餐饮（武汉）有限公司',
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });
      expect(mockSpongeService.fetchBIOrders).toHaveBeenNthCalledWith(2, {
        startDate: today,
        endDate: today,
        cityName: '上饶',
        companyName: '百胜餐饮（武汉）有限公司',
        orderStatus: BI_ORDER_STATUS.PENDING_ACCEPTANCE,
      });
      expect(result.payload.city).toBe('景德镇&上饶');
      expect(result.payload.orders).toEqual([...jingdezhenOrders, ...shangraoOrders]);
      expect(
        strategy.resolveOrderGrabGroupKey({
          ...mockContext,
          city: '江西',
          groupName: '总群名不重要',
          labels: ['抢单群', '景德镇', '上饶'],
        }),
      ).toBe('景德镇&上饶');
    });

    it('多标签总群应按标签里的具体地区逐个查询，而不是按 city 字段查询', async () => {
      const order = {
        [BI_FIELD_NAMES.STORE_NAME]: '南昌门店',
        [BI_FIELD_NAMES.SERVICE_DATE]: '11:00:00~18:00:00',
      };

      (mockSpongeService.fetchBIOrders as jest.Mock).mockImplementation(async (params) => {
        if (params.cityName === '南昌') return [order];
        return [];
      });

      const result = await strategy.fetchData(
        {
          ...mockContext,
          city: '江西',
          groupName: '江西总群',
          labels: ['抢单群', '南昌', '景德镇', '上饶'],
        },
        TimeSlot.MORNING,
      );

      const queriedRegions = (mockSpongeService.fetchBIOrders as jest.Mock).mock.calls.map(
        ([params]) => params.cityName,
      );

      expect(queriedRegions).toContain('南昌');
      expect(queriedRegions).toContain('景德镇');
      expect(queriedRegions).toContain('上饶');
      expect(queriedRegions).not.toContain('江西');
      expect(result.payload.city).toBe('南昌&景德镇&上饶');
      expect(result.hasData).toBe(true);
    });

    it('江西总群应按标签展开成江西各城市查询，而不是直接查询江西', async () => {
      const queriedCities: string[] = [];
      (mockSpongeService.fetchBIOrders as jest.Mock).mockImplementation(async (params) => {
        queriedCities.push(params.cityName);
        return [];
      });

      const result = await strategy.fetchData(
        {
          ...mockContext,
          city: '江西',
          groupName: '江西必胜客-短时班次兼职群',
          labels: ['抢单群', '江西'],
        },
        TimeSlot.MORNING,
      );

      expect(queriedCities).toEqual([
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
      ]);
      expect(queriedCities).not.toContain('江西');
      expect(result.payload.city).toBe('江西');
      expect(
        strategy.resolveOrderGrabGroupKey({
          ...mockContext,
          city: '江西',
          groupName: '江西必胜客-短时班次兼职群',
          labels: ['抢单群', '江西'],
        }),
      ).toBe('江西');
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
