import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { createErrorResponse } from '../dto/response.dto';

/**
 * HTTP 异常过滤器
 * 统一处理所有 HTTP 异常，返回标准错误响应格式
 *
 * 使用方式：
 * 1. 在 main.ts 中全局注册：app.useGlobalFilters(new HttpExceptionFilter())
 * 2. 或者在 controller/method 上使用 @UseFilters(HttpExceptionFilter)
 *
 * 处理的异常类型：
 * - HttpException：NestJS 内置异常
 * - 其他未捕获异常：统一返回 500 Internal Server Error
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 默认状态码和错误信息
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Internal server error';
    let details: any = undefined;

    // 处理 HttpException
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as any;

        // 提取错误信息
        message = responseObj.message || exception.message;
        code = responseObj.code || this.getErrorCodeFromStatus(status);
        details = responseObj.details || responseObj.error;

        // 处理 class-validator 的验证错误
        if (Array.isArray(message)) {
          details = { validationErrors: message };
          message = 'Validation failed';
        }
      } else {
        message = String(exceptionResponse);
        code = this.getErrorCodeFromStatus(status);
      }
    } else if (exception instanceof Error) {
      // 处理其他 Error 类型
      message = exception.message || message;
      details = {
        name: exception.name,
        stack: process.env.NODE_ENV === 'development' ? exception.stack : undefined,
      };
    }

    // 记录错误日志
    this.logger.error(
      `[${request.method}] ${request.url} - ${status} ${code}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // 返回标准错误响应
    const errorResponse = createErrorResponse(code, message, details, request.url);

    response.status(status).json(errorResponse);
  }

  /**
   * 根据 HTTP 状态码生成错误代码
   * @param status HTTP 状态码
   * @returns 错误代码字符串
   */
  private getErrorCodeFromStatus(status: number): string {
    const codeMap: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_SERVER_ERROR',
      502: 'BAD_GATEWAY',
      503: 'SERVICE_UNAVAILABLE',
      504: 'GATEWAY_TIMEOUT',
    };

    return codeMap[status] || 'UNKNOWN_ERROR';
  }
}
