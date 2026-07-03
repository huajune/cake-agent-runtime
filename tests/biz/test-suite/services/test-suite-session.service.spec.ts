import { BadRequestException } from '@nestjs/common';
import { TestSuiteSessionService } from '@biz/test-suite/services/test-suite-session.service';

describe('TestSuiteSessionService', () => {
  const memoryService = {
    clearLongTermMemory: jest.fn(),
  };
  const service = new TestSuiteSessionService(memoryService as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears long-term memory for the requested test session user', async () => {
    memoryService.clearLongTermMemory.mockResolvedValue({ profile: true });

    await expect(
      service.resetChatSession({ corpId: ' corp-1 ', userId: ' user-1 ' }),
    ).resolves.toEqual({
      success: true,
      data: { corpId: 'corp-1', userId: 'user-1', cleared: { profile: true } },
    });
    expect(memoryService.clearLongTermMemory).toHaveBeenCalledWith('corp-1', 'user-1');
  });

  it('defaults corpId to test and rejects blank userId', async () => {
    memoryService.clearLongTermMemory.mockResolvedValue(1);

    await expect(service.resetChatSession({ userId: 'user-1' })).resolves.toMatchObject({
      data: { corpId: 'test', userId: 'user-1' },
    });
    await expect(service.resetChatSession({ userId: '   ' })).rejects.toThrow(BadRequestException);
  });
});
