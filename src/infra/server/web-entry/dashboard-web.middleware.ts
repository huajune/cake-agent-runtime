import type { RequestHandler } from 'express';
import { join, posix } from 'path';
import { DASHBOARD_ACCESS_DENIED_PATH } from '@shared-types/dashboard-access.contract';
import { DashboardAccessService } from '../dashboard-access/dashboard-access.service';

/** 必须在静态资源服务之前注册，避免 index.html、深层链接或缓存响应绕过入口检查。 */
export function dashboardWebMiddleware(
  access: DashboardAccessService,
  publicPath: string,
): RequestHandler {
  return (request, response, next) => {
    let path: string;
    try {
      path = posix.normalize(decodeURIComponent(request.path)).replace(/\/+$/, '') || '/';
    } catch {
      response.status(400).end();
      return;
    }
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isPageRequest && path === DASHBOARD_ACCESS_DENIED_PATH) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
      response.sendFile(join(publicPath, 'access-denied.html'));
      return;
    }
    if (path === '/' || /^\/web(?:\/|$)/i.test(path)) {
      response.setHeader('Cache-Control', 'no-store');
      if (access.resolve(request).centerId === 'denied') {
        response.redirect(303, DASHBOARD_ACCESS_DENIED_PATH);
        return;
      }
    }
    next();
  };
}
