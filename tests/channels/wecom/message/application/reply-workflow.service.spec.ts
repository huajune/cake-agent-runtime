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
    hasTrace: jest.fn(),
    startRequestTrace: jest.fn(),
    mergePrepTimingsFromSources: jest.fn(),
    updateDispatch: jest.fn(),
    markWorkerStart: jest.fn(),
    markAiStart: jest.fn(),
    recordAgentRequest: jest.fn(),
    recordAgentResult: jest.fn(),
    markAiEnd: jest.fn(),
    markReplySkipped: jest.fn(),
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
  const simpleMergeService = {
    getAndClearPendingMessages: jest.fn(),
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
    wecomObservability.hasTrace.mockResolvedValue(false);
    wecomObservability.startRequestTrace.mockResolvedValue(undefined);
    wecomObservability.mergePrepTimingsFromSources.mockResolvedValue(undefined);
    wecomObservability.updateDispatch.mockResolvedValue(undefined);
    wecomObservability.markWorkerStart.mockResolvedValue(undefined);
    wecomObservability.markAiStart.mockResolvedValue(undefined);
    wecomObservability.recordAgentRequest.mockResolvedValue(undefined);
    wecomObservability.recordAgentResult.mockResolvedValue(undefined);
    wecomObservability.markAiEnd.mockResolvedValue(undefined);
    wecomObservability.markReplySkipped.mockResolvedValue(undefined);
    wecomObservability.buildSuccessMetadata.mockResolvedValue({ ok: true });
    wecomObservability.buildMergedRequestContent.mockImplementation(
      (messages: EnterpriseMessageCallbackDto[]) =>
        messages
          .map((m) => {
            const payload = m.payload as { text?: string; pureText?: string } | undefined;
            return payload?.pureText ?? payload?.text ?? '';
          })
          .join('\n'),
    );
    simpleMergeService.getAndClearPendingMessages.mockResolvedValue({
      messages: [],
      batchId: '',
    });
    runtimeConfig.resolveWecomChatModelSelection.mockResolvedValue({
      overrideModelId: 'gpt-runtime',
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
      simpleMergeService as never,
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
        externalUserId: 'external-user-1',
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

  describe('投递前重跑（replay）', () => {
    it('Case A: pending list 为空时不触发重跑，直接投递首次回复并触发 turn-end 生命周期', async () => {
      const message = createMessage();
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '我来帮你看一下',
        reasoning: undefined,
        responseMessages: [],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        runTurnEnd: firstRunTurnEnd,
      });

      await service.processSingleMessage(message);

      expect(simpleMergeService.getAndClearPendingMessages).toHaveBeenCalledTimes(1);
      expect(simpleMergeService.getAndClearPendingMessages).toHaveBeenCalledWith('chat-1');
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      // 首次调用必须启用 deferTurnEnd，以便在检测到新消息时能丢弃首次的记忆副作用
      expect(runner.invoke.mock.calls[0][0]).toEqual(
        expect.objectContaining({ deferTurnEnd: true }),
      );
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      // 无 replay：首次结果被采纳，调用方必须触发 runTurnEnd
      expect(firstRunTurnEnd).toHaveBeenCalledTimes(1);
    });

    it('Case B: 首次 Agent 完成后发现新消息，合并后重跑一次并投递第二次回复', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-1',
        payload: { text: '补充一句', pureText: '补充一句' },
      });
      const late2 = createMessage({
        messageId: 'msg-late-2',
        payload: { text: '再补一句', pureText: '再补一句' },
      });
      simpleMergeService.getAndClearPendingMessages.mockResolvedValueOnce({
        messages: [late1, late2],
        batchId: 'batch-late',
      });
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke
        .mockResolvedValueOnce({
          text: '首次回复（会被丢弃）',
          reasoning: undefined,
          responseMessages: [],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          runTurnEnd: firstRunTurnEnd,
        })
        .mockResolvedValueOnce({
          text: '合并后的最终回复',
          reasoning: undefined,
          responseMessages: [],
          usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        });

      await service.processSingleMessage(primary);

      expect(runner.invoke).toHaveBeenCalledTimes(2);
      // 首次启用 deferTurnEnd；第二次采用默认（runner 自动 dispatch）
      expect(runner.invoke.mock.calls[0][0]).toEqual(
        expect.objectContaining({ deferTurnEnd: true }),
      );
      expect(runner.invoke.mock.calls[1][0].deferTurnEnd).toBeUndefined();
      // 首次的 runTurnEnd 必须被丢弃——它承载了「未发出的首次回复」对 session 记忆的污染
      expect(firstRunTurnEnd).not.toHaveBeenCalled();
      expect(runner.invoke.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          // 第二次 invoke 的 userMessage 应当是合并后的新内容
          messages: [
            expect.objectContaining({
              role: 'user',
              content: '你好\n补充一句\n再补一句',
            }),
          ],
        }),
      );
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      expect(deliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '合并后的最终回复' }),
        expect.anything(),
        true,
      );
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-late-1');
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-late-2');
      // Replay 合入的新消息需要回收源流水，否则它们的 processing 行会永远孤儿
      expect(wecomObservability.mergePrepTimingsFromSources).toHaveBeenCalledWith('msg-1', [
        'msg-late-1',
        'msg-late-2',
      ]);
    });

    it('Case C: 重跑只允许一次——第二次 Agent 生成期间又有新消息也不再重跑', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-1',
        payload: { text: '第二条', pureText: '第二条' },
      });
      const late2 = createMessage({
        messageId: 'msg-late-2',
        payload: { text: '第三条', pureText: '第三条' },
      });

      simpleMergeService.getAndClearPendingMessages.mockResolvedValue({
        messages: [late1, late2],
        batchId: 'batch-late',
      });

      await service.processSingleMessage(primary);

      // 只检查一次 pending：首次 Agent 完成后
      expect(simpleMergeService.getAndClearPendingMessages).toHaveBeenCalledTimes(1);
      // 恰好重跑一次
      expect(runner.invoke).toHaveBeenCalledTimes(2);
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['advance_stage'],
      ['invite_to_group'],
      ['duliday_interview_booking'],
    ])(
      'Case E: 首次调用命中不可逆工具 [%s] 时跳过 replay，不 drain pending，直接投递首次回复',
      async (blockingToolName) => {
        const primary = createMessage();
        // 即便 pending 有新消息，也不应该被 drain；这里故意准备新消息来验证 skip 语义
        simpleMergeService.getAndClearPendingMessages.mockResolvedValue({
          messages: [
            createMessage({
              messageId: 'msg-late-irrev',
              payload: { text: '后补一句', pureText: '后补一句' },
            }),
          ],
          batchId: 'batch-late',
        });

        const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
        runner.invoke.mockResolvedValueOnce({
          text: '首次回复（必须投递）',
          reasoning: undefined,
          responseMessages: [],
          toolCalls: [{ toolName: blockingToolName, args: {} }],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          runTurnEnd: firstRunTurnEnd,
        });

        await service.processSingleMessage(primary);

        // 不 drain pending：新消息留给 MessageProcessor 的 checkAndProcessNewMessages 发起 follow-up job
        expect(simpleMergeService.getAndClearPendingMessages).not.toHaveBeenCalled();
        // 只调用一次 Agent；首次结果直接投递
        expect(runner.invoke).toHaveBeenCalledTimes(1);
        expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
        expect(deliveryService.deliverReply).toHaveBeenCalledWith(
          expect.objectContaining({ content: '首次回复（必须投递）' }),
          expect.anything(),
          true,
        );
        // 首次结果被采纳：必须显式触发 turn-end 生命周期（deferTurnEnd=true 的配套动作）
        expect(firstRunTurnEnd).toHaveBeenCalledTimes(1);
        // 只标记主消息已处理——后补的消息交给下一轮，不在本次 processedMessageIds 里
        expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
        expect(deduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalledWith(
          'msg-late-irrev',
        );
      },
    );

    it('Case F: 首次命中不可逆工具 + 无副作用的其他工具，仍然按 skip 处理', async () => {
      const primary = createMessage();
      runner.invoke.mockResolvedValueOnce({
        text: '已为你安排预约',
        reasoning: undefined,
        responseMessages: [],
        toolCalls: [
          { toolName: 'duliday_job_list', args: {} },
          { toolName: 'duliday_interview_booking', args: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.getAndClearPendingMessages).not.toHaveBeenCalled();
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
    });

    it('Case G: 首次只调用无副作用的工具 → 按常规路径检查 pending，无新消息则直接投递首次', async () => {
      const primary = createMessage();
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '先问下你意向',
        reasoning: undefined,
        responseMessages: [],
        toolCalls: [
          { toolName: 'duliday_job_list', args: {} },
          { toolName: 'save_image_description', args: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        runTurnEnd: firstRunTurnEnd,
      });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.getAndClearPendingMessages).toHaveBeenCalledTimes(1);
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      expect(firstRunTurnEnd).toHaveBeenCalledTimes(1);
    });

    it('Case D: 首次 skip_reply 但重跑产生真实回复 → 正常投递，不进主动沉默分支', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-1',
        payload: { text: '再问一下', pureText: '再问一下' },
      });
      simpleMergeService.getAndClearPendingMessages.mockResolvedValueOnce({
        messages: [late1],
        batchId: 'batch-late',
      });
      runner.invoke
        .mockResolvedValueOnce({
          text: '',
          reasoning: undefined,
          responseMessages: [],
          toolCalls: [{ toolName: 'skip_reply', args: { reason: '候选人仅确认' } }],
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: '重跑后的真实回复',
          reasoning: undefined,
          responseMessages: [],
          usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
        });

      await service.processSingleMessage(primary);

      expect(wecomObservability.markReplySkipped).not.toHaveBeenCalled();
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      expect(deliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '重跑后的真实回复' }),
        expect.anything(),
        true,
      );
    });
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
    externalUserId: 'external-user-1',
    _apiType: 'enterprise',
    ...overrides,
  } as EnterpriseMessageCallbackDto;
}
