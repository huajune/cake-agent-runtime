import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { from, Observable, map, tap } from 'rxjs';
import { createSuccessResponse } from '@infra/server/response/dto/response.dto';
import type { Request, Response } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { centerRoute, requiresTenantScope } from '@infra/server/dashboard-access/center-routes';
import { CenterDashboardService } from './center-dashboard.service';

/** 总部跨组织查看，各组织员工的小组操作均按本组织处理。 */
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
    const result =
      actor &&
      route &&
      route !== 'access' &&
      route !== 'events' &&
      route !== 'user-switch' &&
      requiresTenantScope(actor, route)
        ? from(this.center.handle(route, request, actor.organization)).pipe(
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
