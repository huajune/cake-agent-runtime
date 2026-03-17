import { SetMetadata } from '@nestjs/common';

/**
 * 元数据键：标记原始响应
 */
export const RAW_RESPONSE_KEY = 'raw_response';

/**
 * 原始响应装饰器
 * 用于标记**不需要**统一响应格式的端点（豁免全局 ResponseInterceptor）
 *
 * 使用场景：
 * 1. 第三方回调接口（如企微回调，必须返回特定格式）
 * 2. 透传第三方 API 原始响应
 * 3. 特殊协议接口
 *
 * 使用方式：
 * ```typescript
 * // 企微回调接口
 * @RawResponse()
 * @Post('callback')
 * async handleCallback(@Body() body: any) {
 *   await this.service.handle(body);
 *   return { errcode: 0, errmsg: 'ok' };  // 直接返回原始格式
 * }
 *
 * // 透传 Agent API
 * @RawResponse()
 * @Get('tools')
 * async getTools() {
 *   return await this.agentService.getTools();  // 返回原始 API 响应
 * }
 * ```
 *
 * 工作原理：
 * - 设置元数据标记 `raw_response: true`
 * - ResponseInterceptor 检测到此标记后跳过包装
 * - 直接返回 controller 的原始响应
 */
export function RawResponse() {
  return SetMetadata(RAW_RESPONSE_KEY, true);
}
