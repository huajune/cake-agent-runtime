import { SessionFactsService } from '@memory/session-facts.service';
import type { EntityExtractionResult } from '@memory/memory.types';
import { FALLBACK_EXTRACTION } from '@memory/memory.types';

describe('SessionFactsService', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfig = { sessionTtl: 86400 };

  let service: SessionFactsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionFactsService(mockRedisStore as never, mockConfig as never);
  });

  describe('getSessionState', () => {
    it('should return empty state when no data in Redis', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state.facts).toBeNull();
      expect(state.lastRecommendedJobs).toBeNull();
    });

    it('should return stored session state', async () => {
      const stored = {
        content: {
          facts: FALLBACK_EXTRACTION,
          lastRecommendedJobs: [],
          lastInteraction: '2026-03-20T00:00:00Z',
        },
      };
      mockRedisStore.get.mockResolvedValue(stored);

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state.facts).toEqual(FALLBACK_EXTRACTION);
      expect(state.lastInteraction).toBe('2026-03-20T00:00:00Z');
    });
  });

  describe('saveFacts', () => {
    it('should deepMerge with existing facts', async () => {
      const existing: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三' },
      };
      mockRedisStore.get.mockResolvedValue({
        content: { facts: existing, lastRecommendedJobs: null },
      });

      const newFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, phone: '13800138000' },
      };

      await service.saveFacts('corp1', 'user1', 'session1', newFacts);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: '张三',
              phone: '13800138000',
            }),
          }),
        }),
        86400,
        false,
      );
    });
  });

  describe('getLastInteraction', () => {
    it('should return null when no state exists', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const result = await service.getLastInteraction('corp1', 'user1', 'session1');

      expect(result).toBeNull();
    });

    it('should return lastInteraction from state', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: { lastInteraction: '2026-03-20T10:00:00Z' },
      });

      const result = await service.getLastInteraction('corp1', 'user1', 'session1');

      expect(result).toBe('2026-03-20T10:00:00Z');
    });
  });

  describe('formatForPrompt', () => {
    it('should return empty string for empty state', () => {
      const result = service.formatForPrompt({ facts: null, lastRecommendedJobs: null });

      expect(result).toBe('');
    });

    it('should format facts into prompt section', () => {
      const state = {
        facts: {
          ...FALLBACK_EXTRACTION,
          interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三', phone: '138' },
          preferences: { ...FALLBACK_EXTRACTION.preferences, city: '上海' },
        },
        lastRecommendedJobs: null,
      };

      const result = service.formatForPrompt(state);

      expect(result).toContain('姓名: 张三');
      expect(result).toContain('联系方式: 138');
      expect(result).toContain('意向城市: 上海');
    });
  });
});
