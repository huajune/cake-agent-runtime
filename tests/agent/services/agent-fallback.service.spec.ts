import { Test, TestingModule } from '@nestjs/testing';
import { AgentFallbackService } from '@agent/services/agent-fallback.service';

describe('AgentFallbackService', () => {
  let service: AgentFallbackService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentFallbackService],
    }).compile();

    service = module.get<AgentFallbackService>(AgentFallbackService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getFallbackMessage', () => {
    it('should return a non-empty string', () => {
      const message = service.getFallbackMessage();
      expect(message).toBeDefined();
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    });

    it('should return one of the predefined fallback messages', () => {
      // Call multiple times to verify it always returns from the known set
      const expectedMessages = [
        '我确认下哈，马上回你~',
        '我这边查一下，稍等~',
        '让我看看哈，很快~',
        '这块我再核实下，确认好马上告诉你哈~',
        '这个涉及几个细节，我确认下再回你',
        '这块资料我这边暂时没看到，我先帮你记下来，确认好回你~',
      ];

      for (let i = 0; i < 20; i++) {
        const message = service.getFallbackMessage();
        expect(expectedMessages).toContain(message);
      }
    });

    it('should return random messages (not always the same)', () => {
      // Call many times and verify we get at least 2 different messages
      // (statistical test - extremely unlikely to fail legitimately)
      const messages = new Set<string>();
      for (let i = 0; i < 50; i++) {
        messages.add(service.getFallbackMessage());
      }
      expect(messages.size).toBeGreaterThan(1);
    });
  });

  describe('getFallbackInfo', () => {
    it('should return structured fallback info with reason', () => {
      const reason = 'API timeout error';
      const result = service.getFallbackInfo(reason);

      expect(result).toBeDefined();
      expect(result.reason).toBe(reason);
      expect(result.message).toBeDefined();
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.suggestion).toBe('花卷Agent调用异常，请检查花卷Agent配置');
    });

    it('should include retryAfter when provided', () => {
      const reason = '请求频率过高';
      const retryAfter = 60;
      const result = service.getFallbackInfo(reason, retryAfter);

      expect(result.retryAfter).toBe(retryAfter);
    });

    it('should have undefined retryAfter when not provided', () => {
      const result = service.getFallbackInfo('some error');

      expect(result.retryAfter).toBeUndefined();
    });

    it('should return a message that is from the fallback messages list', () => {
      const expectedMessages = [
        '我确认下哈，马上回你~',
        '我这边查一下，稍等~',
        '让我看看哈，很快~',
        '这块我再核实下，确认好马上告诉你哈~',
        '这个涉及几个细节，我确认下再回你',
        '这块资料我这边暂时没看到，我先帮你记下来，确认好回你~',
      ];

      const result = service.getFallbackInfo('test error');
      expect(expectedMessages).toContain(result.message);
    });

    it('should preserve the exact error reason passed in', () => {
      const complexReason = 'AgentContextMissingException: missing fields userId, sessionId';
      const result = service.getFallbackInfo(complexReason);

      expect(result.reason).toBe(complexReason);
    });

    it('should handle empty string reason', () => {
      const result = service.getFallbackInfo('');

      expect(result.reason).toBe('');
      expect(result.message).toBeDefined();
      expect(result.suggestion).toBeDefined();
    });

    it('should return correct AgentFallbackInfo shape', () => {
      const result = service.getFallbackInfo('test reason', 30);

      expect(result).toMatchObject({
        reason: 'test reason',
        message: expect.any(String),
        suggestion: expect.any(String),
        retryAfter: 30,
      });
    });
  });
});
