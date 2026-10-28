import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DashboardAccessService } from './dashboard-access.service';

import { centerRoute } from './center-routes';

@Injectable()
export class DashboardAccessGuard implements CanActivate {
  constructor(private readonly access: DashboardAccessService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path.replace(/\/+$/, '') || '/';
    // 部署探针直连容器端口，没有入口代理的来源头；只放行既有公开健康检查。
    if (request.method === 'GET' && path === '/agent/health') return true;
    const scope = this.access.resolve(request);
    if (!scope.centerId) return true;
    if (scope.centerId === 'denied') throw new ForbiddenException('无法识别访问来源');
    // 静态页面不携带业务数据；业务读操作走专用范围接口。
    if (
      request.method === 'GET' &&
      (Boolean(centerRoute(request)) || path === '/' || path === '/web' || path.startsWith('/web/'))
    )
      return true;
    if (centerRoute(request) === 'group-switch') {
      // IP 身份没有登录 cookie，仍需防止其他网站借用办公室出口发起开关操作。
      let sameOrigin = false;
      try {
        const origin = new URL(request.headers.origin || '');
        sameOrigin =
          ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host;
      } catch {
        /* 缺少 Origin 时拒绝写操作。 */
      }
      if (
        sameOrigin &&
        request.headers['x-center-action'] === 'hosting' &&
        request.headers['content-type']?.split(';')[0].trim() === 'application/json'
      )
        return true;
    }
    throw new ForbiddenException('当前中心无权访问此功能');
  }
}
