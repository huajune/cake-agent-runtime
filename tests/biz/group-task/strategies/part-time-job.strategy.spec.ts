import { PartTimeJobStrategy } from '@biz/group-task/strategies/part-time-job.strategy';
import { GroupContext } from '@biz/group-task/group-task.types';

describe('PartTimeJobStrategy', () => {
  let strategy: PartTimeJobStrategy;
  let mockSpongeService: Record<string, jest.Mock>;
  let mockBrandRotation: Record<string, jest.Mock>;

  beforeEach(() => {
    mockSpongeService = {
      fetchJobs: jest.fn(),
    };
    mockBrandRotation = {
      getNextBrand: jest.fn(),
      recordPushedBrand: jest.fn(),
    };

    strategy = new PartTimeJobStrategy(mockSpongeService as any, mockBrandRotation as any);
  });

  const makeGroup = (overrides?: Partial<GroupContext>): GroupContext => ({
    imRoomId: 'room-1',
    groupName: '测试兼职群',
    city: '上海',
    industry: '餐饮',
    tag: '兼职群',
    imBotId: 'bot-1',
    token: 'token-1',
    chatId: 'chat-1',
    ...overrides,
  });

  const makeJob = (brand: string, category: string) => ({
    basicInfo: {
      brandName: brand,
      jobCategoryName: category,
      jobName: `${brand}-测试岗位`,
      jobNickName: '测试',
      laborForm: '兼职',
      storeInfo: { storeName: '测试门店', storeCityName: '上海' },
    },
    jobSalary: {
      salaryScenarioList: [
        { basicSalary: { basicSalary: 20, basicSalaryUnit: '元/小时' } },
      ],
    },
  });

  describe('fetchData', () => {
    it('餐饮群应过滤掉零售岗位', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJob('必胜客', '普通服务员'),
          makeJob('奥乐齐', '零售/食品/导购'),
          makeJob('大米先生', '厨师'),
        ],
        total: 3,
      });
      mockBrandRotation.getNextBrand.mockResolvedValue('必胜客');

      const result = await strategy.fetchData(makeGroup());

      // 应该只有餐饮岗位的品牌
      expect(mockBrandRotation.getNextBrand).toHaveBeenCalledWith('room-1', ['必胜客', '大米先生']);
      expect(result.hasData).toBe(true);
      expect(result.payload.brand).toBe('必胜客');
    });

    it('零售群应只保留零售岗位', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJob('必胜客', '普通服务员'),
          makeJob('奥乐齐', '零售/食品/导购'),
        ],
        total: 2,
      });
      mockBrandRotation.getNextBrand.mockResolvedValue('奥乐齐');

      const result = await strategy.fetchData(makeGroup({ industry: '零售', tag: '兼职群_上海_零售' }));

      expect(mockBrandRotation.getNextBrand).toHaveBeenCalledWith('room-1', ['奥乐齐']);
      expect(result.hasData).toBe(true);
      expect(result.payload.brand).toBe('奥乐齐');
    });

    it('无岗位时应返回 hasData=false', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const result = await strategy.fetchData(makeGroup());

      expect(result.hasData).toBe(false);
    });

    it('无品牌可选时应返回 hasData=false', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [makeJob('必胜客', '普通服务员')],
        total: 1,
      });
      mockBrandRotation.getNextBrand.mockResolvedValue(null);

      const result = await strategy.fetchData(makeGroup());

      expect(result.hasData).toBe(false);
    });
  });

  describe('buildPrompt', () => {
    it('应包含品牌名和城市', () => {
      const prompt = strategy.buildPrompt(
        { hasData: true, payload: { brand: '必胜客', jobs: [makeJob('必胜客', '服务员')] }, summary: '' },
        makeGroup(),
      );

      expect(prompt.userMessage).toContain('必胜客');
      expect(prompt.userMessage).toContain('上海');
      expect(prompt.systemPrompt).toContain('兼职招聘群');
    });
  });
});
