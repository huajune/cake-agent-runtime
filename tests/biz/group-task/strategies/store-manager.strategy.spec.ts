import { StoreManagerStrategy } from '@biz/group-task/strategies/store-manager.strategy';
import { SpongeService } from '@sponge/sponge.service';
import { GroupContext } from '@biz/group-task/group-task.types';

describe('StoreManagerStrategy', () => {
  let strategy: StoreManagerStrategy;
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
      fetchInterviewSchedule: jest.fn(),
    };
    strategy = new StoreManagerStrategy(
      mockSpongeService as unknown as SpongeService,
    );
  });

  describe('fetchData', () => {
    it('should call fetchInterviewSchedule with today date and city', async () => {
      (
        mockSpongeService.fetchInterviewSchedule as jest.Mock
      ).mockResolvedValue([]);

      await strategy.fetchData(mockContext);

      expect(mockSpongeService.fetchInterviewSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          cityName: '上海',
        }),
      );
      expect(
        mockSpongeService.fetchInterviewSchedule,
      ).toHaveBeenCalledTimes(1);
    });

    it('should return hasData=true even when no interviews (店长群 always sends)', async () => {
      (
        mockSpongeService.fetchInterviewSchedule as jest.Mock
      ).mockResolvedValue([]);

      const result = await strategy.fetchData(mockContext);

      expect(result.hasData).toBe(true);
      expect(result.payload.interviews).toEqual([]);
    });

    it('should return hasData=true with interviews', async () => {
      const mockInterviews = [
        { id: 1, candidateName: '张三', storeName: '门店A', time: '10:00' },
        { id: 2, candidateName: '李四', storeName: '门店B', time: '14:00' },
      ];
      (
        mockSpongeService.fetchInterviewSchedule as jest.Mock
      ).mockResolvedValue(mockInterviews);

      const result = await strategy.fetchData(mockContext);

      expect(result.hasData).toBe(true);
      expect(result.payload).toBeDefined();
    });
  });
});
