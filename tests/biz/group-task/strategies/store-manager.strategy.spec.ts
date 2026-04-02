import { StoreManagerStrategy } from '@biz/group-task/strategies/store-manager.strategy';
import { SpongeService } from '@sponge/sponge.service';
import { GroupContext } from '@biz/group-task/group-task.types';
import { buildStoreManagerMessage } from '@biz/group-task/prompts/store-manager.prompt';

describe('StoreManagerStrategy', () => {
  let strategy: StoreManagerStrategy;
  let mockSpongeService: Partial<SpongeService>;

  const mockContext: GroupContext = {
    imRoomId: 'room-1',
    groupName: '测试群',
    city: '成都',
    tag: '店长群',
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
    it('should call fetchInterviewSchedule with date range and target brand only', async () => {
      (
        mockSpongeService.fetchInterviewSchedule as jest.Mock
      ).mockResolvedValue([]);

      await strategy.fetchData(mockContext);

      expect(mockSpongeService.fetchInterviewSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          brandName: '成都你六姐',
          interviewStartTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} 00:00:00$/),
          interviewEndTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} 23:59:59$/),
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
      expect(result.summary).toBe('成都你六姐: 0人面试');
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
      expect(result.summary).toBe('成都你六姐: 2人面试');
    });

    it('should ignore city and still fetch target brand interviews', async () => {
      (
        mockSpongeService.fetchInterviewSchedule as jest.Mock
      ).mockResolvedValue([]);

      const result = await strategy.fetchData({
        ...mockContext,
        city: '上海',
      });

      expect(result.hasData).toBe(true);
      expect(result.summary).toBe('成都你六姐: 0人面试');
      expect(mockSpongeService.fetchInterviewSchedule).toHaveBeenCalledWith(
        expect.not.objectContaining({
          cityName: expect.anything(),
        }),
      );
    });
  });

  describe('buildMessage', () => {
    it('should keep full phone number in message', () => {
      const message = buildStoreManagerMessage({
        date: '2026-04-02',
        interviews: [
          {
            name: '张三',
            phone: '13800138000',
            interviewTime: '2026-04-02 10:00',
            jobName: '店员',
            storeName: '春熙路店',
            brandName: '成都你六姐',
          },
        ],
      });

      expect(message).toContain('电话：13800138000');
      expect(message).not.toContain('****');
    });
  });
});
