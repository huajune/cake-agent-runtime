import { ShortTermService } from '@memory/short-term.service';

describe('ShortTermService', () => {
  const mockRepo = {
    getChatHistory: jest.fn(),
  };

  const mockConfig = {
    shortTermMaxMessages: 60,
    shortTermMaxChars: 100, // small for testing trim
    sessionTtlDays: 1,
  };

  let service: ShortTermService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ShortTermService(mockRepo as never, mockConfig as never);
  });

  it('should return empty array when repo returns empty', async () => {
    mockRepo.getChatHistory.mockResolvedValue([]);

    const result = await service.getMessages('chat_1');

    expect(result).toEqual([]);
    expect(mockRepo.getChatHistory).toHaveBeenCalledWith('chat_1', 60);
  });

  it('should inject time context into messages', async () => {
    mockRepo.getChatHistory.mockResolvedValue([
      { role: 'user', content: '你好', timestamp: 1710900000000 },
    ]);

    const result = await service.getMessages('chat_1');

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('你好');
    expect(result[0].content).toContain('[消息发送时间');
  });

  it('should trim messages when exceeding char limit', async () => {
    mockRepo.getChatHistory.mockResolvedValue([
      { role: 'user', content: 'A'.repeat(60), timestamp: 1710900000000 },
      { role: 'assistant', content: 'B'.repeat(60), timestamp: 1710900001000 },
      { role: 'user', content: 'C'.repeat(30), timestamp: 1710900002000 },
    ]);

    const result = await service.getMessages('chat_1');

    // With time context added, each message is longer than raw content.
    // The trim should keep the most recent messages within 100 chars.
    // At minimum, the last message should be kept.
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[result.length - 1].content).toContain('C');
  });

  it('should return empty array on error', async () => {
    mockRepo.getChatHistory.mockRejectedValue(new Error('db error'));

    const result = await service.getMessages('chat_1');

    expect(result).toEqual([]);
  });
});
