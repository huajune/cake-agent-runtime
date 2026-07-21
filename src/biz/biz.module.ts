import { Module } from '@nestjs/common';
import { StrategyModule } from './strategy/strategy.module';
import { HostingConfigModule } from './hosting-config/hosting-config.module';
import { RoleModelOverridesModule } from './hosting-config/role-model-overrides.module';
import { CandidateBlacklistModule } from './candidate-blacklist/candidate-blacklist.module';
import { UserModule } from './user/user.module';
import { BizMessageModule } from './message/message.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { GroupTaskModule } from './group-task/group-task.module';
import { ConversionAnalyticsModule } from './conversion-analytics/conversion-analytics.module';

@Module({
  imports: [
    StrategyModule,
    HostingConfigModule,
    RoleModelOverridesModule,
    CandidateBlacklistModule,
    UserModule,
    BizMessageModule,
    MonitoringModule,
    ConversionAnalyticsModule,
    GroupTaskModule,
  ],
  exports: [
    StrategyModule,
    HostingConfigModule,
    CandidateBlacklistModule,
    UserModule,
    BizMessageModule,
    MonitoringModule,
    ConversionAnalyticsModule,
    GroupTaskModule,
  ],
})
export class BizModule {}
