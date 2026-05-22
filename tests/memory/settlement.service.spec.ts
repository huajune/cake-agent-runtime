import { SettlementService } from '@memory/services/settlement.service';

describe('SettlementService', () => {
  const SESSION_TTL = 86400; // 1 day in seconds
  const mockConfig = { sessionTtl: SESSION_TTL };

  const mockLongTermService = {
    getSummaryData: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
  };

  const mockChatSession = {
    getChatHistoryInRange: jest.fn(),
  };

  const mockLlm = {
    generate: jest.fn().mockResolvedValue({ text: '本次会话摘要' }),
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
  });

  describe('detectAndSettle', () => {
    it('should return false when lastSettledMessageAt is null (no settlement baseline)', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: null,
      });

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockChatSession.getChatHistoryInRange).not.toHaveBeenCalled();
    });

    it('should return false when no messages since lastSettledMessageAt', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: new Date(Date.now() - 2 * SESSION_TTL * 1000).toISOString(),
      });
      mockChatSession.getChatHistoryInRange.mockResolvedValue([]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
    });

    it('should return false when messages have no gap >= sessionTtl', async () => {
      const now = Date.now();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: new Date(now - 2 * 3600 * 1000).toISOString(), // 2h ago
      });
      // Messages within the same session (no gap >= 1 day)
      mockChatSession.getChatHistoryInRange.mockResolvedValue([
        { role: 'user', content: 'hello', timestamp: now - 1.5 * 3600 * 1000 },
        { role: 'assistant', content: 'hi', timestamp: now - 1 * 3600 * 1000 },
        { role: 'user', content: 'bye', timestamp: now - 0.5 * 3600 * 1000 },
      ]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
    });

    it('should detect session gap and trigger summary generation', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 3 * SESSION_TTL * 1000).toISOString(); // 3 days ago
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      // Old session: Day 1 (3 days ago)
      const oldMsg1 = { role: 'user' as const, content: '我想找工作', timestamp: now - 3 * 86400 * 1000 };
      const oldMsg2 = { role: 'assistant' as const, content: '好的', timestamp: now - 3 * 86400 * 1000 + 60000 };
      // Gap: 2 days (> sessionTtl = 1 day)
      // New session: Day 3 (1 day ago)
      const newMsg1 = { role: 'user' as const, content: '还在么', timestamp: now - 1 * 86400 * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([oldMsg1, oldMsg2, newMsg1]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(true);
      expect(mockLongTermService.appendSummary).toHaveBeenCalledWith(
        'corp1',
        'user1',
        expect.objectContaining({
          sessionId: 'sess1',
          endTime: new Date(oldMsg2.timestamp).toISOString(),
        }),
        expect.objectContaining({ lastSettledMessageAt: new Date(oldMsg2.timestamp).toISOString() }),
      );
    });

    it('should handle getSummaryData returning null gracefully', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue(null);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
    });

    it('should return false and not throw if getChatHistoryInRange rejects', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: new Date(Date.now() - 2 * SESSION_TTL * 1000).toISOString(),
      });
      mockChatSession.getChatHistoryInRange.mockRejectedValue(new Error('DB error'));

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
    });
  });
});
