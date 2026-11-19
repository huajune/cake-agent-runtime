import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DASHBOARD_IP_DENIED } from '@shared-types/dashboard-access.contract';
import { DashboardAccessService } from './dashboard-access.service';

import { centerRoute } from './center-routes';

@Injectable()
export class DashboardAccessGuard implements CanActivate {
  constructor(private readonly access: DashboardAccessService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path.replace(/\/+$/, '') || '/';
    // 机器回调不使用办公室网络身份；只豁免已存在的精确方法/路径，不能按 @Public 一概放行。
    if (request.method === 'GET' && path === '/agent/health') return true;
    if (
      request.method === 'POST' &&
      ['/message', '/message/sent-result', '/message/sentResult', '/new-customer'].includes(path)
    )
      return true;
    const scope = this.access.resolve(request);
    if (!scope.centerId) return true;
    if (scope.centerId === 'denied') {
      context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
      throw new ForbiddenException({ code: DASHBOARD_IP_DENIED, message: '无访问权限' });
    }
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
