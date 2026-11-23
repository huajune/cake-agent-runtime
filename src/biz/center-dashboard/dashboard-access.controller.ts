import { Controller, Get, Header, Req, Sse } from '@nestjs/common';
import { timer, map } from 'rxjs';
import { RawResponse } from '@infra/server/response/decorators/api-response.decorator';
import type { Request } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { isDashboardAdministrator } from '@/types/dashboard-account';

@Controller('dashboard')
export class DashboardAccessController {
  constructor(private readonly access: DashboardAccessService) {}

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
    const centerId = account.tenant?.readsAllTenants ? null : account.organization;
    return {
      userId: account.userId,
      displayName: account.name,
      isAdministrator: isDashboardAdministrator(account),
      tenantRole: account.tenantRole,
      organization: account.organization,
      centerId,
      name: account.tenant?.name ?? account.organization,
      scopeKey: account.organization,
    };
  }
}
