import { StageStateService } from '@memory/stage-state/stage-state.service';

describe('StageStateService', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfig = { sessionTtl: 86400 };

  let service: StageStateService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StageStateService(mockRedisStore as never, mockConfig as never);
  });

  describe('get', () => {
    it('should return null state when no data in Redis', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const state = await service.get('corp1', 'user1', 'session1');

      expect(state).toEqual({ currentStage: null });
    });

    it('should return stored stage state', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          currentStage: 'needs_collection',
          fromStage: 'trust_building',
          advancedAt: '2026-03-20T10:00:00Z',
          reason: '信任建立完成',
        },
      });

      const state = await service.get('corp1', 'user1', 'session1');

      // 旧记录里的 fromStage/advancedAt/reason 不再读出（记忆审计 S10 删只写字段）：
      // 它们只写不读，存量随会话 TTL 自然过期。
      expect(state).toEqual({ currentStage: 'needs_collection' });
    });
  });

  describe('set', () => {
    it('should write stage to Redis with SESSION_TTL', async () => {
      await service.set('corp1', 'user1', 'session1', { currentStage: 'job_recommendation' });

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'stage:corp1:user1:session1',
        expect.objectContaining({ currentStage: 'job_recommendation' }),
        86400,
        false,
      );
    });
  });
});
