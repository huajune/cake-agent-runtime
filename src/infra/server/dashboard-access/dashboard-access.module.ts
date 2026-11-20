import { Global, Module } from '@nestjs/common';
import { DashboardAccessService } from './dashboard-access.service';
import { DashboardAccountsService } from './dashboard-accounts.service';
import { DashboardAccountsController } from './dashboard-accounts.controller';

@Global()
@Module({
  controllers: [DashboardAccountsController],
  providers: [DashboardAccessService, DashboardAccountsService],
  exports: [DashboardAccessService],
})
export class DashboardAccessModule {}
