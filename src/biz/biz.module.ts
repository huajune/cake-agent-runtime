import { Module } from '@nestjs/common';
import { StrategyModule } from './strategy/strategy.module';
import { HostingConfigModule } from './hosting-config/hosting-config.module';
import { UserModule } from './user/user.module';
import { BizMessageModule } from './message/message.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { TestSuiteModule } from './test-suite/test-suite.module';

@Module({
  imports: [
    StrategyModule,
    HostingConfigModule,
    UserModule,
    BizMessageModule,
    MonitoringModule,
    TestSuiteModule,
  ],
  exports: [
    StrategyModule,
    HostingConfigModule,
    UserModule,
    BizMessageModule,
    MonitoringModule,
    TestSuiteModule,
  ],
})
export class BizModule {}
