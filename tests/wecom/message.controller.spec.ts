import { MessageController } from '@wecom/message/message.controller';
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

describe('MessageController', () => {
  const normalizedMessage = createEnterpriseMessage();
  const mockMessageService = {
    handleMessage: jest.fn().mockResolvedValue({ success: true, message: 'Message received' }),
    handleSentResult: jest.fn().mockResolvedValue({ success: true }),
  };
  const mockCallbackAdapter = {
    detectCallbackType: jest.fn().mockReturnValue('enterprise'),
    normalizeCallback: jest.fn().mockReturnValue(normalizedMessage),
  };
  const mockMessageProcessor = {
    getWorkerStatus: jest.fn().mockReturnValue({ active: 0 }),
    setConcurrency: jest.fn().mockResolvedValue({ success: true }),
  };

  let controller: MessageController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCallbackAdapter.detectCallbackType.mockReturnValue('enterprise');
    mockCallbackAdapter.normalizeCallback.mockReturnValue(normalizedMessage);
    mockMessageService.handleMessage.mockResolvedValue({
      success: true,
      message: 'Message received',
    });
    controller = new MessageController(
      mockMessageService as never,
      mockCallbackAdapter as never,
      mockMessageProcessor as never,
    );
  });

  it('should normalize callback then forward it to message service', async () => {
    const rawBody = createEnterpriseMessage({ source: undefined as unknown as MessageSource });
    const result = await controller.receiveMessage(rawBody);

    expect(mockCallbackAdapter.detectCallbackType).toHaveBeenCalledWith(rawBody);
    expect(mockCallbackAdapter.normalizeCallback).toHaveBeenCalledWith(rawBody);
    expect(mockMessageService.handleMessage).toHaveBeenCalledWith(normalizedMessage);
    expect(result).toEqual({ success: true, message: 'Message received' });
  });

  it('should forward sent-result callback to message service', async () => {
    const result = await controller.receiveSentResult({ requestId: 'req_1' });

    expect(mockMessageService.handleSentResult).toHaveBeenCalledWith({ requestId: 'req_1' });
    expect(result).toEqual({ success: true });
  });
});
