import { Module } from '@nestjs/common';
import { StrategyModule } from './strategy/strategy.module';
import { HostingConfigModule } from './hosting-config/hosting-config.module';
import { UserModule } from './user/user.module';
import { BizMessageModule } from './message/message.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { GroupTaskModule } from './group-task/group-task.module';
import { RecruitmentCaseModule } from './recruitment-case/recruitment-case.module';

@Module({
  imports: [
    StrategyModule,
    HostingConfigModule,
    UserModule,
    BizMessageModule,
    MonitoringModule,
    GroupTaskModule,
    RecruitmentCaseModule,
  ],
  exports: [
    StrategyModule,
    HostingConfigModule,
    UserModule,
    BizMessageModule,
    MonitoringModule,
    GroupTaskModule,
    RecruitmentCaseModule,
  ],
})
export class BizModule {}
