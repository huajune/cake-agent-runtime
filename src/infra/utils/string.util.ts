/**
 * 字符串工具函数
 */

/**
 * 对 API Key 进行脱敏处理
 * 显示前6位和后6位，中间用...替代
 *
 * @param apiKey - 原始 API Key
 * @returns 脱敏后的字符串，如果 apiKey 无效则返回 undefined
 *
 * @example
 * maskApiKey('sk-1234567890abcdef') // => 'sk-123...abcdef'
 * maskApiKey('short')               // => '***'
 * maskApiKey(undefined)             // => undefined
 */
export function maskApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey || typeof apiKey !== 'string') {
    return undefined;
  }
  if (apiKey.length <= 12) {
    return '***';
  }
  return `${apiKey.substring(0, 6)}...${apiKey.substring(apiKey.length - 6)}`;
}
