import { Module } from '@nestjs/common';
import { StrategyModule } from './strategy/strategy.module';
import { HostingConfigModule } from './hosting-config/hosting-config.module';
import { UserModule } from './user/user.module';
import { BizMessageModule } from './message/message.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TestSuiteModule } from './test-suite/test-suite.module';

@Module({
  imports: [
    StrategyModule,
    HostingConfigModule,
    UserModule,
    BizMessageModule,
    AnalyticsModule,
    TestSuiteModule,
  ],
  exports: [
    StrategyModule,
    HostingConfigModule,
    UserModule,
    BizMessageModule,
    AnalyticsModule,
    TestSuiteModule,
  ],
})
export class BizModule {}
