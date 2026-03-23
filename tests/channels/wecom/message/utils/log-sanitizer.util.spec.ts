import { LogSanitizer } from '@wecom/message/utils/log-sanitizer.util';

describe('LogSanitizer', () => {
  describe('sanitizeMessageCallback', () => {
    it('应该返回非对象类型的原值', () => {
      expect(LogSanitizer.sanitizeMessageCallback(null)).toBeNull();
      expect(LogSanitizer.sanitizeMessageCallback(undefined)).toBeUndefined();
      expect(LogSanitizer.sanitizeMessageCallback('string')).toBe('string');
      expect(LogSanitizer.sanitizeMessageCallback(123)).toBe(123);
    });

    it('应该脱敏 token 字段（保留前4位和后4位）', () => {
      const data = {
        token: 'abcd1234567890xyz', // 17个字符
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.token).toBe('abcd********0xyz'); // 前4位 abcd + 8个* + 后4位 0xyz
    });

    it('应该处理短 token（少于8位）', () => {
      const data = {
        token: 'abc123',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.token).toBe('***'); // 太短，全部掩码
    });

    it('应该脱敏 chatId（保留前6位）', () => {
      const data = {
        chatId: 'wxid_123456789abcdef',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.chatId).toBe('wxid_1********'); // 前6位 + 8个*
    });

    it('应该脱敏 wxid（保留前6位）', () => {
      const data = {
        wxid: 'wxid_abcdefghijk',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.wxid).toBe('wxid_a********'); // 前6位 + 8个*
    });

    it('应该脱敏 roomWxid（保留前6位）', () => {
      const data = {
        roomWxid: 'room_123456789',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.roomWxid).toBe('room_1********'); // 前6位 + 最多8个*
    });

    it('应该截断长消息内容（最多100字符）', () => {
      const longContent = 'a'.repeat(150);
      const data = {
        content: longContent,
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.content).toBe('a'.repeat(100) + '... (truncated 50 chars)');
    });

    it('应该保留短消息内容', () => {
      const data = {
        content: '这是一条短消息',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.content).toBe('这是一条短消息');
    });

    it('应该保留非敏感字段', () => {
      const data = {
        messageId: 'msg-123',
        source: 1,
        isSelf: false,
        otherField: 'value',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.messageId).toBe('msg-123');
      expect(result.source).toBe(1);
      expect(result.isSelf).toBe(false);
      expect(result.otherField).toBe('value');
    });

    it('应该同时处理多个敏感字段', () => {
      const data = {
        token: 'abcdefgh1234567890', // 18个字符
        chatId: 'wxid_123456789',
        wxid: 'wxid_abcdefghi',
        roomWxid: 'room_987654321',
        content: 'x'.repeat(120),
        messageId: 'msg-001',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);

      // 验证所有敏感字段都被脱敏
      expect(result.token).toBe('abcd********7890'); // 前4位 + 8个* + 后4位
      expect(result.chatId).toMatch(/^wxid_1\*/);
      expect(result.wxid).toMatch(/^wxid_a\*/);
      expect(result.roomWxid).toMatch(/^room_9\*/);
      expect(result.content).toContain('truncated 20 chars');
      // 非敏感字段保持不变
      expect(result.messageId).toBe('msg-001');
    });

    it('应该处理缺少敏感字段的情况', () => {
      const data = {
        messageId: 'msg-123',
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result).toEqual({ messageId: 'msg-123' });
    });

    it('应该处理空对象', () => {
      const result = LogSanitizer.sanitizeMessageCallback({});
      expect(result).toEqual({});
    });

    it('应该保护原始对象不被修改', () => {
      const original = {
        token: 'secret-token-123456',
        content: 'original content',
      };
      const result = LogSanitizer.sanitizeMessageCallback(original);

      // 原始对象不应该被修改
      expect(original.token).toBe('secret-token-123456');
      expect(original.content).toBe('original content');
      // 返回的对象应该被脱敏
      expect(result.token).not.toBe('secret-token-123456');
    });

    it('应该处理非字符串类型的敏感字段', () => {
      const data = {
        token: 12345, // 数字
        chatId: null, // null
        wxid: undefined, // undefined
      };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      // 非字符串字段应该保持原值
      expect(result.token).toBe(12345);
      expect(result.chatId).toBeNull();
      expect(result.wxid).toBeUndefined();
    });
  });

  describe('边界情况', () => {
    it('应该处理恰好8个字符的 token', () => {
      const data = { token: 'abcd1234' };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.token).toBe('***'); // 长度 <= prefixLen + suffixLen，全部掩码
    });

    it('应该处理9个字符的 token（刚好可以显示前后缀）', () => {
      const data = { token: 'abcd12345' };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.token).toBe('abcd*2345'); // 前4 + 1个* + 后4
    });

    it('应该限制星号最多显示8个', () => {
      const data = { token: 'a'.repeat(4) + 'x'.repeat(100) + 'z'.repeat(4) };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      // 应该是 aaaa + 8个* + zzzz（不是100个*）
      expect(result.token).toBe('aaaa********zzzz');
    });

    it('应该处理恰好100字符的消息', () => {
      const data = { content: 'a'.repeat(100) };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.content).toBe('a'.repeat(100)); // 不截断
    });

    it('应该处理恰好101字符的消息', () => {
      const data = { content: 'a'.repeat(101) };
      const result = LogSanitizer.sanitizeMessageCallback(data);
      expect(result.content).toBe('a'.repeat(100) + '... (truncated 1 chars)');
    });
  });
});
