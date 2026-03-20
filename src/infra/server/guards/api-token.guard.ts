import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC_KEY = 'isPublic';

@Injectable()
export class ApiTokenGuard implements CanActivate {
  private readonly logger = new Logger(ApiTokenGuard.name);
  private readonly guardToken: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.guardToken = this.configService.get<string>('API_GUARD_TOKEN');
    if (!this.guardToken) {
      this.logger.warn('API_GUARD_TOKEN 未配置，所有端点将不受保护');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // 检查 @Public() 装饰器
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // 未配置 token 时放行（开发环境兼容）
    if (!this.guardToken) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    const token = authHeader?.replace('Bearer ', '');

    if (token === this.guardToken) return true;

    this.logger.warn(`未授权访问: ${request.method} ${request.url}`);
    return false;
  }
}
