import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { from, Observable, map, tap } from 'rxjs';
import { createSuccessResponse } from '@infra/server/response/dto/response.dto';
import type { Request, Response } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { centerRoute } from '@infra/server/dashboard-access/center-routes';
import { CenterDashboardService } from './center-dashboard.service';

/** 原 URL/响应结构保持一致；中心请求进入有范围的读取分支，总部走原处理器。 */
@Injectable()
export class CenterDashboardInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CenterDashboardInterceptor.name);
  constructor(
    private readonly access: DashboardAccessService,
    private readonly center: CenterDashboardService,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const route = centerRoute(request);
    const actor = this.access.current(request);
    if (route || actor)
      context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    const organization = actor?.organization;
    const result =
      organization &&
      organization !== 'headquarters' &&
      route &&
      route !== 'access' &&
      route !== 'events'
        ? from(this.center.handle(route, request, organization)).pipe(
            map((data) => createSuccessResponse(data)),
          )
        : next.handle();
    if (!actor || route !== 'group-switch' || request.body?.type !== 'groupId') return result;
    return result.pipe(
      tap(() =>
        this.logger.log(
          `小组托管开关 actor=${actor.userId} organization=${actor.organization} group=${JSON.stringify(request.body.id)} method=${request.method}`,
        ),
      ),
    );
  }
}
