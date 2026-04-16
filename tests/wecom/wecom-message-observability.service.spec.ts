import { ScenarioType } from '@enums/agent.enum';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';
import {
  StorageContactType,
  StorageMessageSource,
  StorageMessageType,
} from '@wecom/message/types';

describe('WecomMessageObservabilityService', () => {
  const mockTrackingService = {
    recordMessageReceived: jest.fn(),
    recordWorkerStart: jest.fn(),
    recordAiStart: jest.fn(),
    recordAiEnd: jest.fn(),
  };

  const traceState = new Map<string, unknown>();
  const mockTraceStore = {
    get: jest.fn(async (messageId: string) => traceState.get(messageId)),
    set: jest.fn(async (messageId: string, trace: unknown) => {
      traceState.set(messageId, trace);
    }),
    delete: jest.fn(async (messageId: string) => {
      traceState.delete(messageId);
    }),
  };

  let service: WecomMessageObservabilityService;

  beforeEach(() => {
    jest.clearAllMocks();
    traceState.clear();
    service = new WecomMessageObservabilityService(
      mockTrackingService as never,
      mockTraceStore as never,
    );
  });

  it('should build structured success metadata for primary message', async () => {
    const messageId = 'msg_primary_1';
    await service.startTrace({
      messageId,
      chatId: 'chat_1',
      userId: 'contact_1',
      userName: '候选人A',
      managerName: 'Agent Test',
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      content: '你好',
      imageCount: 0,
      messageType: StorageMessageType.TEXT,
      messageSource: StorageMessageSource.MOBILE_PUSH,
      contactType: StorageContactType.PERSONAL_WECHAT,
    });
    await service.markWorkerStart(messageId);
    await service.markAiStart(messageId);
    await service.recordAgentResult(messageId, {
      reply: {
        content: '已帮你安排面试',
        usage: {
          inputTokens: 128,
          outputTokens: 256,
          totalTokens: 384,
        },
      },
      isFallback: false,
      processingTime: 920,
      toolCalls: [
        {
          toolName: 'book_interview',
          args: { time: '2026-04-03 15:00:00' },
          result: { success: true },
        },
      ],
    });
    await service.markAiEnd(messageId);
    await service.markDeliveryStart(messageId);
    await service.markDeliveryEnd(messageId, {
      success: true,
      segmentCount: 1,
      failedSegments: 0,
      deliveredSegments: 1,
      totalTime: 180,
    });

    const metadata = await service.buildSuccessMetadata(messageId, {
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      replySegments: 1,
      replyPreview: '已帮你安排面试',
    });

    expect(metadata.tokenUsage).toBe(384);
    expect(metadata.tools).toEqual(['book_interview']);
    expect(metadata.agentInvocation).toBeDefined();
    expect(metadata.agentInvocation?.response?.timings?.durations?.totalMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(metadata.agentInvocation?.response?.delivery).toEqual(
      expect.objectContaining({
        success: true,
        segmentCount: 1,
      }),
    );
    await expect(service.hasTrace(messageId)).resolves.toBe(false);
  });

  it('should keep batch-level invocation metadata for merged request traces', async () => {
    const messageId = 'batch_1';
    const acceptedAt = 1710000000000;
    const clock = jest.spyOn(Date, 'now');
    try {
      await service.startRequestTrace({
        traceId: messageId,
        primaryMessage: {
          orgId: 'org_1',
          token: 'token_1',
          botId: 'bot_1',
          imBotId: 'im_bot_1',
          chatId: 'chat_2',
          messageType: 7,
          messageId: 'msg_b',
          timestamp: String(acceptedAt + 1500),
          isSelf: false,
          source: 0,
          contactType: 1,
          payload: { text: '还有别的岗位吗' },
          imContactId: 'contact_2',
          contactName: '候选人B',
          botUserId: 'Agent Test',
          _receivedAtMs: acceptedAt + 1500,
        } as never,
        scenario: ScenarioType.CANDIDATE_CONSULTATION,
        content: '还有别的岗位吗',
        batchId: 'batch_1',
        mergeWindowMs: 2000,
        allMessages: [
          {
            orgId: 'org_1',
            token: 'token_1',
            botId: 'bot_1',
            imBotId: 'im_bot_1',
            chatId: 'chat_2',
            messageType: 7,
            messageId: 'msg_a',
            timestamp: String(acceptedAt),
            isSelf: false,
            source: 0,
            contactType: 1,
            payload: { text: '你好' },
            imContactId: 'contact_2',
            contactName: '候选人B',
            botUserId: 'Agent Test',
            _receivedAtMs: acceptedAt,
          },
          {
            orgId: 'org_1',
            token: 'token_1',
            botId: 'bot_1',
            imBotId: 'im_bot_1',
            chatId: 'chat_2',
            messageType: 7,
            messageId: 'msg_b',
            timestamp: String(acceptedAt + 1500),
            isSelf: false,
            source: 0,
            contactType: 1,
            payload: { text: '还有别的岗位吗' },
            imContactId: 'contact_2',
            contactName: '候选人B',
            botUserId: 'Agent Test',
            _receivedAtMs: acceptedAt + 1500,
          },
        ] as never,
      });
      clock.mockReturnValue(acceptedAt + 4200);
      await service.markWorkerStart(messageId);
      clock.mockReturnValue(acceptedAt + 4300);

      const metadata = await service.buildSuccessMetadata(messageId, {
        scenario: ScenarioType.CANDIDATE_CONSULTATION,
        batchId: 'batch_1',
        extraResponse: {
          phase: 'merged-request',
        },
      });

      expect(metadata.batchId).toBe('batch_1');
      expect(metadata.agentInvocation).toBeDefined();
      expect(metadata.agentInvocation?.request?.sourceMessageIds).toEqual(['msg_a', 'msg_b']);
      expect(metadata.agentInvocation?.request?.sourceMessageCount).toBe(2);
      expect(metadata.agentInvocation?.response?.timings?.durations?.quietWindowWaitMs).toBe(
        3500,
      );
      expect(metadata.agentInvocation?.response?.timings?.durations?.queueWaitMs).toBe(700);
    } finally {
      clock.mockRestore();
    }
  });
});
