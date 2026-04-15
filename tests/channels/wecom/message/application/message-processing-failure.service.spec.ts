import { ScenarioType } from '@enums/agent.enum';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { MessageProcessingFailureService } from '@channels/wecom/message/application/message-processing-failure.service';
import { DeliveryFailureError } from '@channels/wecom/message/types';
import { MessageParser } from '@channels/wecom/message/utils/message-parser.util';

describe('MessageProcessingFailureService', () => {
  const configService = {
    get: jest.fn(),
  };
  const deduplicationService = {
    markMessageAsProcessedAsync: jest.fn(),
  };
  const deliveryService = {
    deliverReply: jest.fn(),
  };
  const monitoringService = {
    recordFailure: jest.fn(),
  };
  const alertService = {
    sendAlert: jest.fn(),
  };
  const wecomObservability = {
    markFallbackStart: jest.fn(),
    markFallbackEnd: jest.fn(),
    buildFailureMetadata: jest.fn(),
  };

  let service: MessageProcessingFailureService;

  beforeEach(() => {
    jest.clearAllMocks();
    configService.get.mockReturnValue('');
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValue(undefined);
    deliveryService.deliverReply.mockResolvedValue(undefined);
    alertService.sendAlert.mockResolvedValue(undefined);
    wecomObservability.markFallbackStart.mockResolvedValue(undefined);
    wecomObservability.markFallbackEnd.mockResolvedValue(undefined);
    wecomObservability.buildFailureMetadata.mockResolvedValue({ traceId: 'trace-1' });

    service = new MessageProcessingFailureService(
      configService as never,
      deduplicationService as never,
      deliveryService as never,
      monitoringService as never,
      alertService as never,
      wecomObservability as never,
    );
  });

  it('should classify agent and delivery failures explicitly', () => {
    expect(
      service.inferErrorType(
        {
          isAgentError: true,
          agentMeta: { sessionId: 'session-1' },
        },
        'message',
      ),
    ).toBe('agent');

    expect(
      service.inferErrorType(
        new DeliveryFailureError('delivery failed', {
          success: false,
          segmentCount: 2,
          failedSegments: 1,
          deliveredSegments: 0,
          totalTime: 300,
          error: 'delivery failed',
        }),
        'message',
      ),
    ).toBe('delivery');
  });

  it('should skip fallback delivery when part of the reply was already delivered', async () => {
    const error = new DeliveryFailureError('partial delivery', {
      success: false,
      segmentCount: 2,
      failedSegments: 1,
      deliveredSegments: 1,
      totalTime: 450,
      error: 'partial delivery',
    });

    await service.handleProcessingError(error, createParsedMessage(), {
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      traceId: 'trace-1',
      processedMessageIds: ['msg-1', 'msg-2'],
      dispatchMode: 'direct',
    });

    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
    expect(alertService.sendAlert).not.toHaveBeenCalled();
    expect(wecomObservability.buildFailureMetadata).toHaveBeenCalledWith(
      'trace-1',
      expect.objectContaining({
        extraResponse: expect.objectContaining({
          phase: 'delivery-partial',
        }),
      }),
    );
    expect(monitoringService.recordFailure).toHaveBeenCalledWith(
      'trace-1',
      'partial delivery',
      { traceId: 'trace-1' },
    );
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-2');
  });

  it('should route fallback alerts to the mapped receiver when bot id is known', () => {
    const botImId = '1688855974513959';

    service.sendFallbackAlert({
      contactName: '张三',
      userMessage: '在吗',
      fallbackMessage: '我确认下哈，马上回你~',
      fallbackReason: 'Agent 返回降级响应',
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      chatId: 'chat-1',
      imBotId: botImId,
    });

    expect(alertService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: {
          atUsers: [BOT_TO_RECEIVER[botImId]],
        },
      }),
    );
  });
});

function createParsedMessage(): ReturnType<typeof MessageParser.parse> {
  return {
    token: 'token-1',
    messageId: 'msg-1',
    messageType: 7,
    content: '你好',
    roomId: '',
    roomName: '',
    roomWecomChatId: '',
    isRoom: false,
    chatId: 'chat-1',
    imBotId: 'im-bot-1',
    imContactId: 'im-contact-1',
    imRoomId: '',
    botWxid: 'im-bot-1',
    botId: 'bot-1',
    orgId: 'corp-1',
    managerName: 'manager-1',
    isSelf: false,
    timestamp: 1713168000000,
    payload: {},
    contactType: 1,
    contactName: '张三',
    externalUserId: 'external-1',
    coworker: undefined,
    avatar: undefined,
    _apiType: 'enterprise',
  } as ReturnType<typeof MessageParser.parse>;
}
