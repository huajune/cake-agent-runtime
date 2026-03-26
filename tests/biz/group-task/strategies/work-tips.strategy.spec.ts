import { WorkTipsStrategy } from '@biz/group-task/strategies/work-tips.strategy';
import { GroupContext } from '@biz/group-task/group-task.types';

describe('WorkTipsStrategy', () => {
  let strategy: WorkTipsStrategy;

  beforeEach(() => {
    strategy = new WorkTipsStrategy();
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

  describe('fetchData', () => {
    it('应始终返回 hasData=true', async () => {
      const result = await strategy.fetchData(makeGroup());
      expect(result.hasData).toBe(true);
    });

    it('应包含行业和周数信息', async () => {
      const result = await strategy.fetchData(makeGroup());
      expect(result.payload.industry).toBe('餐饮');
      expect(typeof result.payload.weekNumber).toBe('number');
      expect(result.payload.weekNumber).toBeGreaterThan(0);
    });

    it('零售群应返回零售行业', async () => {
      const result = await strategy.fetchData(makeGroup({ industry: '零售' }));
      expect(result.payload.industry).toBe('零售');
    });

    it('无行业时默认餐饮', async () => {
      const result = await strategy.fetchData(makeGroup({ industry: undefined }));
      expect(result.payload.industry).toBe('餐饮');
    });
  });

  describe('buildPrompt', () => {
    it('应包含周数和行业', () => {
      const prompt = strategy.buildPrompt(
        { hasData: true, payload: { industry: '餐饮', weekNumber: 13 }, summary: '' },
        makeGroup(),
      );

      expect(prompt.userMessage).toContain('13');
      expect(prompt.userMessage).toContain('餐饮');
      expect(prompt.systemPrompt).toContain('岗位小贴士');
    });
  });
});
