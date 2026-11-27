import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { AcceptInboundMessageService } from '@wecom/message/application/accept-inbound-message.service';
import { ReplyWorkflowService } from '@wecom/message/application/reply-workflow.service';
import { PendingHostingSourceService } from '@wecom/message/application/pending-hosting-source.service';
import {
  ContactType,
  EnterpriseMessageCallbackDto,
  MessageSource,
  MessageType,
} from '@wecom/message/ingress/message-callback.dto';

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
  const mockAcceptInboundMessage = {
    execute: jest.fn(),
  };

  const mockReplyWorkflow = {
    processSingleMessage: jest.fn(),
    processMergedMessages: jest.fn(),
  };

  let service: MessagePipelineService;
  const directory = { resolve: jest.fn() };
  const pending = { restore: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    directory.resolve.mockImplementation(async (sources: unknown[]) =>
      sources.map(() => 'qa-tenant'),
    );
    pending.restore.mockResolvedValue(false);
    mockAcceptInboundMessage.execute.mockResolvedValue({
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
      content: '你好',
    });
    mockReplyWorkflow.processSingleMessage.mockResolvedValue(undefined);
    mockReplyWorkflow.processMergedMessages.mockResolvedValue(undefined);

    service = new MessagePipelineService(
      mockAcceptInboundMessage as unknown as AcceptInboundMessageService,
      mockReplyWorkflow as unknown as ReplyWorkflowService,
      directory as never,
      pending as unknown as PendingHostingSourceService,
    );
  });

  it('should delegate inbound handling to AcceptInboundMessageService', async () => {
    const message = createEnterpriseMessage();

    const result = await service.execute(message);

    expect(mockAcceptInboundMessage.execute).toHaveBeenCalledWith(message);
    expect(result).toEqual({
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
      content: '你好',
    });
  });

  it('should forward single-message processing to ReplyWorkflowService', async () => {
    const message = createEnterpriseMessage();

    await service.processSingleMessage(message);

    expect(mockReplyWorkflow.processSingleMessage).toHaveBeenCalledWith(
      message,
      expect.any(Function),
    );
  });

  it('should forward merged-message processing to ReplyWorkflowService', async () => {
    const messages = [createEnterpriseMessage(), createEnterpriseMessage({ messageId: 'msg_2' })];

    const owned = jest.fn().mockResolvedValue(undefined);
    await service.processMergedMessages(messages, 'batch_1', owned);

    expect(mockReplyWorkflow.processMergedMessages).toHaveBeenCalledWith(
      messages,
      'batch_1',
      owned,
      expect.any(Function),
    );
  });

  it('delivers a verified queued message accepted by the previous worker after first binding', async () => {
    const message = createEnterpriseMessage();
    directory.resolve
      .mockResolvedValueOnce([null, 'first-tenant'])
      .mockResolvedValueOnce(['first-tenant', 'first-tenant']);
    pending.restore.mockResolvedValue(true);
    await service.processMergedMessages([message], 'across-cutover');
    expect(pending.restore).toHaveBeenCalledWith(message);
    expect(mockReplyWorkflow.processMergedMessages).toHaveBeenCalledTimes(1);
  });

  it('preserves a conflicting source and never sends the former tenant’s queued message to the new tenant', async () => {
    directory.resolve
      .mockResolvedValueOnce([null, 'new-tenant'])
      .mockResolvedValueOnce(['old-tenant', 'new-tenant']);
    pending.restore.mockResolvedValue(true);
    await service.processMergedMessages([createEnterpriseMessage()], 'after-transfer');
    expect(mockReplyWorkflow.processMergedMessages).not.toHaveBeenCalled();
  });
});
