import { Controller, Get, Header, Req, Sse } from '@nestjs/common';
import { timer, map } from 'rxjs';
import { RawResponse } from '@infra/server/response/decorators/api-response.decorator';
import type { Request } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { DASHBOARD_ORGANIZATIONS, isDashboardAdministrator } from '@/types/dashboard-account';
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
    // Only an invalidation signal. Every data fetch checks current account status again.
    return timer(0, 15000).pipe(map(() => ({ data: { type: 'refresh' } })));
  }

  @Get('access')
  @Header('Cache-Control', 'no-store')
  async getAccess(@Req() request: Request) {
    const account = this.access.requireAccount(request);
    const centerId = account.organization === 'headquarters' ? null : account.organization;
    const scope = centerId ? await this.scopes.getScope(false, centerId) : null;
    return {
      userId: account.userId,
      displayName: account.name,
      isAdministrator: isDashboardAdministrator(account),
      organization: account.organization,
      centerId,
      name: DASHBOARD_ORGANIZATIONS[account.organization],
      henanGroupMarker: this.scopes.henanGroupMarker,
      scopeKey: scope
        ? [...scope.groups.map((g) => g.id), ...scope.botIds].sort().join(',')
        : 'headquarters',
    };
  }
}
