/**
 * 日志脱敏工具类
 * 用于在日志输出前对敏感字段进行掩码处理
 */
export class LogSanitizer {
  /**
   * 脱敏消息回调数据
   * @param data 原始消息数据
   * @returns 脱敏后的数据
   */
  static sanitizeMessageCallback(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sanitized = { ...data };

    // 脱敏 token 字段（保留前4位和后4位）
    if (sanitized.token && typeof sanitized.token === 'string') {
      sanitized.token = this.maskString(sanitized.token, 4, 4);
    }

    // 脱敏 chatId（保留前6位）
    if (sanitized.chatId && typeof sanitized.chatId === 'string') {
      sanitized.chatId = this.maskString(sanitized.chatId, 6, 0);
    }

    // 脱敏 wxid（保留前6位）
    if (sanitized.wxid && typeof sanitized.wxid === 'string') {
      sanitized.wxid = this.maskString(sanitized.wxid, 6, 0);
    }

    // 脱敏 roomWxid（保留前6位）
    if (sanitized.roomWxid && typeof sanitized.roomWxid === 'string') {
      sanitized.roomWxid = this.maskString(sanitized.roomWxid, 6, 0);
    }

    // 截断消息内容（最多保留100个字符）
    if (sanitized.content && typeof sanitized.content === 'string') {
      sanitized.content = this.truncateString(sanitized.content, 100);
    }

    return sanitized;
  }

  /**
   * 对字符串进行掩码处理
   * @param str 原始字符串
   * @param prefixLen 保留前缀长度
   * @param suffixLen 保留后缀长度
   * @returns 掩码后的字符串
   */
  private static maskString(str: string, prefixLen: number, suffixLen: number): string {
    if (!str || str.length <= prefixLen + suffixLen) {
      return '***';
    }

    const prefix = str.substring(0, prefixLen);
    const suffix = suffixLen > 0 ? str.substring(str.length - suffixLen) : '';
    const maskedLength = str.length - prefixLen - suffixLen;
    const mask = '*'.repeat(Math.min(maskedLength, 8)); // 最多显示8个星号

    return `${prefix}${mask}${suffix}`;
  }

  /**
   * 截断长字符串
   * @param str 原始字符串
   * @param maxLen 最大长度
   * @returns 截断后的字符串
   */
  private static truncateString(str: string, maxLen: number): string {
    if (!str || str.length <= maxLen) {
      return str;
    }

    return `${str.substring(0, maxLen)}... (truncated ${str.length - maxLen} chars)`;
  }
}
