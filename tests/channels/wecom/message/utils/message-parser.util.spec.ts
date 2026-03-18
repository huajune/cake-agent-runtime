import { MessageParser } from '@wecom/message/utils/message-parser.util';
import {
  EnterpriseMessageCallbackDto,
  MessageType,
  ContactType,
  MessageSource,
  LocationPayload,
} from '@enums/message-callback.enum';
import { ScenarioType } from '@enums/agent.enum';

describe('MessageParser', () => {
  const buildMessageData = (
    overrides: Partial<EnterpriseMessageCallbackDto> = {},
  ): EnterpriseMessageCallbackDto => {
    const base: EnterpriseMessageCallbackDto = {
      orgId: 'org_001',
      token: 'tok_abc123',
      botId: 'bot_001',
      imBotId: 'wxid_bot',
      chatId: 'chat_001',
      messageType: MessageType.TEXT,
      messageId: 'msg_001',
      timestamp: '1700000000000',
      isSelf: false,
      source: MessageSource.MOBILE_PUSH,
      contactType: ContactType.PERSONAL_WECHAT,
      payload: { text: 'hello', pureText: 'hello world' },
    };
    return { ...base, ...overrides };
  };

  describe('parse', () => {
    it('should parse a text message correctly', () => {
      const messageData = buildMessageData();
      const result = MessageParser.parse(messageData);

      expect(result.token).toBe('tok_abc123');
      expect(result.messageId).toBe('msg_001');
      expect(result.messageType).toBe(MessageType.TEXT);
      expect(result.content).toBe('hello world'); // pureText takes priority
      expect(result.isRoom).toBe(false);
      expect(result.chatId).toBe('chat_001');
      expect(result.imBotId).toBe('wxid_bot');
      expect(result.botId).toBe('bot_001');
      expect(result.isSelf).toBe(false);
      expect(result.timestamp).toBe(1700000000000);
    });

    it('should use pureText over text when pureText is present', () => {
      const messageData = buildMessageData({
        payload: { text: 'hello @bot', pureText: 'hello' },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('hello');
    });

    it('should fall back to text when pureText is empty', () => {
      const messageData = buildMessageData({
        payload: { text: 'hello world', pureText: '' },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('hello world');
    });

    it('should return empty content for non-text messages', () => {
      const messageData = buildMessageData({
        messageType: MessageType.IMAGE,
        payload: { imageUrl: 'http://example.com/img.jpg', width: 100, height: 100 },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('');
    });

    it('should set isRoom to true when imRoomId is present', () => {
      const messageData = buildMessageData({ imRoomId: 'room_001' });
      const result = MessageParser.parse(messageData);
      expect(result.isRoom).toBe(true);
    });

    it('should set isRoom to false when imRoomId is absent', () => {
      const messageData = buildMessageData({ imRoomId: undefined });
      const result = MessageParser.parse(messageData);
      expect(result.isRoom).toBe(false);
    });

    it('should set imContactId for private chat (non-room)', () => {
      const messageData = buildMessageData({
        imContactId: 'contact_001',
        imRoomId: undefined,
      });
      const result = MessageParser.parse(messageData);
      expect(result.imContactId).toBe('contact_001');
    });

    it('should set imContactId to undefined for room messages', () => {
      const messageData = buildMessageData({
        imContactId: 'contact_001',
        imRoomId: 'room_001',
      });
      const result = MessageParser.parse(messageData);
      expect(result.imContactId).toBeUndefined();
    });

    it('should propagate roomId, roomName, roomWecomChatId for room messages', () => {
      const messageData = buildMessageData({
        imRoomId: 'room_001',
        roomName: 'Test Group',
        roomWecomChatId: 'wecom_chat_001',
      });
      const result = MessageParser.parse(messageData);
      expect(result.roomId).toBe('room_001');
      expect(result.roomName).toBe('Test Group');
      expect(result.roomWecomChatId).toBe('wecom_chat_001');
    });

    it('should set managerName from botUserId', () => {
      const messageData = buildMessageData({ botUserId: 'Manager Zhang' });
      const result = MessageParser.parse(messageData);
      expect(result.managerName).toBe('Manager Zhang');
    });

    it('should convert timestamp string to number', () => {
      const messageData = buildMessageData({ timestamp: '1700000000000' });
      const result = MessageParser.parse(messageData);
      expect(result.timestamp).toBe(1700000000000);
      expect(typeof result.timestamp).toBe('number');
    });

    it('should propagate _apiType field', () => {
      const messageData = buildMessageData({ _apiType: 'enterprise' });
      const result = MessageParser.parse(messageData);
      expect(result._apiType).toBe('enterprise');
    });

    it('should propagate contactType and contactName', () => {
      const messageData = buildMessageData({
        contactType: ContactType.ENTERPRISE_WECHAT,
        contactName: 'Test User',
      });
      const result = MessageParser.parse(messageData);
      expect(result.contactType).toBe(ContactType.ENTERPRISE_WECHAT);
      expect(result.contactName).toBe('Test User');
    });

    it('should set botWxid as an alias of imBotId', () => {
      const messageData = buildMessageData({ imBotId: 'wxid_bot_123' });
      const result = MessageParser.parse(messageData);
      expect(result.botWxid).toBe('wxid_bot_123');
      expect(result.imBotId).toBe('wxid_bot_123');
    });
  });

  describe('extractContent', () => {
    it('should extract pureText from text message', () => {
      const messageData = buildMessageData({
        messageType: MessageType.TEXT,
        payload: { text: 'raw text', pureText: 'pure text' },
      });
      const result = MessageParser.extractContent(messageData);
      expect(result).toBe('pure text');
    });

    it('should extract text when pureText is absent', () => {
      const messageData = buildMessageData({
        messageType: MessageType.TEXT,
        payload: { text: 'raw text' },
      });
      const result = MessageParser.extractContent(messageData);
      expect(result).toBe('raw text');
    });

    it('should format location message as text', () => {
      const messageData = buildMessageData({
        messageType: MessageType.LOCATION,
        payload: {
          name: '上海东方明珠',
          address: '上海市浦东新区世纪大道1号',
          latitude: '31.2397',
          longitude: '121.4996',
        },
      });
      const result = MessageParser.extractContent(messageData);
      expect(result).toBe('[位置分享] 上海东方明珠（上海市浦东新区世纪大道1号）');
    });

    it('should return empty string for non-text, non-location messages', () => {
      const messageData = buildMessageData({
        messageType: MessageType.IMAGE,
        payload: { imageUrl: 'http://example.com/img.jpg', width: 100, height: 100 },
      });
      const result = MessageParser.extractContent(messageData);
      expect(result).toBe('');
    });
  });

  describe('formatLocationAsText', () => {
    it('should show only address when name equals address', () => {
      const payload: LocationPayload = {
        name: '上海市',
        address: '上海市',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 上海市');
    });

    it('should show name and address in parentheses when both are different', () => {
      const payload: LocationPayload = {
        name: '东方明珠',
        address: '浦东新区世纪大道1号',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 东方明珠（浦东新区世纪大道1号）');
    });

    it('should show only address when name is empty', () => {
      const payload: LocationPayload = {
        name: '',
        address: '浦东新区世纪大道1号',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 浦东新区世纪大道1号');
    });

    it('should show only name when address is empty', () => {
      const payload: LocationPayload = {
        name: '东方明珠',
        address: '',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 东方明珠');
    });

    it('should handle when both name and address are empty strings', () => {
      // Empty strings are falsy in JS so we need undefined/null to hit the fallback
      const payload: LocationPayload = {
        name: '',
        address: '',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      // Both are empty strings - neither "name === address" branch triggers '未知位置'
      // (empty === empty is true), so it returns '[位置分享] ' with empty address
      expect(result).toBe('[位置分享] ');
    });
  });

  describe('determineScenario', () => {
    it('should always return CANDIDATE_CONSULTATION', () => {
      const result = MessageParser.determineScenario();
      expect(result).toBe(ScenarioType.CANDIDATE_CONSULTATION);
    });

    it('should return CANDIDATE_CONSULTATION regardless of message data', () => {
      const messageData = buildMessageData();
      const result = MessageParser.determineScenario(messageData);
      expect(result).toBe(ScenarioType.CANDIDATE_CONSULTATION);
    });
  });

  describe('formatCurrentTime', () => {
    it('should return a formatted time string', () => {
      const result = MessageParser.formatCurrentTime();
      // Should match format like "2025-01-15 14:30 星期三"
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} .+$/);
    });

    it('should include weekday in Chinese', () => {
      const result = MessageParser.formatCurrentTime();
      const weekdays = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
      const hasWeekday = weekdays.some((day) => result.includes(day));
      expect(hasWeekday).toBe(true);
    });

    it('should format a specific timestamp correctly', () => {
      // 2025-01-01 00:00:00 UTC = 2025-01-01 08:00:00 Beijing time (Wednesday)
      const timestamp = new Date('2025-01-01T00:00:00Z').getTime();
      const result = MessageParser.formatCurrentTime(timestamp);
      expect(result).toContain('2025');
      expect(result).toContain('01');
    });

    it('should use current time when no timestamp is provided', () => {
      const before = Date.now();
      const result = MessageParser.formatCurrentTime();
      const after = Date.now();

      // Extract year from result
      const yearMatch = result.match(/^(\d{4})-/);
      expect(yearMatch).not.toBeNull();
      const year = parseInt(yearMatch![1]);

      // Year should be current year
      const currentYear = new Date(before).getFullYear();
      const afterYear = new Date(after).getFullYear();
      expect(year).toBeGreaterThanOrEqual(currentYear);
      expect(year).toBeLessThanOrEqual(afterYear);
    });
  });

  describe('injectTimeContext', () => {
    it('should append time context to message content', () => {
      const content = '你好，我想找工作';
      const result = MessageParser.injectTimeContext(content);
      expect(result).toContain(content);
      expect(result).toContain('[消息发送时间：');
    });

    it('should inject time from provided timestamp', () => {
      const content = '你好';
      const timestamp = new Date('2025-06-15T08:00:00Z').getTime();
      const result = MessageParser.injectTimeContext(content, timestamp);
      expect(result).toMatch(/^你好\n\[消息发送时间：/);
      expect(result).toContain('2025');
    });

    it('should use newline separator between content and time', () => {
      const content = '测试消息';
      const result = MessageParser.injectTimeContext(content, Date.now());
      expect(result.split('\n')[0]).toBe('测试消息');
      expect(result.split('\n')[1]).toMatch(/^\[消息发送时间：/);
    });

    it('should handle empty content', () => {
      const result = MessageParser.injectTimeContext('');
      expect(result).toMatch(/^\n\[消息发送时间：/);
    });
  });
});
