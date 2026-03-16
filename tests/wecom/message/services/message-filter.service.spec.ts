import { Test, TestingModule } from '@nestjs/testing';
import { MessageFilterService, FilterReason } from '@wecom/message/services/message-filter.service';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import {
  EnterpriseMessageCallbackDto,
  MessageSource,
  MessageType,
  ContactType,
} from '@wecom/message/dto/message-callback.dto';

describe('MessageFilterService', () => {
  let service: MessageFilterService;

  const mockUserHostingService = {
    isUserPaused: jest.fn(),
  };

  const mockGroupBlacklistService = {
    isGroupBlacklisted: jest.fn(),
  };

  const validMessageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-123',
    token: 'token-123',
    botId: 'bot-123',
    imBotId: 'wxid-bot-123',
    chatId: 'chat-123',
    messageType: MessageType.TEXT,
    messageId: 'msg-123',
    timestamp: '1234567890',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    imContactId: 'contact-123',
    payload: { text: 'Hello, world!' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageFilterService,
        { provide: UserHostingService, useValue: mockUserHostingService },
        { provide: GroupBlacklistService, useValue: mockGroupBlacklistService },
      ],
    }).compile();

    service = module.get<MessageFilterService>(MessageFilterService);
    jest.clearAllMocks();

    // Default: user not paused, group not blacklisted
    mockUserHostingService.isUserPaused.mockResolvedValue(false);
    mockGroupBlacklistService.isGroupBlacklisted.mockResolvedValue(false);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validate', () => {
    it('should pass valid message through all filters', async () => {
      const result = await service.validate(validMessageData);

      expect(result.pass).toBe(true);
      expect(result.content).toBe('Hello, world!');
      expect(result.reason).toBeUndefined();
    });

    it('should filter out isSelf=true messages', async () => {
      const messageData = { ...validMessageData, isSelf: true };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.SELF_MESSAGE);
    });

    it('should filter out non-mobile-push source messages', async () => {
      const messageData = {
        ...validMessageData,
        source: MessageSource.AI_REPLY,
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.INVALID_SOURCE);
      expect(result.details).toMatchObject({
        actual: MessageSource.AI_REPLY,
        expected: MessageSource.MOBILE_PUSH,
      });
    });

    it('should filter out non-personal-wechat contacts', async () => {
      const messageData = {
        ...validMessageData,
        contactType: ContactType.ENTERPRISE_WECHAT,
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.NON_PERSONAL_WECHAT);
    });

    it('should filter out paused user messages', async () => {
      mockUserHostingService.isUserPaused.mockResolvedValue(true);

      const result = await service.validate(validMessageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.USER_PAUSED);
      expect(mockUserHostingService.isUserPaused).toHaveBeenCalledWith('contact-123');
    });

    it('should use externalUserId when imContactId is not available', async () => {
      mockUserHostingService.isUserPaused.mockResolvedValue(true);
      const messageData = {
        ...validMessageData,
        imContactId: undefined,
        externalUserId: 'ext-user-123',
      };

      const result = await service.validate(messageData);

      expect(mockUserHostingService.isUserPaused).toHaveBeenCalledWith('ext-user-123');
      expect(result.reason).toBe(FilterReason.USER_PAUSED);
    });

    it('should allow message through when no userId for pause check', async () => {
      const messageData = {
        ...validMessageData,
        imContactId: undefined,
        externalUserId: undefined,
      };

      const result = await service.validate(messageData);

      expect(mockUserHostingService.isUserPaused).not.toHaveBeenCalled();
      expect(result.pass).toBe(true);
    });

    it('should return historyOnly=true for blacklisted group messages', async () => {
      mockGroupBlacklistService.isGroupBlacklisted.mockResolvedValue(true);
      const messageData = { ...validMessageData, groupId: 'blacklisted-group' };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(true);
      expect(result.historyOnly).toBe(true);
      expect(result.reason).toBe(FilterReason.GROUP_BLACKLISTED);
    });

    it('should filter out enterprise-level blocked groupId', async () => {
      const messageData = {
        ...validMessageData,
        groupId: '691d3b171535fed6bcc94f66',
        _apiType: undefined, // enterprise message (not group)
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.BLOCKED_ENTERPRISE_GROUP);
    });

    it('should NOT filter group-level messages with blocked enterprise groupId', async () => {
      const messageData = {
        ...validMessageData,
        groupId: '691d3b171535fed6bcc94f66',
        _apiType: 'group' as const,
      };

      const result = await service.validate(messageData);

      // group-level messages bypass the enterprise group filter
      expect(result.pass).toBe(true);
    });

    it('should filter out room messages', async () => {
      const messageData = {
        ...validMessageData,
        imRoomId: 'room-123',
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.ROOM_MESSAGE);
    });

    it('should filter out unsupported message types', async () => {
      const messageData = {
        ...validMessageData,
        messageType: MessageType.IMAGE,
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.UNSUPPORTED_MESSAGE_TYPE);
    });

    it('should allow location messages through', async () => {
      const messageData = {
        ...validMessageData,
        messageType: MessageType.LOCATION,
        payload: { name: 'Office', address: '123 Main St', latitude: '39.9', longitude: '116.4' },
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(true);
    });

    it('should filter out empty content messages', async () => {
      const messageData = {
        ...validMessageData,
        payload: { text: '   ' },
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.EMPTY_CONTENT);
    });

    it('should filter out messages with no payload text', async () => {
      const messageData = {
        ...validMessageData,
        payload: {},
      };

      const result = await service.validate(messageData);

      expect(result.pass).toBe(false);
      expect(result.reason).toBe(FilterReason.EMPTY_CONTENT);
    });
  });

  describe('checkMentioned', () => {
    it('should return true when bot wxid is in mention list', () => {
      const messageData = {
        ...validMessageData,
        payload: { text: '@bot hello', mention: ['bot-wxid-123'] },
      };

      const result = service.checkMentioned(messageData, 'bot-wxid-123');

      expect(result).toBe(true);
    });

    it('should return true when @all is in mention list', () => {
      const messageData = {
        ...validMessageData,
        payload: { text: '@all hello', mention: ['@all'] },
      };

      const result = service.checkMentioned(messageData, 'bot-wxid-123');

      expect(result).toBe(true);
    });

    it('should return false when bot wxid is not in mention list', () => {
      const messageData = {
        ...validMessageData,
        payload: { text: 'hello', mention: ['other-wxid'] },
      };

      const result = service.checkMentioned(messageData, 'bot-wxid-123');

      expect(result).toBe(false);
    });

    it('should return false when no mention field', () => {
      const messageData = {
        ...validMessageData,
        payload: { text: 'hello' },
      };

      const result = service.checkMentioned(messageData, 'bot-wxid-123');

      expect(result).toBe(false);
    });

    it('should return false for non-text messages', () => {
      const messageData = {
        ...validMessageData,
        messageType: MessageType.IMAGE,
        payload: { imageUrl: 'http://example.com/img.jpg', width: 100, height: 100 },
      };

      const result = service.checkMentioned(messageData, 'bot-wxid-123');

      expect(result).toBe(false);
    });

    it('should return false when mention is not an array', () => {
      const messageData = {
        ...validMessageData,
        payload: { text: 'hello', mention: 'bot-wxid-123' },
      };

      const result = service.checkMentioned(messageData, 'bot-wxid-123');

      expect(result).toBe(false);
    });
  });
});
