import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { createSuccessResponse, ApiSuccessResponse } from '../dto/response.dto';
import { RAW_RESPONSE_KEY } from '../decorators/api-response.decorator';

/**
 * 响应拦截器
 * 自动将 controller 返回的数据包装成统一的成功响应格式
 *
 * 使用方式：
 * - 在 main.ts 中全局注册：app.useGlobalInterceptors(new ResponseInterceptor(reflector))
 *
 * 豁免机制：
 * - 使用 @RawResponse() 装饰器标记的端点会跳过包装
 * - 如果 controller 已经返回了 { success: true, data: ... } 格式，也会跳过包装
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiSuccessResponse<T>> {
    // 检查是否标记为原始响应（@RawResponse）
    const isRawResponse = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isRawResponse) {
      return next.handle(); // 直接返回原始响应
    }

    return next.handle().pipe(
      map((data) => {
        // 如果数据为空或 undefined，返回空数据响应
        if (data === null || data === undefined) {
          return createSuccessResponse(null);
        }

        // 如果已经是标准响应格式（包含 success 字段），直接返回
        if (this.isStandardResponse(data)) {
          return data;
        }

        // 否则，包装成标准成功响应
        return createSuccessResponse(data);
      }),
    );
  }

  /**
   * 检查是否已经是标准响应格式
   * @param data 响应数据
   * @returns 是否为标准响应格式
   */
  private isStandardResponse(data: any): boolean {
    return (
      typeof data === 'object' &&
      data !== null &&
      'success' in data &&
      typeof data.success === 'boolean'
    );
  }
}
