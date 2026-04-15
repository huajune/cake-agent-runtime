import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { MessageCallbackAdapterService } from '@wecom/message/ingress/callback-adapter.service';
import {
  GroupMessageCallbackDto,
} from '@wecom/message/ingress/message-callback.dto';
import { MessageSource, MessageType, ContactType } from '@enums/message-callback.enum';

describe('MessageCallbackAdapterService', () => {
  let service: MessageCallbackAdapterService;

  const validGroupCallback: GroupMessageCallbackDto = {
    messageId: 'grp-msg-123',
    chatId: 'chat-123',
    contactName: 'Alice',
    contactId: 'contact-id-123',
    payload: { text: 'Hello from group level!' },
    type: MessageType.TEXT,
    timestamp: 1700000000000,
    token: 'grp-token-abcdefgh',
    contactType: ContactType.PERSONAL_WECHAT,
    botId: 'bot-123',
    botWxid: 'wxid-bot-123',
    isSelf: false,
  };

  const validEnterpriseBody = {
    orgId: 'org-123',
    token: 'ent-token-123',
    botId: 'bot-123',
    imBotId: 'wxid-bot-123',
    chatId: 'chat-123',
    messageType: MessageType.TEXT,
    messageId: 'msg-123',
    timestamp: '1234567890',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: { text: 'Hello enterprise!' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageCallbackAdapterService],
    }).compile();

    service = module.get<MessageCallbackAdapterService>(MessageCallbackAdapterService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('detectCallbackType', () => {
    it('should detect enterprise callback type', () => {
      const result = service.detectCallbackType(validEnterpriseBody);
      expect(result).toBe('enterprise');
    });

    it('should detect group callback type', () => {
      const groupWrapper = { data: validGroupCallback };
      const result = service.detectCallbackType(groupWrapper);
      expect(result).toBe('group');
    });

    it('should return unknown for unrecognized format', () => {
      const result = service.detectCallbackType({ someRandomField: 'value' });
      expect(result).toBe('unknown');
    });

    it('should detect enterprise when orgId and messageType are present', () => {
      const body = { orgId: 'org-123', messageType: 7 };
      expect(service.detectCallbackType(body)).toBe('enterprise');
    });

    it('should detect group when data.type and data.messageId are present', () => {
      const body = { data: { type: 7, messageId: 'msg-123' } };
      expect(service.detectCallbackType(body)).toBe('group');
    });
  });

  describe('convertGroupToEnterprise', () => {
    it('should map group fields to enterprise fields correctly', () => {
      const result = service.convertGroupToEnterprise(validGroupCallback);

      expect(result.messageType).toBe(MessageType.TEXT);
      expect(result.imContactId).toBe('contact-id-123');
      expect(result.imBotId).toBe('wxid-bot-123');
      expect(result.messageId).toBe('grp-msg-123');
      expect(result.chatId).toBe('chat-123');
      expect(result.token).toBe('grp-token-abcdefgh');
      expect(result.botId).toBe('bot-123');
      expect(result.contactType).toBe(ContactType.PERSONAL_WECHAT);
    });

    it('should convert timestamp from number to string', () => {
      const result = service.convertGroupToEnterprise(validGroupCallback);
      expect(result.timestamp).toBe('1700000000000');
    });

    it('should set _apiType to group', () => {
      const result = service.convertGroupToEnterprise(validGroupCallback);
      expect(result._apiType).toBe('group');
    });

    it('should set orgId to group_callback_org placeholder', () => {
      const result = service.convertGroupToEnterprise(validGroupCallback);
      expect(result.orgId).toBe('group_callback_org');
    });

    it('should infer source as MOBILE_PUSH for user messages (isSelf=false)', () => {
      const result = service.convertGroupToEnterprise(validGroupCallback);
      expect(result.source).toBe(MessageSource.MOBILE_PUSH);
    });

    it('should infer source as AGGREGATED_CHAT_MANUAL for self messages (isSelf=true)', () => {
      const selfGroupCallback = { ...validGroupCallback, isSelf: true };
      const result = service.convertGroupToEnterprise(selfGroupCallback);
      expect(result.source).toBe(MessageSource.AGGREGATED_CHAT_MANUAL);
    });

    it('should map room fields for group chat messages', () => {
      const roomGroupCallback = {
        ...validGroupCallback,
        roomId: 'room-123',
        roomTopic: 'Team Chat',
        roomWecomChatId: 'wecom-chat-123',
      };

      const result = service.convertGroupToEnterprise(roomGroupCallback);

      expect(result.imRoomId).toBe('room-123');
      expect(result.roomName).toBe('Team Chat');
      expect(result.roomWecomChatId).toBe('wecom-chat-123');
    });

    it('should map botWeixin to botUserId', () => {
      const callbackWithBotWeixin = { ...validGroupCallback, botWeixin: 'bot-weixin-id' };
      const result = service.convertGroupToEnterprise(callbackWithBotWeixin);
      expect(result.botUserId).toBe('bot-weixin-id');
    });
  });

  describe('normalizeCallback', () => {
    it('should pass through enterprise callback with existing source', () => {
      const result = service.normalizeCallback(validEnterpriseBody);

      expect(result.orgId).toBe('org-123');
      expect(result.source).toBe(MessageSource.MOBILE_PUSH);
      expect(result._apiType).toBeUndefined();
    });

    it('should infer source for enterprise callback missing source field', () => {
      const bodyWithoutSource = {
        ...validEnterpriseBody,
        source: undefined,
      };

      const result = service.normalizeCallback(bodyWithoutSource);

      // isSelf=false → MOBILE_PUSH
      expect(result.source).toBe(MessageSource.MOBILE_PUSH);
    });

    it('should infer AGGREGATED_CHAT_MANUAL for enterprise callback with isSelf=true and no source', () => {
      const selfBodyWithoutSource = {
        ...validEnterpriseBody,
        source: undefined,
        isSelf: true,
      };

      const result = service.normalizeCallback(selfBodyWithoutSource);

      expect(result.source).toBe(MessageSource.AGGREGATED_CHAT_MANUAL);
    });

    it('should convert group callback to enterprise format', () => {
      const groupWrapper = { data: validGroupCallback };

      const result = service.normalizeCallback(groupWrapper);

      expect(result._apiType).toBe('group');
      expect(result.messageType).toBe(MessageType.TEXT);
    });

    it('should reject unknown callback format', () => {
      const unknownBody = { someField: 'value' };

      expect(() => service.normalizeCallback(unknownBody)).toThrow(HttpException);
    });

    it('should reject invalid enterprise callback payloads', () => {
      const invalidEnterpriseBody = {
        ...validEnterpriseBody,
        payload: 'not-an-object',
      };

      expect(() => service.normalizeCallback(invalidEnterpriseBody)).toThrow(HttpException);
    });

    it('should reject invalid group callback payloads', () => {
      const invalidGroupWrapper = {
        data: {
          ...validGroupCallback,
          timestamp: '1700000000000',
        },
      };

      expect(() => service.normalizeCallback(invalidGroupWrapper)).toThrow(HttpException);
    });
  });
});
