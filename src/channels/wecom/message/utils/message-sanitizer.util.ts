import { EnterpriseMessageCallbackDto } from '../dto/message-callback.dto';

/**
 * 消息脱敏工具类
 * 用于移除或隐藏消息中的敏感信息
 */
export class MessageSanitizer {
  /**
   * 脱敏消息数据
   * 移除敏感信息，用于日志记录和调试
   */
  static sanitize(messageData: EnterpriseMessageCallbackDto): any {
    const sanitized: any = { ...messageData };

    // 脱敏敏感信息
    if (sanitized.token) {
      sanitized.token = this.sanitizeString(sanitized.token, 4, 4);
    }
    if (sanitized.imBotId) {
      sanitized.imBotId = this.sanitizeString(sanitized.imBotId, 3, 3);
    }
    if (sanitized.orgId) {
      sanitized.orgId = this.sanitizeString(sanitized.orgId, 3, 3);
    }

    return sanitized;
  }

  /**
   * 脱敏字符串
   * 显示前后若干位，中间用****替换
   * @param str 要脱敏的字符串
   * @param prefixLen 保留前缀长度
   * @param suffixLen 保留后缀长度
   * @returns 脱敏后的字符串
   */
  static sanitizeString(
    str: string | undefined,
    prefixLen: number = 3,
    suffixLen: number = 3,
  ): string | undefined {
    if (!str || typeof str !== 'string') {
      return str;
    }

    const minLen = prefixLen + suffixLen;
    if (str.length <= minLen) {
      return '****';
    }

    return `${str.substring(0, prefixLen)}****${str.substring(str.length - suffixLen)}`;
  }
}
