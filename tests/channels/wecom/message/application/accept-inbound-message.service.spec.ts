import { AcceptInboundMessageService } from '@channels/wecom/message/application/accept-inbound-message.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { EnterpriseMessageCallbackDto } from '@channels/wecom/message/ingress/message-callback.dto';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';
import { FilterReason } from '@enums/message-filter.enum';

describe('AcceptInboundMessageService', () => {
  const deduplicationService = {
    markMessageAsProcessedAsync: jest.fn(),
    isMessageProcessedAsync: jest.fn(),
  };
  const chatSession = {
    saveMessage: jest.fn(),
    getChatSessionMessages: jest.fn(),
  };
  const filterService = {
    validate: jest.fn(),
  };
  const imageDescription = {
    describeAndUpdateSync: jest.fn(),
  };
  const wecomObservability = {
    markHistoryStored: jest.fn(),
    hasTrace: jest.fn(),
    startRequestTrace: jest.fn(),
    buildFailureMetadata: jest.fn(),
    markImagePrepared: jest.fn(),
  };
  const monitoringService = {
    recordFailure: jest.fn(),
  };
  const runtimeConfig = {
    resolveWecomChatModelSelection: jest.fn(),
  };
  const llm = {
    supportsVisionInput: jest.fn(),
  };

  let service: AcceptInboundMessageService;

  beforeEach(() => {
    jest.clearAllMocks();
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValue(undefined);
    deduplicationService.isMessageProcessedAsync.mockResolvedValue(false);
    chatSession.saveMessage.mockResolvedValue(undefined);
    chatSession.getChatSessionMessages.mockResolvedValue({
      messages: [{ role: 'user', candidateName: '候选人A' }],
    });
    filterService.validate.mockResolvedValue({ pass: true, content: '你好' });
    wecomObservability.hasTrace.mockResolvedValue(false);
    wecomObservability.startRequestTrace.mockResolvedValue(undefined);
    wecomObservability.markHistoryStored.mockResolvedValue(undefined);
    wecomObservability.buildFailureMetadata.mockResolvedValue({ traceId: 'msg-1' });
    wecomObservability.markImagePrepared.mockResolvedValue(undefined);
    runtimeConfig.resolveWecomChatModelSelection.mockResolvedValue({
      overrideModelId: 'gpt-test',
    });
    llm.supportsVisionInput.mockReturnValue(true);
    service = new AcceptInboundMessageService(
      deduplicationService as never,
      chatSession as never,
      filterService as never,
      imageDescription as never,
      wecomObservability as never,
      monitoringService as never,
      runtimeConfig as never,
      llm as never,
    );
  });

  it('should store self messages as assistant history and skip dispatch', async () => {
    const message = createMessage({
      isSelf: true,
      messageId: 'msg-self',
      payload: {
        text: '我先帮你确认一下',
        pureText: '我先帮你确认一下',
      },
    });

    await expect(service.execute(message)).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Self message stored' },
    });
    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        candidateName: '候选人A',
        content: '我先帮你确认一下',
      }),
    );
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-self');
    expect(filterService.validate).not.toHaveBeenCalled();
  });

  it('should record paused-user messages to history only', async () => {
    filterService.validate.mockResolvedValueOnce({
      pass: true,
      content: '候选人发来消息',
      historyOnly: true,
      reason: FilterReason.USER_PAUSED,
    });

    await expect(service.execute(createMessage())).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Message recorded to history only' },
    });
    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: '候选人发来消息',
      }),
    );
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
  });

  it('should ignore duplicate inbound messages before dispatching', async () => {
    deduplicationService.isMessageProcessedAsync.mockResolvedValueOnce(true);

    await expect(service.execute(createMessage())).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Duplicate message ignored' },
    });
    expect(chatSession.saveMessage).not.toHaveBeenCalled();
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
