import { Module } from '@nestjs/common';
import { UserModule } from '@biz/user/user.module';
import { FeishuTaskModule } from '@notification/feishu-task/feishu-task.module';
import { InterventionService } from './intervention.service';

@Module({
  imports: [UserModule, FeishuTaskModule],
  providers: [InterventionService],
  exports: [InterventionService],
})
export class InterventionModule {}
