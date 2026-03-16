import { MessageSanitizer } from '@wecom/message/utils/message-sanitizer.util';
import { EnterpriseMessageCallbackDto } from '@wecom/message/dto/message-callback.dto';

describe('MessageSanitizer', () => {
  describe('sanitizeString', () => {
    it('should mask middle portion of a string with default lengths', () => {
      const result = MessageSanitizer.sanitizeString('abcdefghij');
      expect(result).toBe('abc****hij');
    });

    it('should mask with custom prefix and suffix lengths', () => {
      const result = MessageSanitizer.sanitizeString('token_abc123', 4, 4);
      expect(result).toBe('toke****3123'.slice(0, 4) + '****' + 'token_abc123'.slice(-4));
      // More precisely:
      expect(result).toBe('toke****c123');
    });

    it('should return **** for strings too short to show prefix+suffix', () => {
      const result = MessageSanitizer.sanitizeString('abc', 3, 3);
      expect(result).toBe('****');
    });

    it('should return **** for a string equal to prefix+suffix length', () => {
      const result = MessageSanitizer.sanitizeString('abcdef', 3, 3);
      expect(result).toBe('****');
    });

    it('should return **** for strings shorter than prefix+suffix', () => {
      const result = MessageSanitizer.sanitizeString('ab', 3, 3);
      expect(result).toBe('****');
    });

    it('should return undefined for undefined input', () => {
      const result = MessageSanitizer.sanitizeString(undefined);
      expect(result).toBeUndefined();
    });

    it('should return undefined for null-like inputs when passed directly', () => {
      const result = MessageSanitizer.sanitizeString(undefined, 3, 3);
      expect(result).toBeUndefined();
    });

    it('should return the original empty string for empty string (early exit on falsy)', () => {
      const result = MessageSanitizer.sanitizeString('');
      // Empty string is falsy, so the guard returns it as-is
      expect(result).toBe('');
    });

    it('should handle long tokens correctly', () => {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
      const result = MessageSanitizer.sanitizeString(token, 4, 4);
      expect(result).toBe('eyJh****ture');
    });

    it('should use default prefixLen=3 and suffixLen=3 when not specified', () => {
      const result = MessageSanitizer.sanitizeString('0123456789');
      expect(result).toBe('012****789');
    });
  });

  describe('sanitize', () => {
    const buildMessageData = (
      overrides: Partial<EnterpriseMessageCallbackDto> = {},
    ): EnterpriseMessageCallbackDto => {
      return {
        token: 'tok_abcdefgh',
        messageId: 'msg_001',
        messageType: 1,
        payload: { text: 'hello', pureText: 'hello' },
        chatId: 'chat_001',
        botId: 'bot_001',
        isSelf: false,
        timestamp: '1700000000000',
        ...overrides,
      } as EnterpriseMessageCallbackDto;
    };

    it('should sanitize token field', () => {
      const messageData = buildMessageData({ token: 'tok_abcdefgh' });
      const result = MessageSanitizer.sanitize(messageData);
      expect(result.token).not.toBe('tok_abcdefgh');
      expect(result.token).toContain('****');
    });

    it('should sanitize imBotId field when present', () => {
      const messageData = buildMessageData({ imBotId: 'wxid_abcdef123' });
      const result = MessageSanitizer.sanitize(messageData);
      expect(result.imBotId).not.toBe('wxid_abcdef123');
      expect(result.imBotId).toContain('****');
    });

    it('should sanitize orgId field when present', () => {
      const messageData = buildMessageData({
        orgId: 'org_xyz789',
      } as Partial<EnterpriseMessageCallbackDto> & { orgId?: string });
      const result = MessageSanitizer.sanitize(messageData as EnterpriseMessageCallbackDto);
      expect(result.orgId).toContain('****');
    });

    it('should not modify fields that are not sensitive', () => {
      const messageData = buildMessageData({
        messageId: 'msg_001',
        chatId: 'chat_001',
      });
      const result = MessageSanitizer.sanitize(messageData);
      expect(result.messageId).toBe('msg_001');
      expect(result.chatId).toBe('chat_001');
    });

    it('should not mutate the original object', () => {
      const messageData = buildMessageData({ token: 'tok_abcdefgh' });
      const originalToken = messageData.token;
      MessageSanitizer.sanitize(messageData);
      expect(messageData.token).toBe(originalToken);
    });

    it('should skip sanitizing token if token is an empty string (falsy)', () => {
      const messageData = buildMessageData({ token: '' });
      const result = MessageSanitizer.sanitize(messageData);
      // sanitize only runs sanitizeString if sanitized.token is truthy, empty string is falsy
      // so empty token passes through as ''
      expect(result.token).toBe('');
    });

    it('should preserve payload field unchanged', () => {
      const payload = { text: 'hello world', pureText: 'hello world' };
      const messageData = buildMessageData({ payload });
      const result = MessageSanitizer.sanitize(messageData);
      expect(result.payload).toEqual(payload);
    });

    it('should handle object without imBotId gracefully', () => {
      const messageData = buildMessageData();
      // No imBotId on this message, should not throw
      expect(() => MessageSanitizer.sanitize(messageData)).not.toThrow();
    });
  });
});
