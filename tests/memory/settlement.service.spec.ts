import { SettlementService } from '@memory/services/settlement.service';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';

describe('SettlementService', () => {
  const SETTLEMENT_GAP = 86400; // 1 day in seconds
  const mockConfig = { settlementGapSeconds: SETTLEMENT_GAP };

  const mockLongTermService = {
    getSummaryData: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
    writeFromSettlement: jest.fn().mockResolvedValue(undefined),
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
    // ==================== 冷启动场景 ====================

    it('should initialize boundary to latest message on cold start (no full-history settlement)', async () => {
      const now = Date.now();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: null,
      });
      mockChatSession.getChatHistoryInRange.mockResolvedValue([
        { role: 'user', content: 'hello', timestamp: now - 3600 * 1000 },
        { role: 'assistant', content: 'hi', timestamp: now - 1800 * 1000 },
      ]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockLongTermService.markLastSettledMessageAt).toHaveBeenCalledWith(
        'corp1',
        'user1',
        new Date(now - 1800 * 1000).toISOString(),
      );
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
    });

    it('should NOT advance boundary when no messages (cold start, prevents DB-outage skip)', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: null,
      });
      mockChatSession.getChatHistoryInRange.mockResolvedValue([]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockLongTermService.markLastSettledMessageAt).not.toHaveBeenCalled();
    });

    it('should only initialize boundary on cold start even when gap exists (settlement on next turn)', async () => {
      const now = Date.now();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: null,
      });

      const oldMsg = { role: 'user' as const, content: '找工作', timestamp: now - 3 * 86400 * 1000 };
      const oldMsg2 = {
        role: 'assistant' as const,
        content: '好的',
        timestamp: now - 3 * 86400 * 1000 + 60000,
      };
      const newMsg = { role: 'user' as const, content: '还在么', timestamp: now - 3600 * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([oldMsg, oldMsg2, newMsg]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      // Cold start: initialize boundary to latest, don't settle yet
      expect(result).toBe(false);
      expect(mockLongTermService.markLastSettledMessageAt).toHaveBeenCalledWith(
        'corp1',
        'user1',
        new Date(newMsg.timestamp).toISOString(),
      );
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
    });

    it('should handle getSummaryData returning null gracefully (cold start)', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue(null);
      mockChatSession.getChatHistoryInRange.mockResolvedValue([]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
    });

    // ==================== 快速跳过 ====================

    it('should skip DB query when lastSettledAt is within settlementGapSeconds (fast path)', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago, gap=1day
      });

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockChatSession.getChatHistoryInRange).not.toHaveBeenCalled();
    });

    // ==================== 正常流程 ====================

    it('should return false when no messages since lastSettledMessageAt', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: new Date(Date.now() - 2 * SETTLEMENT_GAP * 1000).toISOString(),
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
        lastSettledMessageAt: new Date(now - 2 * 3600 * 1000).toISOString(),
      });
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
      const lastSettled = new Date(now - 3 * SETTLEMENT_GAP * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const oldMsg1 = { role: 'user' as const, content: '我想找工作', timestamp: now - 3 * 86400 * 1000 };
      const oldMsg2 = { role: 'assistant' as const, content: '好的', timestamp: now - 3 * 86400 * 1000 + 60000 };
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

    // ==================== 多断层：只沉淀第一个 ====================

    it('should use the FIRST gap when multiple gaps exist (settle one session per turn)', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 5 * 86400 * 1000).toISOString();
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
      // gap ~1.5 days (> sessionTtl)
      const s3m1 = { role: 'user' as const, content: 'today', timestamp: now - 1.5 * 86400 * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([s1m1, s1m2, s2m1, s2m2, s3m1]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(true);
      // First gap is between s1m2 and s2m1 → only s1 messages are settled
      expect(mockLongTermService.appendSummary).toHaveBeenCalledWith(
        'corp1',
        'user1',
        expect.objectContaining({
          endTime: new Date(s1m2.timestamp).toISOString(),
        }),
        expect.objectContaining({ lastSettledMessageAt: new Date(s1m2.timestamp).toISOString() }),
      );
    });

    // ==================== 边界条件 ====================

    it('should trigger when gap is exactly equal to sessionTtl (boundary inclusive)', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 2 * SETTLEMENT_GAP * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const msg1 = { role: 'user' as const, content: 'old', timestamp: now - 2 * 86400 * 1000 };
      const msg2 = { role: 'user' as const, content: 'new', timestamp: msg1.timestamp + SETTLEMENT_GAP * 1000 };

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
      const lastSettled = new Date(now - 2 * SETTLEMENT_GAP * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const msg1 = { role: 'user' as const, content: 'old', timestamp: now - 2 * 86400 * 1000 };
      const msg2 = { role: 'user' as const, content: 'new', timestamp: msg1.timestamp + SETTLEMENT_GAP * 1000 - 1 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([msg1, msg2]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
    });

    it('should return false when all messages are in new session with no unsettled old messages', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 3 * SETTLEMENT_GAP * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const msg1 = { role: 'user' as const, content: 'hi', timestamp: now - 3600 * 1000 };
      const msg2 = { role: 'assistant' as const, content: 'hello', timestamp: now - 1800 * 1000 };

      mockChatSession.getChatHistoryInRange.mockResolvedValue([msg1, msg2]);

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
      expect(mockLongTermService.appendSummary).not.toHaveBeenCalled();
    });

    it('should return false and not throw if getChatHistoryInRange rejects', async () => {
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: new Date(Date.now() - 2 * SETTLEMENT_GAP * 1000).toISOString(),
      });
      mockChatSession.getChatHistoryInRange.mockRejectedValue(new Error('DB error'));

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(result).toBe(false);
    });

    // ==================== Profile 沉淀写入 ====================

    it('should call writeFromSettlement when facts are provided and settlement triggers', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 3 * SETTLEMENT_GAP * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const oldMsg = { role: 'user' as const, content: '我叫张三', timestamp: now - 3 * 86400 * 1000 };
      const newMsg = { role: 'user' as const, content: '还在么', timestamp: now - 3600 * 1000 };
      mockChatSession.getChatHistoryInRange.mockResolvedValue([oldMsg, newMsg]);

      const fakeFacts = {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          name: '张三',
          phone: '13800138000',
        },
        reasoning: 'test',
      };

      const result = await service.detectAndSettle('corp1', 'user1', 'sess1', fakeFacts);

      expect(result).toBe(true);
      expect(mockLongTermService.writeFromSettlement).toHaveBeenCalledWith(
        'corp1',
        'user1',
        fakeFacts,
      );
    });

    it('should NOT call writeFromSettlement when facts are null', async () => {
      const now = Date.now();
      const lastSettled = new Date(now - 3 * SETTLEMENT_GAP * 1000).toISOString();
      mockLongTermService.getSummaryData.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: lastSettled,
      });

      const oldMsg = { role: 'user' as const, content: 'hi', timestamp: now - 3 * 86400 * 1000 };
      const newMsg = { role: 'user' as const, content: 'hello', timestamp: now - 3600 * 1000 };
      mockChatSession.getChatHistoryInRange.mockResolvedValue([oldMsg, newMsg]);

      await service.detectAndSettle('corp1', 'user1', 'sess1', null);

      expect(mockLongTermService.writeFromSettlement).not.toHaveBeenCalled();
    });
  });
});
