import { Module } from '@nestjs/common';
import { UserModule } from '@biz/user/user.module';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { CandidateBlacklistModule } from '@biz/candidate-blacklist/candidate-blacklist.module';
import { ActionPermitService } from './services/action-permit.service';

@Module({
  imports: [UserModule, HostingConfigModule, CandidateBlacklistModule],
  providers: [ActionPermitService],
  exports: [ActionPermitService],
})
export class ActionPermitModule {}
