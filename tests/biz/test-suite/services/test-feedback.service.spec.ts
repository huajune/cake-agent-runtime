import { TestFeedbackService } from '@biz/test-suite/services/test-feedback.service';

describe('TestFeedbackService', () => {
  const feishuBitableService = {
    writeAgentTestFeedback: jest.fn(),
  };
  const redisService = {
    setNx: jest.fn(),
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };
  const service = new TestFeedbackService(feishuBitableService as any, redisService as any);

  beforeEach(() => {
    jest.clearAllMocks();
    // 默认拿到去重位（首次提交）
    redisService.setNx.mockResolvedValue(true);
    redisService.setex.mockResolvedValue(undefined);
    redisService.del.mockResolvedValue(1);
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
        priority: 'P1',
        expectedBehavior: '信息不确定时先追问',
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
        priority: 'P1',
        expectedBehavior: '信息不确定时先追问',
      }),
    );
    // 成功写入后回填 recordId 到去重位
    expect(redisService.setex).toHaveBeenCalledWith(
      expect.stringContaining('test-suite:feedback:dedup:'),
      expect.any(Number),
      expect.objectContaining({ recordId: 'rec-1' }),
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

  it('skips the Feishu write and reports duplicate when dedup slot is taken', async () => {
    redisService.setNx.mockResolvedValue(false);
    redisService.get.mockResolvedValue({ recordId: 'rec-prior', submittedAt: '2026-08-20' });

    const result = await service.submitFeedback({
      type: 'badcase',
      chatHistory: 'history',
      errorType: '6-报名与收资',
    } as any);

    expect(result.success).toBe(true);
    expect(result.data.duplicate).toBe(true);
    expect(result.data.recordId).toBe('rec-prior');
    expect(result.data.message).toContain('已提交过');
    expect(feishuBitableService.writeAgentTestFeedback).not.toHaveBeenCalled();
  });

  it('uses different dedup keys for different categories of the same chat', async () => {
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: true,
      recordId: 'rec-3',
    });

    await service.submitFeedback({
      type: 'badcase',
      chatHistory: 'same-history',
      errorType: '3-就近岗位推荐',
    } as any);
    await service.submitFeedback({
      type: 'badcase',
      chatHistory: 'same-history',
      errorType: '6-报名与收资',
    } as any);

    const [keyA] = redisService.setNx.mock.calls[0];
    const [keyB] = redisService.setNx.mock.calls[1];
    expect(keyA).not.toBe(keyB);
  });

  it('releases the dedup slot when the Feishu write fails', async () => {
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: false,
      error: 'api down',
    });

    await expect(
      service.submitFeedback({ type: 'goodcase', chatHistory: 'history' } as any),
    ).rejects.toThrow('api down');
    expect(redisService.del).toHaveBeenCalledWith(
      expect.stringContaining('test-suite:feedback:dedup:'),
    );
  });

  it('fails open and still writes when Redis is unavailable', async () => {
    redisService.setNx.mockRejectedValue(new Error('redis down'));
    feishuBitableService.writeAgentTestFeedback.mockResolvedValue({
      success: true,
      recordId: 'rec-4',
    });

    const result = await service.submitFeedback({
      type: 'badcase',
      chatHistory: 'history',
    } as any);

    expect(result.data.recordId).toBe('rec-4');
    expect(feishuBitableService.writeAgentTestFeedback).toHaveBeenCalled();
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
    // 尺寸校验发生在去重占位之前，不应留下残留 key
    expect(redisService.setNx).not.toHaveBeenCalled();
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
