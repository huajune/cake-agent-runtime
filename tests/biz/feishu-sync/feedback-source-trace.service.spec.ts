import { FeedbackSourceTraceService } from '@biz/feishu-sync/feedback-source-trace.service';

describe('FeedbackSourceTraceService', () => {
  const mockMessageProcessingService = {
    getMessageProcessingRecordById: jest.fn(),
    getMessageProcessingRecords: jest.fn(),
  };

  let service: FeedbackSourceTraceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeedbackSourceTraceService(mockMessageProcessingService as any);
  });

  it('should merge feedback trace fields with message processing details', async () => {
    mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue({
      messageId: 'msg-1',
      chatId: 'chat-1',
      userId: 'user-1',
      userName: '候选人',
      managerName: '经理',
      receivedAt: 1777269690302,
      messagePreview: '想找附近门店',
      status: 'success',
      batchId: 'batch-from-record',
      agentInvocation: {
        request: { modelId: 'model-1', scenario: 'candidate-consultation', messages: [{}] },
        response: { traceId: 'trace-from-record', finishReason: 'stop' },
      },
      toolCalls: [{ toolName: 'duliday_job_list', status: 'ok', resultCount: 2 }],
    });

    const trace = await service.build({
      type: 'badcase',
      chatHistory: '用户: 想找附近门店',
      userMessage: '想找附近门店',
      chatId: 'chat-1',
      messageId: 'msg-1',
      traceId: 'trace-from-feedback',
      batchId: 'batch-from-feedback',
      sourceTrace: {
        badcaseIds: ['bad-1'],
        raw: { importedBy: 'test' },
      },
    });

    expect(trace).toEqual(
      expect.objectContaining({
        badcaseIds: ['bad-1'],
        chatIds: ['chat-1'],
        anchorMessageIds: ['msg-1'],
        messageProcessingIds: ['msg-1'],
        traceIds: ['trace-from-feedback', 'trace-from-record'],
        batchIds: ['batch-from-feedback', 'batch-from-record'],
      }),
    );
    expect(trace?.raw).toEqual(
      expect.objectContaining({
        importedBy: 'test',
        feedback: { submittedVia: 'test-suite/feedback', type: 'badcase' },
        messageProcessing: expect.objectContaining({
          messageId: 'msg-1',
          agentInvocation: expect.objectContaining({
            request: { modelId: 'model-1', scenario: 'candidate-consultation', messageCount: 1 },
          }),
        }),
      }),
    );
  });

  it('should fall back to chat records and pick the record matching user message', async () => {
    mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue(null);
    mockMessageProcessingService.getMessageProcessingRecords.mockResolvedValue([
      { messageId: 'msg-old', messagePreview: '旧消息' },
      { messageId: 'msg-match', messagePreview: '我想找静安附近兼职' },
    ]);

    const trace = await service.build({
      type: 'goodcase',
      chatHistory: '用户: 我想找静安附近兼职',
      userMessage: '想找静安附近兼职',
      chatId: 'chat-1',
    });

    expect(trace?.anchorMessageIds).toEqual(['msg-match']);
    expect(trace?.messageProcessingIds).toEqual(['msg-match']);
  });

  it('should stringify compact traces and omit empty branches', () => {
    expect(
      service.stringifyCompact({
        traceIds: ['trace-1'],
        raw: { keep: true, drop: undefined, empty: [] },
      }),
    ).toBe('{\n  "traceIds": [\n    "trace-1"\n  ],\n  "raw": {\n    "keep": true\n  }\n}');

    expect(service.stringifyCompact({ raw: { empty: [] } })).toBeUndefined();
  });
});
