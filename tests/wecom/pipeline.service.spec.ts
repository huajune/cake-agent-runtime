import { ConfigService } from '@nestjs/config';
import { MessagePipelineService } from '@wecom/message/services/pipeline.service';
import {
  ContactType,
  EnterpriseMessageCallbackDto,
  MessageSource,
  MessageType,
} from '@wecom/message/message-callback.dto';

function createEnterpriseMessage(
  overrides: Partial<EnterpriseMessageCallbackDto> = {},
): EnterpriseMessageCallbackDto {
  return {
    orgId: 'org_1',
    token: 'token_12345678',
    botId: 'bot_1',
    botUserId: 'Agent Test',
    imBotId: 'im_bot_1',
    chatId: 'chat_1',
    imContactId: 'contact_1',
    messageType: MessageType.TEXT,
    messageId: 'msg_1',
    timestamp: '1712044800000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: {
      text: '你好',
      pureText: '你好',
    },
    contactName: '候选人A',
    ...overrides,
  };
}

describe('MessagePipelineService', () => {
  const mockDeduplicationService = {
    isMessageProcessedAsync: jest.fn().mockResolvedValue(false),
    markMessageAsProcessedAsync: jest.fn().mockResolvedValue(undefined),
  };
  const mockChatSession = {
    saveMessage: jest.fn().mockResolvedValue(undefined),
    getChatSessionMessages: jest.fn().mockResolvedValue({ messages: [] }),
  };
  const mockFilterService = {
    validate: jest.fn().mockResolvedValue({ pass: true, content: '你好' }),
  };
  const mockDeliveryService = {};
  const mockImageDescriptionService = {
    describeAndUpdateSync: jest.fn().mockResolvedValue(undefined),
  };
  const mockWecomObservability = {
    startTrace: jest.fn(),
    markHistoryStored: jest.fn(),
    markImagePrepared: jest.fn(),
    buildFailureMetadata: jest.fn().mockReturnValue({ scenario: 'candidate-consultation' }),
  };
  const mockRunnerService = {};
  const mockConfigService = {
    get: jest.fn().mockReturnValue(''),
  } as unknown as ConfigService;
  const mockMonitoringService = {
    recordFailure: jest.fn(),
  };
  const mockAlertNotifierService = {};

  let service: MessagePipelineService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeduplicationService.isMessageProcessedAsync.mockResolvedValue(false);
    mockDeduplicationService.markMessageAsProcessedAsync.mockResolvedValue(undefined);
    mockChatSession.saveMessage.mockResolvedValue(undefined);
    mockChatSession.getChatSessionMessages.mockResolvedValue({ messages: [] });
    mockFilterService.validate.mockResolvedValue({ pass: true, content: '你好' });
    mockImageDescriptionService.describeAndUpdateSync.mockResolvedValue(undefined);
    mockWecomObservability.buildFailureMetadata.mockReturnValue({
      scenario: 'candidate-consultation',
    });

    service = new MessagePipelineService(
      mockDeduplicationService as never,
      mockChatSession as never,
      mockFilterService as never,
      mockDeliveryService as never,
      mockImageDescriptionService as never,
      mockWecomObservability as never,
      mockRunnerService as never,
      mockConfigService,
      mockMonitoringService as never,
      mockAlertNotifierService as never,
    );
  });

  it('should start trace and record user message when callback passes validation', async () => {
    const message = createEnterpriseMessage();

    const result = await service.execute(message);

    expect(result.shouldDispatch).toBe(true);
    expect(result.content).toBe('你好');
    expect(mockWecomObservability.startTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: message.messageId,
        chatId: message.chatId,
        userId: message.imContactId,
        userName: message.contactName,
        managerName: message.botUserId,
        content: '你好',
        imageCount: 0,
      }),
    );
    expect(mockChatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: message.messageId,
        role: 'user',
        content: '你好',
      }),
    );
    expect(mockWecomObservability.markHistoryStored).toHaveBeenCalledWith(message.messageId);
  });

  it('should record history only messages without entering ai dispatch trace', async () => {
    const message = createEnterpriseMessage({ groupId: 'group_1' });
    mockFilterService.validate.mockResolvedValue({
      pass: true,
      content: '你好',
      historyOnly: true,
      reason: 'GROUP_BLACKLISTED',
    });

    const result = await service.execute(message);

    expect(result.shouldDispatch).toBe(false);
    expect(result.response.message).toBe('Message recorded to history only');
    expect(mockChatSession.saveMessage).toHaveBeenCalledTimes(1);
    expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith(
      message.messageId,
    );
    expect(mockWecomObservability.startTrace).not.toHaveBeenCalled();
  });

  it('should build failure metadata when pre-dispatch history storage fails', async () => {
    const message = createEnterpriseMessage();
    const historyError = new Error('save history failed');
    mockChatSession.saveMessage.mockRejectedValueOnce(historyError);

    await expect(service.execute(message)).rejects.toThrow('save history failed');

    expect(mockWecomObservability.buildFailureMetadata).toHaveBeenCalledWith(
      message.messageId,
      expect.objectContaining({
        scenario: 'candidate-consultation',
        errorType: 'message',
        errorMessage: 'save history failed',
        isPrimary: true,
      }),
    );
    expect(mockMonitoringService.recordFailure).toHaveBeenCalledWith(
      message.messageId,
      'save history failed',
      expect.any(Object),
    );
  });
});
