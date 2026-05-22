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

    it('should use the LAST gap when multiple gaps exist (multi-session history)', async () => {
      // Scenario: 3 sessions in history — gaps at positions 2 and 4
      // Messages: [s1_msg1, s1_msg2] --- gap 2d --- [s2_msg1, s2_msg2] --- gap 1.5d --- [s3_msg1]
      // The loop keeps the LAST gap, so gapBeforeIndex = 4 (before s3_msg1)
      // → messages [0..3] = s1 + s2 are the "previous session"; endTime = s2_msg2
      const now = Date.now();
      const lastSettled = new Date(now - 5 * 86400 * 1000).toISOString(); // 5 days ago
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const s1m1 = { role: 'user' as const, content: 'day1', timestamp: now - 5 * 86400 * 1000 };
      const s1m2 = { role: 'assistant' as const, content: 'ok', timestamp: now - 5 * 86400 * 1000 + 60000 };
      // gap ~2 days (> sessionTtl)
      const s2m1 = { role: 'user' as const, content: 'day3', timestamp: now - 3 * 86400 * 1000 };
      const s2m2 = { role: 'assistant' as const, content: 'ok', timestamp: now - 3 * 86400 * 1000 + 60000 };
      // gap ~1.5 days (> sessionTtl = 1 day)
      const s3m1 = { role: 'user' as const, content: 'today', timestamp: now - 1.5 * 86400 * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([s1m1, s1m2, s2m1, s2m2, s3m1]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(true);
      // endTime should be the last message BEFORE the last gap = s2m2
      expect(mockLongTermService.appendSummary).toHaveBeenCalledWith(
        'corp1',
        'user1',
        expect.objectContaining({
          endTime: new Date(s2m2.timestamp).toISOString(),
        }),
        expect.objectContaining({ lastSettledMessageAt: new Date(s2m2.timestamp).toISOString() }),
      );
    });

    it('should trigger when gap is exactly equal to sessionTtl (boundary inclusive)', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 2 * SESSION_TTL * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const msg1 = { role: 'user' as const, content: 'old', timestamp: now - 2 * 86400 * 1000 };
      // Gap exactly = SESSION_TTL * 1000 ms (== 86400000 ms)
      const msg2 = { role: 'user' as const, content: 'new', timestamp: msg1.timestamp + SESSION_TTL * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([msg1, msg2]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(true);
      expect(mockLongTermService.appendSummary).toHaveBeenCalledWith(
        'corp1',
        'user1',
        expect.objectContaining({ endTime: new Date(msg1.timestamp).toISOString() }),
        expect.anything(),
      );
    });

    it('should NOT trigger when gap is one millisecond below sessionTtl', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 2 * SESSION_TTL * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const msg1 = { role: 'user' as const, content: 'old', timestamp: now - 2 * 86400 * 1000 };
      // Gap is 1 ms short of SESSION_TTL — should NOT trigger
      const msg2 = { role: 'user' as const, content: 'new', timestamp: msg1.timestamp + SESSION_TTL * 1000 - 1 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([msg1, msg2]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
    });

    it('should return false when all messages are in new session with no unsettled old messages', async () => {
      // No internal gap, but gap from lastSettledAt to first message is >= sessionTtl
      // This means all messages are "new session" — old session had nothing left to settle
      const now = Date.now();
      const lastSettled = new Date(now - 3 * SESSION_TTL * 1000).toISOString(); // 3 days ago
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      // All messages are recent (today), no gap between them
      const msg1 = { role: 'user' as const, content: 'hi', timestamp: now - 3600 * 1000 };
      const msg2 = { role: 'assistant' as const, content: 'hello', timestamp: now - 1800 * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([msg1, msg2]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      // gapFromSettled (3 days) >= sessionTtl BUT no internal gap, so current code returns false
      // (all messages are new-session, nothing to settle from old)
      expect(result).toBe(false);
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
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
