import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { CenterDashboardRepository } from './center-dashboard.repository';
import { CenterDashboardService } from './center-dashboard.service';
import { CenterDashboardInterceptor } from './center-dashboard.interceptor';
import { CenterScopeService } from './center-scope.service';
import { DashboardAccessController } from './dashboard-access.controller';

import { HostingBindingsRepository } from './hosting-bindings.repository';
import { HostingBindingsController } from './hosting-bindings.controller';
import { HostingBindingsService } from './hosting-bindings.service';

@Global()
@Module({
  imports: [HostingConfigModule],
  controllers: [DashboardAccessController, HostingBindingsController],
  providers: [
    CenterScopeService,
    HostingBindingsRepository,
    HostingBindingsService,
    CenterDashboardRepository,
    CenterDashboardService,
    { provide: APP_INTERCEPTOR, useClass: CenterDashboardInterceptor },
  ],
  exports: [CenterScopeService, HostingBindingsRepository],
})
export class CenterDashboardModule {}
