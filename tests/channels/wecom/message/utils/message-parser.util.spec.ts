import {
  MessageParser,
  isResumeImageDescription,
  stripResumeAttachmentLines,
} from '@wecom/message/utils/message-parser.util';
import {
  EnterpriseMessageCallbackDto,
  LocationPayload,
} from '@wecom/message/ingress/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
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

    it('should prepend quoteMessage as a [引用 X：Y] line when payload carries one', () => {
      const messageData = buildMessageData({
        payload: {
          text: '这个是每天吗，几点',
          pureText: '这个是每天吗，几点',
          quoteMessage: {
            messageId: 'cff1dabe51d82bfc7f4fd66c4aff9150',
            wxid: '1688855171908166',
            nickname: '李宇杭',
            type: '7',
            timestamp: '1777275510346',
            content: { text: '奥乐齐红松店（晚班补货）：离你3.3km，18-45岁，负责上货补货。' },
          },
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe(
        '[引用 李宇杭：奥乐齐红松店（晚班补货）：离你3.3km，18-45岁，负责上货补货。]\n这个是每天吗，几点',
      );
    });

    it('should fall back to placeholder when quoted message is non-text', () => {
      const messageData = buildMessageData({
        payload: {
          text: '看这张',
          pureText: '看这张',
          quoteMessage: {
            messageId: 'm-1',
            wxid: 'w-1',
            nickname: '招募经理',
            type: '6',
            timestamp: '1777275510346',
            content: { url: 'http://example.com/img.jpg' },
          },
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[引用 招募经理：[图片消息]]\n看这张');
    });

    it('should ignore quoteMessage when its content has no readable text', () => {
      const messageData = buildMessageData({
        payload: {
          text: 'hello',
          pureText: 'hello',
          quoteMessage: {
            messageId: 'm-2',
            wxid: 'w-2',
            nickname: '某人',
            type: '999',
            timestamp: '1777275510346',
            content: {},
          },
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('hello');
    });

    it('should extract content for image messages (group-level: url)', () => {
      const messageData = buildMessageData({
        messageType: MessageType.IMAGE,
        payload: { url: 'http://example.com/img.jpg', size: 1024 },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[图片消息]');
    });

    it('should extract content for image messages (enterprise-level: imageUrl)', () => {
      const messageData = buildMessageData({
        messageType: MessageType.IMAGE,
        payload: { imageUrl: 'http://example.com/img.jpg', size: 1024, width: 118, height: 210 },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[图片消息]');
    });

    it('should expose fileUrl as a resume attachment when the file name looks like a resume', () => {
      const messageData = buildMessageData({
        messageType: MessageType.FILE,
        payload: {
          name: '张三简历.pdf',
          fileUrl: 'https://example.com/resume.pdf',
          size: 2048,
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe(
        '[文件消息] 文件名：张三简历.pdf；文件地址：https://example.com/resume.pdf；文件大小：2KB\n简历附件：https://example.com/resume.pdf',
      );
    });

    it('should not treat every PDF file as a resume attachment', () => {
      const messageData = buildMessageData({
        messageType: MessageType.FILE,
        payload: {
          name: '入职材料.pdf',
          fileUrl: 'https://example.com/onboarding.pdf',
          size: 2048,
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe(
        '[文件消息] 文件名：入职材料.pdf；文件地址：https://example.com/onboarding.pdf；文件大小：2KB',
      );
    });

    it('should extract content for voice messages (group-level: url, no STT)', () => {
      const messageData = buildMessageData({
        messageType: MessageType.VOICE,
        payload: { url: 'http://example.com/voice.mp3', duration: 15 },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[语音消息] 时长15秒');
    });

    it('should extract content for voice messages (enterprise-level: voiceUrl + STT)', () => {
      const messageData = buildMessageData({
        messageType: MessageType.VOICE,
        payload: {
          voiceUrl: 'http://example.com/voice.mp3',
          duration: 2.268,
          text: '分析跟调整那。',
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[语音转文字，时长2秒] 分析跟调整那。');
    });

    it('should extract content for emotion messages', () => {
      const messageData = buildMessageData({
        messageType: MessageType.EMOTION,
        payload: { imageUrl: 'http://example.com/emoji.gif' },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[表情消息]');
    });

    it('should extract content for mini program messages', () => {
      const messageData = buildMessageData({
        messageType: MessageType.MINI_PROGRAM,
        payload: {
          appId: 'wx123',
          username: 'gh_xxx',
          title: 'Boss直聘',
          thumbUrl: 'http://thumb.jpg',
          description: '查看岗位',
        },
      });
      const result = MessageParser.parse(messageData);
      expect(result.content).toBe('[小程序] Boss直聘 - 查看岗位');
    });

    it('should return empty content for unsupported message types', () => {
      const messageData = buildMessageData({
        messageType: MessageType.VIDEO,
        payload: { videoUrl: 'http://example.com/video.mp4', duration: 30 },
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
      expect(result).toBe(
        '[位置分享] 上海东方明珠（上海市浦东新区世纪大道1号） [经纬度:31.2397,121.4996]',
      );
    });

    it('should return empty string for unsupported message types', () => {
      const messageData = buildMessageData({
        messageType: MessageType.VIDEO,
        payload: { videoUrl: 'http://example.com/video.mp4', duration: 30 },
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
      expect(result).toBe('[位置分享] 上海市 [经纬度:31.2,121.4]');
    });

    it('should show name and address in parentheses when both are different', () => {
      const payload: LocationPayload = {
        name: '东方明珠',
        address: '浦东新区世纪大道1号',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 东方明珠（浦东新区世纪大道1号） [经纬度:31.2,121.4]');
    });

    it('should show only address when name is empty', () => {
      const payload: LocationPayload = {
        name: '',
        address: '浦东新区世纪大道1号',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 浦东新区世纪大道1号 [经纬度:31.2,121.4]');
    });

    it('should show only name when address is empty', () => {
      const payload: LocationPayload = {
        name: '东方明珠',
        address: '',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      expect(result).toBe('[位置分享] 东方明珠 [经纬度:31.2,121.4]');
    });

    it('should handle when both name and address are empty strings', () => {
      const payload: LocationPayload = {
        name: '',
        address: '',
        latitude: '31.2',
        longitude: '121.4',
      };
      const result = MessageParser.formatLocationAsText(payload);
      // Both name and address empty → '未知位置', but coords still appended
      expect(result).toBe('[位置分享] 未知位置 [经纬度:31.2,121.4]');
    });
  });

  describe('determineScenario', () => {
    it('should always return CANDIDATE_CONSULTATION', () => {
      const result = MessageParser.determineScenario();
      expect(result).toBe(ScenarioType.CANDIDATE_CONSULTATION);
    });

    it('should return CANDIDATE_CONSULTATION regardless of message data', () => {
      const result = MessageParser.determineScenario();
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

describe('isResumeImageDescription', () => {
  it.each([
    '简历图片：姓名陆乐，手机号13962387831，籍贯启东',
    '手写简历，包含姓名陆乐、手机号、工作经历比业迪/中国移动',
    '简历照片，字迹清晰可见姓名与电话',
    '履历表照片：包含个人信息与工作经历',
    '「简历图片」姓名张三',
  ])('should identify resume-image description: %s', (description) => {
    expect(isResumeImageDescription(description)).toBe(true);
  });

  it.each([
    'Boss直聘简历列表截图，展示多个候选岗位',
    '招聘平台截图，岗位为服务员，要求提交简历',
    '聊天截图，对方提到稍后发简历',
    '健康证照片：持有人张三，有效期至2026-08-01',
    '思考',
  ])('should not identify non-resume description: %s', (description) => {
    expect(isResumeImageDescription(description)).toBe(false);
  });
});

describe('stripResumeAttachmentLines', () => {
  it('removes an embedded 简历附件 line so the caller can append exactly one', () => {
    // badcase chat 6a2fac72…：vision OCR 把卡片内嵌附件链接也转写进了描述，
    // 再无条件追加一行会出现重复"简历附件"行。
    const description = '简历图片：姓名徐中如\n- 工作经历：良品铺子\n简历附件：https://oss/a.jpg';
    expect(stripResumeAttachmentLines(description)).toBe('简历图片：姓名徐中如\n- 工作经历：良品铺子');
  });

  it('is a no-op when no 简历附件 line is present', () => {
    const description = '简历图片：姓名徐中如\n- 工作经历：良品铺子';
    expect(stripResumeAttachmentLines(description)).toBe(description);
  });

  it('removes multiple 简历附件 lines (含半角冒号) and collapses blank gaps', () => {
    const description = '简历图片：张三\n简历附件：https://oss/a.jpg\n简历附件: https://oss/a.jpg';
    expect(stripResumeAttachmentLines(description)).toBe('简历图片：张三');
  });

  it('guarantees a single attachment line after the service re-appends', () => {
    const description = '简历图片：李四\n简历附件：https://oss/old.jpg';
    const url = 'https://oss/new.jpg';
    const content = `[图片消息] ${stripResumeAttachmentLines(description)}\n简历附件：${url}`;
    expect(content.match(/简历附件\s*[：:]/g)).toHaveLength(1);
    expect(content).toContain('简历附件：https://oss/new.jpg');
  });
});
