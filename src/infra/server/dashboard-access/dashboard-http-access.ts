import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DashboardAccessService } from './dashboard-access.service';

/** 精确保留现有健康探针和机器回调，不按 @Public() 放行后台调试接口。 */
export function isPublicIngressRequest(request: Pick<Request, 'method' | 'path'>): boolean {
  const path = request.path.replace(/\/+$/, '').toLowerCase() || '/';
  if (['GET', 'HEAD'].includes(request.method) && path === '/agent/health') return true;
  return (
    request.method === 'POST' &&
    ['/message', '/message/sent-result', '/message/sentresult', '/new-customer'].includes(path)
  );
}

/** 必须在静态资源之前安装，防止 express.static 绕过 Nest Guard 暴露后台资源。 */
export function configureDashboardHttpAccess(
  app: NestExpressApplication,
  publicPath: string,
): void {
  const access = app.get(DashboardAccessService);
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isPublicIngressRequest(request)) return next();
    const scope = access.resolve(request);
    if (scope.centerId !== 'denied') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: scope.name },
    });
  });
  app.useStaticAssets(publicPath);
}
