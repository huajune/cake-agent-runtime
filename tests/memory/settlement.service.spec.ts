import { SettlementService } from '@memory/settlement.service';

describe('SettlementService', () => {
  const mockConfig = { sessionTtl: 86400, sessionTtlDays: 1 };

  const mockSessionFacts = {
    getLastInteraction: jest.fn(),
    getSessionState: jest.fn(),
  };

  const mockLongTerm = {
    saveProfile: jest.fn().mockResolvedValue(undefined),
    appendSummary: jest.fn().mockResolvedValue(undefined),
  };

  const mockChatMessageRepo = {
    getChatHistory: jest.fn(),
  };

  const mockRouter = {
    resolveByRole: jest.fn().mockReturnValue('mock-model'),
  };

  let service: SettlementService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SettlementService(
      mockConfig as never,
      mockSessionFacts as never,
      mockLongTerm as never,
      mockChatMessageRepo as never,
      mockRouter as never,
    );
  });

  it('should return false when no lastInteraction', async () => {
    mockSessionFacts.getLastInteraction.mockResolvedValue(null);

    const result = await service.checkAndSettle('corp1', 'user1', 'sess1');

    expect(result).toBe(false);
    expect(mockLongTerm.saveProfile).not.toHaveBeenCalled();
  });

  it('should return false when within SESSION_TTL', async () => {
    // 1 hour ago — within 1 day TTL
    mockSessionFacts.getLastInteraction.mockResolvedValue(
      new Date(Date.now() - 3600 * 1000).toISOString(),
    );

    const result = await service.checkAndSettle('corp1', 'user1', 'sess1');

    expect(result).toBe(false);
  });

  it('should trigger settlement when idle >= SESSION_TTL', async () => {
    // 2 days ago — exceeds 1 day TTL
    mockSessionFacts.getLastInteraction.mockResolvedValue(
      new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
    );
    mockSessionFacts.getSessionState.mockResolvedValue({
      facts: {
        interview_info: { name: '张三', phone: '138', gender: null, age: null, applied_store: null, applied_position: null, interview_time: null, is_student: null, education: null, has_health_certificate: null },
        preferences: { brands: null, salary: null, position: null, schedule: null, city: null, district: null, location: null, labor_form: null },
        reasoning: 'test',
      },
      lastRecommendedJobs: null,
    });
    mockChatMessageRepo.getChatHistory.mockResolvedValue([]);

    const result = await service.checkAndSettle('corp1', 'user1', 'sess1');

    expect(result).toBe(true);
    expect(mockLongTerm.saveProfile).toHaveBeenCalledWith(
      'corp1',
      'user1',
      expect.objectContaining({ name: '张三', phone: '138' }),
    );
  });

  it('should skip profile settlement when no facts', async () => {
    mockSessionFacts.getLastInteraction.mockResolvedValue(
      new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
    );
    mockSessionFacts.getSessionState.mockResolvedValue({
      facts: null,
      lastRecommendedJobs: null,
    });
    mockChatMessageRepo.getChatHistory.mockResolvedValue([]);

    const result = await service.checkAndSettle('corp1', 'user1', 'sess1');

    expect(result).toBe(true);
    expect(mockLongTerm.saveProfile).not.toHaveBeenCalled();
  });

  it('should return false on error (graceful degradation)', async () => {
    mockSessionFacts.getLastInteraction.mockRejectedValue(new Error('Redis error'));

    const result = await service.checkAndSettle('corp1', 'user1', 'sess1');

    expect(result).toBe(false);
  });
});
