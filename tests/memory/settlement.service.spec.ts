import { SettlementService } from '@memory/services/settlement.service';

describe('SettlementService', () => {
  const mockConfig = { sessionTtl: 86400, sessionTtlDays: 1 };

  const mockLongTermService = {
    getSummaryData: jest.fn(),
    saveProfile: jest.fn().mockResolvedValue(undefined),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
  };

  const mockChatSession = {
    getChatHistoryInRange: jest.fn(),
  };

  const mockLlm = {
    generate: jest.fn(),
  };

  let service: SettlementService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SettlementService(
      mockConfig as never,
      mockLongTermService as never,
      mockChatSession as never,
      mockLlm as never,
    );
    mockLongTermService.getSummaryData.mockResolvedValue({
      recent: [],
      archive: null,
      lastSettledMessageAt: null,
    });
  });

  it('should return false when no lastSessionActiveAt', () => {
    expect(service.shouldSettle(null)).toBe(false);
    expect(mockLongTermService.saveProfile).not.toHaveBeenCalled();
  });

  it('should return false when within SESSION_TTL', () => {
    expect(service.shouldSettle(new Date(Date.now() - 3600 * 1000).toISOString())).toBe(false);
  });

  it('should return true when idle >= SESSION_TTL', () => {
    expect(service.shouldSettle(new Date(Date.now() - 2 * 86400 * 1000).toISOString())).toBe(true);
  });

  it('should settle profile and summary when idle >= SESSION_TTL', async () => {
    mockChatSession.getChatHistoryInRange.mockResolvedValue([]);

    await service.settle('corp1', 'user1', 'sess1', {
      lastSessionActiveAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      facts: {
        interview_info: {
          name: '张三',
          phone: '138',
          gender: null,
          age: null,
          applied_store: null,
          applied_position: null,
          interview_time: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
        preferences: {
          brands: null,
          salary: null,
          position: null,
          schedule: null,
          city: null,
          district: null,
          location: null,
          labor_form: null,
        },
        reasoning: 'test',
      },
    });
    expect(mockLongTermService.saveProfile).toHaveBeenCalledWith(
      'corp1',
      'user1',
      expect.objectContaining({ name: '张三', phone: '138' }),
    );
    expect(mockLongTermService.markLastSettledMessageAt).toHaveBeenCalled();
  });

  it('should skip profile settlement when no facts', async () => {
    mockChatSession.getChatHistoryInRange.mockResolvedValue([]);

    await service.settle('corp1', 'user1', 'sess1', {
      lastSessionActiveAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      facts: null,
    });
    expect(mockLongTermService.saveProfile).not.toHaveBeenCalled();
  });

  it('should no-op when state is still within SESSION_TTL', async () => {
    await service.settle('corp1', 'user1', 'sess1', {
      lastSessionActiveAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      facts: null,
    });

    expect(mockLongTermService.saveProfile).not.toHaveBeenCalled();
    expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
  });

  it('should skip repeated settlement when lastSettledMessageAt already covers the session', async () => {
    const lastSessionActiveAt = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    mockLongTermService.getSummaryData.mockResolvedValue({
      recent: [],
      archive: null,
      lastSettledMessageAt: lastSessionActiveAt,
    });

    await service.settle('corp1', 'user1', 'sess1', {
      lastSessionActiveAt,
      facts: null,
    });

    expect(mockChatSession.getChatHistoryInRange).not.toHaveBeenCalled();
    expect(mockLongTermService.saveProfile).not.toHaveBeenCalled();
    expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
  });
});
