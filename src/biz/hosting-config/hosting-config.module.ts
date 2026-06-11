import { Module } from '@nestjs/common';
import { SystemConfigRepository } from './repositories/system-config.repository';
import { GroupBlacklistRepository } from './repositories/group-blacklist.repository';
import { CandidateBlacklistRepository } from './repositories/candidate-blacklist.repository';
import { SystemConfigService } from './services/system-config.service';
import { GroupBlacklistService } from './services/group-blacklist.service';
import { CandidateBlacklistService } from './services/candidate-blacklist.service';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';
import { HostingConfigController } from './hosting-config.controller';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  providers: [
    // repositories
    SystemConfigRepository,
    GroupBlacklistRepository,
    CandidateBlacklistRepository,
    // services
    SystemConfigService,
    GroupBlacklistService,
    CandidateBlacklistService,
    HostingConfigFacadeService,
  ],
  controllers: [HostingConfigController],
  exports: [SystemConfigService, GroupBlacklistService, CandidateBlacklistService],
})
export class HostingConfigModule {}
