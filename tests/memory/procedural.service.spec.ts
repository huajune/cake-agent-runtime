import { ProceduralService } from '@memory/services/procedural.service';

describe('ProceduralService', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfig = { sessionTtl: 86400 };

  let service: ProceduralService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProceduralService(mockRedisStore as never, mockConfig as never);
  });

  describe('get', () => {
    it('should return null state when no data in Redis', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const state = await service.get('corp1', 'user1', 'session1');

      expect(state.currentStage).toBeNull();
      expect(state.fromStage).toBeNull();
      expect(state.advancedAt).toBeNull();
      expect(state.reason).toBeNull();
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

      expect(state.currentStage).toBe('needs_collection');
      expect(state.fromStage).toBe('trust_building');
      expect(state.reason).toBe('信任建立完成');
    });
  });

  describe('set', () => {
    it('should write stage to Redis with SESSION_TTL', async () => {
      await service.set('corp1', 'user1', 'session1', {
        currentStage: 'job_recommendation',
        fromStage: 'needs_collection',
        advancedAt: '2026-03-20T10:00:00Z',
        reason: '需求收集完成',
      });

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'stage:corp1:user1:session1',
        expect.objectContaining({ currentStage: 'job_recommendation' }),
        86400,
        false,
      );
    });
  });
});
