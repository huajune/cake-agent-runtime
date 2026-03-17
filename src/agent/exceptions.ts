import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Agent 异常基类
 */
export class AgentException extends HttpException {
  constructor(message: string, statusCode: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR) {
    super(message, statusCode);
  }
}

/**
 * Agent 配置错误
 */
export class AgentConfigException extends AgentException {
  constructor(message: string) {
    super(`Agent配置错误: ${message}`, HttpStatus.BAD_REQUEST);
  }
}

/**
 * Agent API 认证失败错误
 */
export class AgentAuthException extends AgentException {
  constructor(message?: string) {
    super(message || 'Agent API 认证失败：API Key 无效或已过期', HttpStatus.UNAUTHORIZED);
  }
}

/**
 * Agent 频率限制错误
 */
export class AgentRateLimitException extends AgentException {
  constructor(
    public readonly retryAfter: number,
    message?: string,
  ) {
    super(message || `请求频率过高，请${retryAfter}秒后重试`, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Agent 上下文缺失错误
 */
export class AgentContextMissingException extends AgentException {
  constructor(
    public readonly missingFields: string[],
    public readonly tools: string[],
  ) {
    super(
      `Agent上下文缺失: ${missingFields.join(', ')} (工具: ${tools.join(', ')})`,
      HttpStatus.BAD_REQUEST,
    );
  }
}
