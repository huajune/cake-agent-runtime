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

  it('throws when Feishu write fails', async () => {
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: false,
      error: 'api down',
    });

    await expect(service.submitFeedback({ type: 'goodcase' } as any)).rejects.toThrow('api down');
  });
});
