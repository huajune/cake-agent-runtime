/**
 * 统一响应数据传输对象
 * 用于标准化所有 API 响应格式
 */

/**
 * 成功响应格式
 */
export interface ApiSuccessResponse<T = any> {
  /**
   * 请求是否成功
   */
  success: true;

  /**
   * 响应数据
   */
  data: T;

  /**
   * 响应消息（可选）
   */
  message?: string;

  /**
   * 响应时间戳
   */
  timestamp: string;
}

/**
 * 错误详情
 */
export interface ErrorDetails {
  /**
   * 错误代码
   */
  code: string;

  /**
   * 错误消息
   */
  message: string;

  /**
   * 错误详细信息（可选）
   */
  details?: any;
}

/**
 * 错误响应格式
 */
export interface ApiErrorResponse {
  /**
   * 请求是否成功
   */
  success: false;

  /**
   * 错误信息
   */
  error: ErrorDetails;

  /**
   * 响应时间戳
   */
  timestamp: string;

  /**
   * 请求路径（可选）
   */
  path?: string;
}

/**
 * 统一响应类型（成功或失败）
 */
export type StandardApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * 创建成功响应的辅助函数
 * @param data 响应数据
 * @param message 响应消息（可选）
 * @returns 标准成功响应对象
 */
export function createSuccessResponse<T>(data: T, message?: string): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    ...(message && { message }),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 创建错误响应的辅助函数
 * @param code 错误代码
 * @param message 错误消息
 * @param details 错误详情（可选）
 * @param path 请求路径（可选）
 * @returns 标准错误响应对象
 */
export function createErrorResponse(
  code: string,
  message: string,
  details?: any,
  path?: string,
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
    timestamp: new Date().toISOString(),
    ...(path && { path }),
  };
}
