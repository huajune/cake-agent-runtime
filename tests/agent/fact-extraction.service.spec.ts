import { FactExtractionService } from '@agent/fact-extraction.service';

// Mock generateText + Output from 'ai'
jest.mock('ai', () => ({
  generateText: jest.fn(),
  Output: {
    object: jest.fn().mockImplementation((opts: unknown) => opts),
  },
}));

import { generateText } from 'ai';

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

/** 构造 generateText 的 mock 返回值（仅用到 output 字段） */
function mockOutput(obj: unknown) {
  return { output: obj } as never;
}

describe('FactExtractionService', () => {
  const mockMemoryService = {
    getFacts: jest.fn(),
    saveFacts: jest.fn().mockResolvedValue(undefined),
  };

  const mockRouter = {
    resolveByRole: jest.fn().mockReturnValue('mock-model'),
  };

  const mockSponge = {
    fetchBrandList: jest.fn().mockResolvedValue([
      { name: '海底捞', aliases: ['HDL'] },
      { name: '肯德基', aliases: ['KFC', 'Kentucky'] },
    ]),
  };

  let service: FactExtractionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FactExtractionService(
      mockMemoryService as never,
      mockRouter as never,
      mockSponge as never,
    );
  });

  describe('extractAndSave', () => {
    it('should skip extraction on empty messages', async () => {
      await service.extractAndSave('corp1', 'user1', 'sess1', []);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('should use FULL_MESSAGES window on cache miss', async () => {
      mockMemoryService.getFacts.mockResolvedValue(null);
      mockGenerateText.mockResolvedValue(
        mockOutput({
          interview_info: {
            name: '张三',
            phone: null,
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
          reasoning: '用户自我介绍',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '你好，我叫张三' },
        { role: 'assistant', content: '你好张三！' },
      ]);

      expect(mockRouter.resolveByRole).toHaveBeenCalledWith('extract');
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-model',
          system: expect.any(String),
          prompt: expect.any(String),
        }),
      );
      expect(mockMemoryService.saveFacts).toHaveBeenCalledWith(
        'corp1',
        'user1',
        'sess1',
        expect.objectContaining({
          interview_info: expect.objectContaining({ name: '张三' }),
        }),
      );
    });

    it('should use INCREMENTAL_MESSAGES window on cache hit', async () => {
      mockMemoryService.getFacts.mockResolvedValue({
        interview_info: { name: '张三' },
        preferences: {},
        reasoning: 'prev',
      });
      mockGenerateText.mockResolvedValue(
        mockOutput({
          interview_info: {
            name: null,
            phone: '13800138000',
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
          reasoning: '用户提供电话',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '我的电话是13800138000' },
      ]);

      expect(mockMemoryService.saveFacts).toHaveBeenCalled();
    });

    it('should use fallback on LLM failure', async () => {
      mockMemoryService.getFacts.mockResolvedValue(null);
      mockGenerateText.mockRejectedValue(new Error('LLM timeout'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '你好' },
      ]);

      expect(mockMemoryService.saveFacts).toHaveBeenCalledWith(
        'corp1',
        'user1',
        'sess1',
        expect.objectContaining({
          reasoning: '实体提取失败，使用空值降级',
        }),
      );
    });

    it('should use fallback when output is null', async () => {
      mockMemoryService.getFacts.mockResolvedValue(null);
      mockGenerateText.mockResolvedValue(mockOutput(null));

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '你好' },
      ]);

      expect(mockMemoryService.saveFacts).toHaveBeenCalledWith(
        'corp1',
        'user1',
        'sess1',
        expect.objectContaining({
          reasoning: '实体提取失败，使用空值降级',
        }),
      );
    });

    it('should filter out system messages', async () => {
      mockMemoryService.getFacts.mockResolvedValue(null);
      mockGenerateText.mockResolvedValue(
        mockOutput({
          interview_info: {
            name: null,
            phone: null,
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
          reasoning: '无有效信息',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: '你好' },
      ]);

      // Should only process user/assistant messages
      expect(mockGenerateText).toHaveBeenCalled();
      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.prompt).not.toContain('You are a helpful assistant');
    });

    it('should include brand data in prompt', async () => {
      mockMemoryService.getFacts.mockResolvedValue(null);
      mockGenerateText.mockResolvedValue(
        mockOutput({
          interview_info: {
            name: null, phone: null, gender: null, age: null,
            applied_store: null, applied_position: null, interview_time: null,
            is_student: null, education: null, has_health_certificate: null,
          },
          preferences: {
            brands: null, salary: null, position: null, schedule: null,
            city: null, district: null, location: null, labor_form: null,
          },
          reasoning: '无',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '你好' },
      ]);

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.prompt).toContain('海底捞');
      expect(callArgs.prompt).toContain('肯德基');
      expect(callArgs.prompt).toContain('KFC');
    });
  });
});
