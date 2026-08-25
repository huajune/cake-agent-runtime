import { MemoryService } from '@memory/memory.service';

describe('MemoryService', () => {
  const mockWorkbench = {
    getStage: jest.fn(),
    setStage: jest.fn().mockResolvedValue(undefined),
    clearStage: jest.fn(),
  };

  const mockLongTerm = {
    getSessionSummaries: jest.fn(),
  };

  const mockLifecycle = {
    onTurnStart: jest.fn(),
    onTurnEnd: jest.fn().mockResolvedValue(undefined),
  };

  let service: MemoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MemoryService(
      mockWorkbench as never,
      mockLongTerm as never,
      { saveInvitedGroup: jest.fn().mockResolvedValue(undefined) } as never,
      mockLifecycle as never,
    );
  });

  describe('turn lifecycle facade', () => {
    it('should delegate onTurnStart to lifecycle service', async () => {
      mockLifecycle.onTurnStart.mockResolvedValue({
        shortTerm: {
          messageWindow: [{ role: 'user', content: 'hello' }],
          sessionState: null,
          stage: { currentStage: null, fromStage: null, advancedAt: null, reason: null },
        },
        turnHints: null,
        longTerm: { semantic: { profile: null } },
      });

      const ctx = await service.onTurnStart('corp1', 'user1', 'sess1');

      expect(mockLifecycle.onTurnStart).toHaveBeenCalledWith(
        'corp1',
        'user1',
        'sess1',
        undefined,
        undefined,
      );
      expect(ctx.shortTerm.messageWindow).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('should delegate onTurnEnd to lifecycle service', async () => {
      const ctx = {
        corpId: 'corp1',
        userId: 'user1',
        sessionId: 'sess1',
        normalizedMessages: [{ role: 'user', content: '你好' }],
      };

      await service.onTurnEnd(ctx as never, '收到');

      expect(mockLifecycle.onTurnEnd).toHaveBeenCalledWith(ctx, '收到');
    });
  });

  describe('proactive follow-up recall', () => {
    it('keeps the full Generator-trimmed message window without a second fixed limit', async () => {
      mockLifecycle.onTurnStart.mockResolvedValue({
        shortTerm: {
          messageWindow: [
            { role: 'user', content: '' },
            ...Array.from({ length: 12 }, (_, index) => ({
              role: index % 2 === 0 ? 'user' : 'assistant',
              content: `message-${index + 1}`,
            })),
          ],
          sessionState: null,
          stage: { currentStage: null, fromStage: null, advancedAt: null, reason: null },
        },
        turnHints: null,
        longTerm: { semantic: { profile: null } },
      });

      const recall = await service.recallForProactiveFollowUp('corp1', 'user1', 'sess1');

      expect(recall.recentMessages).toHaveLength(12);
      expect(recall.recentMessages[0]?.content).toBe('message-1');
      expect(recall.recentMessages[11]?.content).toBe('message-12');
    });

    it('preserves the same injected time format used by Generator', async () => {
      mockLifecycle.onTurnStart.mockResolvedValue({
        shortTerm: {
          messageWindow: [
            {
              role: 'user',
              content: '明天可以面试\n[消息发送时间：2026-07-12 16:30 星期日]',
            },
            {
              role: 'assistant',
              content: '好的\n[消息发送时间：2026-07-12 16:31 星期日]',
            },
          ],
          sessionState: null,
          stage: { currentStage: null, fromStage: null, advancedAt: null, reason: null },
        },
        turnHints: null,
        longTerm: { semantic: { profile: null } },
      });

      const recall = await service.recallForProactiveFollowUp('corp1', 'user1', 'sess1');

      expect(recall.recentMessages).toEqual([
        {
          role: 'user',
          content: '明天可以面试\n[消息发送时间：2026-07-12 16:30 星期日]',
        },
        {
          role: 'assistant',
          content: '好的\n[消息发送时间：2026-07-12 16:31 星期日]',
        },
      ]);
    });
  });

  describe('facade methods', () => {
    it('should get summary data via facade', async () => {
      mockLongTerm.getSessionSummaries.mockResolvedValue({
        recent: [],
        archive: [],
        lastSettledMessageAt: null,
      });

      const summary = await service.getSessionSummaries('corp1', 'user1', 'wecom-user-1');

      expect(summary).toEqual({ recent: [], archive: [], lastSettledMessageAt: null });
      expect(mockLongTerm.getSessionSummaries).toHaveBeenCalledWith(
        'corp1',
        'user1',
        'wecom-user-1',
      );
    });

    it('should set stage via facade', async () => {
      const nextStage = {
        currentStage: 'job_consultation',
        fromStage: 'trust_building',
        advancedAt: '2026-03-31T00:00:00.000Z',
        reason: '用户开始咨询岗位',
      };

      await service.setStage('corp1', 'user1', 'sess1', nextStage);

      expect(mockWorkbench.setStage).toHaveBeenCalledWith('corp1', 'user1', 'sess1', nextStage);
    });
  });
});
