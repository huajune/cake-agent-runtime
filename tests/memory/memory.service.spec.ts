import { MemoryService } from '@memory/memory.service';

describe('MemoryService', () => {
  const mockShortTerm = {};

  const mockSessionFacts = {
    getSessionState: jest.fn(),
  };

  const mockProcedural = {
    get: jest.fn(),
  };

  const mockLongTerm = {
    getProfile: jest.fn(),
  };

  let service: MemoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MemoryService(
      mockShortTerm as never,
      mockSessionFacts as never,
      mockProcedural as never,
      mockLongTerm as never,
    );
  });

  describe('recallAll', () => {
    it('should return complete memory context', async () => {
      mockSessionFacts.getSessionState.mockResolvedValue({
        facts: { interview_info: { name: '张三' }, preferences: {}, reasoning: '' },
        lastRecommendedJobs: null,
      });
      mockProcedural.get.mockResolvedValue({
        currentStage: 'needs_collection',
        advancedAt: null,
        reason: null,
      });
      mockLongTerm.getProfile.mockResolvedValue({ name: '张三', phone: '138' });

      const ctx = await service.recallAll('corp1', 'user1', 'sess1');

      expect(ctx.procedural.currentStage).toBe('needs_collection');
      expect(ctx.longTerm.profile?.name).toBe('张三');
      expect(ctx.sessionFacts).not.toBeNull();
    });

    it('should return null sessionFacts when no facts', async () => {
      mockSessionFacts.getSessionState.mockResolvedValue({
        facts: null,
        lastRecommendedJobs: null,
      });
      mockProcedural.get.mockResolvedValue({ currentStage: null, advancedAt: null, reason: null });
      mockLongTerm.getProfile.mockResolvedValue(null);

      const ctx = await service.recallAll('corp1', 'user1', 'sess1');

      expect(ctx.sessionFacts).toBeNull();
      expect(ctx.longTerm.profile).toBeNull();
      expect(ctx.procedural.currentStage).toBeNull();
    });

    it('should call all sub-services in parallel', async () => {
      mockSessionFacts.getSessionState.mockResolvedValue({ facts: null, lastRecommendedJobs: null });
      mockProcedural.get.mockResolvedValue({ currentStage: null, advancedAt: null, reason: null });
      mockLongTerm.getProfile.mockResolvedValue(null);

      await service.recallAll('corp1', 'user1', 'sess1');

      expect(mockSessionFacts.getSessionState).toHaveBeenCalledWith('corp1', 'user1', 'sess1');
      expect(mockProcedural.get).toHaveBeenCalledWith('corp1', 'user1', 'sess1');
      expect(mockLongTerm.getProfile).toHaveBeenCalledWith('corp1', 'user1');
    });
  });

  describe('sub-service access', () => {
    it('should expose sub-services as readonly properties', () => {
      expect(service.shortTerm).toBeDefined();
      expect(service.sessionFacts).toBeDefined();
      expect(service.procedural).toBeDefined();
      expect(service.longTerm).toBeDefined();
    });
  });
});
