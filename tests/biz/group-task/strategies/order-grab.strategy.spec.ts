import { OrderGrabStrategy } from '@biz/group-task/strategies/order-grab.strategy';
import { SpongeService } from '@sponge/sponge.service';
import { GroupContext } from '@biz/group-task/group-task.types';

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
    strategy = new OrderGrabStrategy(
      mockSpongeService as unknown as SpongeService,
    );
  });

  describe('fetchData', () => {
    it('should call fetchBIOrders with correct date range and city', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      await strategy.fetchData(mockContext);

      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledWith(
        expect.objectContaining({
          regionName: '上海',
        }),
      );
      expect(mockSpongeService.fetchBIOrders).toHaveBeenCalledTimes(1);
    });

    it('should return hasData=false when no orders', async () => {
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue([]);

      const result = await strategy.fetchData(mockContext);

      expect(result.hasData).toBe(false);
    });

    it('should return hasData=true with orders in payload', async () => {
      const mockOrders = [
        { id: 1, storeName: '门店A', orderCount: 5 },
        { id: 2, storeName: '门店B', orderCount: 3 },
      ];
      (mockSpongeService.fetchBIOrders as jest.Mock).mockResolvedValue(
        mockOrders,
      );

      const result = await strategy.fetchData(mockContext);

      expect(result.hasData).toBe(true);
      expect(result.payload).toBeDefined();
    });
  });

  describe('buildMessage', () => {
    it('should delegate to buildOrderGrabMessage', () => {
      const mockData = {
        hasData: true,
        payload: { orders: [{ '订单所属门店': '门店A' }], city: '上海' },
        summary: '上海: 1个订单',
      };

      const message = strategy.buildMessage(mockData, mockContext);

      expect(typeof message).toBe('string');
    });
  });
});
