import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, Observable, map } from 'rxjs';
import { createSuccessResponse } from '@infra/server/response/dto/response.dto';
import type { Request, Response } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { centerRoute } from '@infra/server/dashboard-access/center-routes';
import { CenterDashboardService } from './center-dashboard.service';

/** 原 URL/响应结构保持一致；中心请求进入有范围的读取分支，总部走原处理器。 */
@Injectable()
export class CenterDashboardInterceptor implements NestInterceptor {
  constructor(
    private readonly access: DashboardAccessService,
    private readonly center: CenterDashboardService,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const route = centerRoute(request);
    if (route)
      context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    if (
      this.access.resolve(request).centerId !== 'henan' ||
      !route ||
      route === 'access' ||
      route === 'events'
    )
      return next.handle();
    return from(this.center.handle(route, request)).pipe(
      map((data) => createSuccessResponse(data)),
    );
  }
}
