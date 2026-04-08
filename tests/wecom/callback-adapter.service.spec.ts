import { HttpException, HttpStatus } from '@nestjs/common';
import { MessageCallbackAdapterService } from '@wecom/message/services/callback-adapter.service';
import {
  ContactType,
  MessageSource,
  MessageType,
} from '@wecom/message/message-callback.dto';

describe('MessageCallbackAdapterService', () => {
  let service: MessageCallbackAdapterService;

  beforeEach(() => {
    service = new MessageCallbackAdapterService();
  });

  it('should normalize enterprise callback and infer source when it is missing', () => {
    const normalized = service.normalizeCallback({
      orgId: 'org_1',
      token: 'token_12345678',
      botId: 'bot_1',
      botUserId: 'Agent Test',
      imBotId: 'im_bot_1',
      chatId: 'chat_1',
      imContactId: 'contact_1',
      messageType: MessageType.TEXT,
      messageId: 'msg_enterprise_1',
      timestamp: '1712044800000',
      contactType: ContactType.PERSONAL_WECHAT,
      payload: {
        text: '你好',
        pureText: '你好',
      },
      isSelf: false,
      contactName: '候选人A',
    });

    expect(normalized.messageId).toBe('msg_enterprise_1');
    expect(normalized.source).toBe(MessageSource.MOBILE_PUSH);
    expect(normalized._apiType).toBeUndefined();
  });

  it('should convert group callback into enterprise callback with group api marker', () => {
    const normalized = service.normalizeCallback({
      data: {
        messageId: 'msg_group_1',
        chatId: 'chat_group_1',
        avatar: 'https://example.com/avatar.png',
        contactName: '候选人B',
        contactId: 'contact_group_1',
        payload: {
          text: '在吗',
          pureText: '在吗',
        },
        type: MessageType.TEXT,
        timestamp: 1712044800000,
        token: 'group_token_12345678',
        contactType: ContactType.PERSONAL_WECHAT,
        botId: 'bot_group_1',
        botWxid: 'im_bot_group_1',
        botWeixin: 'Recruiter',
        isSelf: true,
      },
    });

    expect(normalized.orgId).toBe('group_callback_org');
    expect(normalized.messageType).toBe(MessageType.TEXT);
    expect(normalized.imContactId).toBe('contact_group_1');
    expect(normalized.imBotId).toBe('im_bot_group_1');
    expect(normalized._apiType).toBe('group');
    expect(normalized.source).toBe(MessageSource.AGGREGATED_CHAT_MANUAL);
  });

  it('should reject invalid callback payloads with bad request', () => {
    try {
      service.normalizeCallback({ foo: 'bar' });
      fail('expected normalizeCallback to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});
