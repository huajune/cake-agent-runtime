import { TestFeedbackService } from '@biz/test-suite/services/test-feedback.service';

describe('TestFeedbackService', () => {
  const feishuBitableService = {
    writeAgentTestFeedback: jest.fn(),
  };
  const service = new TestFeedbackService(feishuBitableService as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes feedback to Feishu and returns the record id', async () => {
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: true,
      recordId: 'rec-1',
    });

    await expect(
      service.submitFeedback({
        type: 'badcase',
        chatHistory: 'history',
        userMessage: 'message',
        errorType: 'guardrail',
        remark: 'remark',
        traceId: 'trace-1',
        candidateName: '候选人',
      } as any),
    ).resolves.toEqual({
      success: true,
      data: {
        recordId: 'rec-1',
        type: 'badcase',
        message: 'BadCase 已成功写入飞书表格',
      },
    });
    expect(feishuBitableService.writeAgentTestFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'badcase',
        userMessage: 'message',
        traceId: 'trace-1',
        candidateName: '候选人',
      }),
    );
  });

  it('passes source and screenshots through to Feishu payload', async () => {
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: true,
      recordId: 'rec-2',
    });

    await service.submitFeedback({
      type: 'badcase',
      chatHistory: 'history',
      source: 'reengagement',
      screenshots: ['data:image/png;base64,aGVsbG8='],
    } as any);

    expect(feishuBitableService.writeAgentTestFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'reengagement',
        screenshots: ['data:image/png;base64,aGVsbG8='],
      }),
    );
  });

  it('rejects screenshots larger than 5MB', async () => {
    const oversized = `data:image/png;base64,${'A'.repeat(7 * 1024 * 1024)}`;

    await expect(
      service.submitFeedback({
        type: 'badcase',
        chatHistory: 'history',
        screenshots: [oversized],
      } as any),
    ).rejects.toThrow('超过 5MB 限制');
    expect(feishuBitableService.writeAgentTestFeedback).not.toHaveBeenCalled();
  });

  it('rejects screenshots whose decoded total exceeds 10MB', async () => {
    const fourMb = `data:image/png;base64,${'A'.repeat(Math.ceil((4 * 1024 * 1024 * 4) / 3))}`;

    await expect(
      service.submitFeedback({
        type: 'badcase',
        chatHistory: 'history',
        screenshots: [fourMb, fourMb, fourMb],
      } as any),
    ).rejects.toThrow('截图总大小超过 10MB 限制');
    expect(feishuBitableService.writeAgentTestFeedback).not.toHaveBeenCalled();
  });

  it('throws when Feishu write fails', async () => {
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: false,
      error: 'api down',
    });

    await expect(service.submitFeedback({ type: 'goodcase' } as any)).rejects.toThrow('api down');
  });
});
