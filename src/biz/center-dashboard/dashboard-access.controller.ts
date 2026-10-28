import { Controller, Get, Header, Req, Sse } from '@nestjs/common';
import { timer, map } from 'rxjs';
import { RawResponse } from '@infra/server/response/decorators/api-response.decorator';
import type { Request } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { CenterScopeService } from './center-scope.service';

@Controller('dashboard')
export class DashboardAccessController {
  constructor(
    private readonly access: DashboardAccessService,
    private readonly scopes: CenterScopeService,
  ) {}

  @Sse('events')
  @RawResponse()
  @Header('X-Accel-Buffering', 'no')
  events() {
    // 不推送全局业务数据；页面收到信号后重新走有范围的读取接口。
    return timer(0, 15000).pipe(map(() => ({ data: { type: 'refresh' } })));
  }
  @Get('access')
  @Header('Cache-Control', 'no-store')
  async getAccess(@Req() request: Request) {
    const access = this.access.resolve(request);
    if (access.centerId !== 'henan') return { ...access, scopeKey: 'headquarters' };
    const scope = await this.scopes.getScope();
    return {
      ...access,
      scopeKey: [...scope.groups.map((group) => group.id), ...scope.botIds].sort().join(','),
    };
  }
}
