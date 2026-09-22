import { Module } from '@nestjs/common';
import { UserModule } from '@biz/user/user.module';
import { FeishuTaskModule } from '@notification/feishu-task/feishu-task.module';
import { HostingPauseInspectionCron } from './hosting-pause-inspection.cron';
import { InterventionService } from './intervention.service';

@Module({
  imports: [UserModule, FeishuTaskModule],
  providers: [InterventionService, HostingPauseInspectionCron],
  exports: [InterventionService],
})
export class InterventionModule {}
