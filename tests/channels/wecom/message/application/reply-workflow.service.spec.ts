import { ReplyWorkflowService } from '@channels/wecom/message/application/reply-workflow.service';
import { EnterpriseMessageCallbackDto } from '@channels/wecom/message/ingress/message-callback.dto';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';

describe('ReplyWorkflowService', () => {
  const deduplicationService = {
    markMessageAsProcessedAsync: jest.fn(),
  };
  const deliveryService = {
    deliverReply: jest.fn(),
  };
  const runner = {
    invoke: jest.fn(),
  };
  const monitoringService = {
    recordSuccess: jest.fn(),
  };
  const wecomObservability = {
    startRequestTrace: jest.fn(),
    updateDispatch: jest.fn(),
    markWorkerStart: jest.fn(),
    markAiStart: jest.fn(),
    recordAgentRequest: jest.fn(),
    recordAgentResult: jest.fn(),
    markAiEnd: jest.fn(),
    buildSuccessMetadata: jest.fn(),
    buildMergedRequestContent: jest.fn(),
  };
  const runtimeConfig = {
    resolveWecomChatModelSelection: jest.fn(),
    getMergeDelayMs: jest.fn(),
  };
  const processingFailureService = {
    inferErrorType: jest.fn(),
    handleProcessingError: jest.fn(),
    sendFallbackAlert: jest.fn(),
  };
  const preAgentRiskIntercept = {
    precheck: jest.fn(),
  };

  let service: ReplyWorkflowService;

  beforeEach(() => {
    jest.clearAllMocks();
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValue(undefined);
    deliveryService.deliverReply.mockResolvedValue({
      success: true,
      segmentCount: 1,
      failedSegments: 0,
      totalTime: 120,
    });
    runner.invoke.mockResolvedValue({
      text: '我来帮你看一下',
      reasoning: 'checked',
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'checked' },
            { type: 'text', text: '我来帮你看一下' },
          ],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    });
    wecomObservability.startRequestTrace.mockResolvedValue(undefined);
    wecomObservability.updateDispatch.mockResolvedValue(undefined);
    wecomObservability.markWorkerStart.mockResolvedValue(undefined);
    wecomObservability.markAiStart.mockResolvedValue(undefined);
    wecomObservability.recordAgentRequest.mockResolvedValue(undefined);
    wecomObservability.recordAgentResult.mockResolvedValue(undefined);
    wecomObservability.markAiEnd.mockResolvedValue(undefined);
    wecomObservability.buildSuccessMetadata.mockResolvedValue({ ok: true });
    wecomObservability.buildMergedRequestContent.mockReturnValue('合并后的消息');
    runtimeConfig.resolveWecomChatModelSelection.mockResolvedValue({
      overrideModelId: 'gpt-runtime',
      effectiveModelId: 'gpt-runtime',
      thinkingMode: 'deep',
      thinking: {
        type: 'enabled',
        budgetTokens: 4000,
      },
    });
    runtimeConfig.getMergeDelayMs.mockReturnValue(3500);
    processingFailureService.inferErrorType.mockReturnValue('message');
    processingFailureService.handleProcessingError.mockResolvedValue(undefined);
    preAgentRiskIntercept.precheck.mockResolvedValue({ hit: false });

    service = new ReplyWorkflowService(
      deduplicationService as never,
      deliveryService as never,
      runner as never,
      monitoringService as never,
      wecomObservability as never,
      runtimeConfig as never,
      processingFailureService as never,
      preAgentRiskIntercept as never,
    );
  });

  it('should execute the direct reply workflow and mark the message as processed', async () => {
    const message = createMessage();

    await service.processSingleMessage(message);

    expect(wecomObservability.startRequestTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-1',
        content: '你好',
      }),
    );
    expect(runner.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'chat-1',
        userId: 'im-contact-1',
        corpId: 'corp-1',
        modelId: 'gpt-runtime',
        thinking: {
          type: 'enabled',
          budgetTokens: 4000,
        },
      }),
    );
    expect(deliveryService.deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '我来帮你看一下',
      }),
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-1',
      }),
      true,
    );
    expect(wecomObservability.recordAgentResult).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({
        responseMessages: [
          expect.objectContaining({
            role: 'assistant',
          }),
        ],
      }),
    );
    expect(monitoringService.recordSuccess).toHaveBeenCalledWith('msg-1', { ok: true });
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
  });

  it('should delegate merged-message failures and rethrow the original error', async () => {
    const error = new Error('agent boom');
    runner.invoke.mockRejectedValueOnce(error);
    processingFailureService.inferErrorType.mockReturnValueOnce('merge');

    const messages = [
      createMessage(),
      createMessage({
        messageId: 'msg-2',
        payload: {
          text: '第二条消息',
          pureText: '第二条消息',
        },
      }),
    ];

    await expect(service.processMergedMessages(messages, 'batch-1')).rejects.toThrow('agent boom');

    expect(processingFailureService.inferErrorType).toHaveBeenCalledWith(error, 'merge');
    expect(processingFailureService.handleProcessingError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        messageId: 'msg-2',
      }),
      expect.objectContaining({
        traceId: 'batch-1',
        batchId: 'batch-1',
        dispatchMode: 'merged',
        processedMessageIds: ['msg-1', 'msg-2'],
      }),
    );
  });
});

function createMessage(
  overrides: Partial<EnterpriseMessageCallbackDto> = {},
): EnterpriseMessageCallbackDto {
  return {
    orgId: 'corp-1',
    token: 'token-1',
    botId: 'bot-1',
    botUserId: 'manager-1',
    imBotId: 'im-bot-1',
    chatId: 'chat-1',
    imContactId: 'im-contact-1',
    messageType: MessageType.TEXT,
    messageId: 'msg-1',
    timestamp: '1713168000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: {
      text: '你好',
      pureText: '你好',
    },
    contactName: '张三',
    _apiType: 'enterprise',
    ...overrides,
  } as EnterpriseMessageCallbackDto;
}
