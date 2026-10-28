import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DashboardAccessService } from './dashboard-access.service';
import { DashboardAccessGuard } from './dashboard-access.guard';

@Global()
@Module({
  providers: [DashboardAccessService, { provide: APP_GUARD, useClass: DashboardAccessGuard }],
  exports: [DashboardAccessService],
})
export class DashboardAccessModule {}
