import { Module, forwardRef } from '@nestjs/common';
import { SystemConfigRepository } from './repositories/system-config.repository';
import { GroupBlacklistRepository } from './repositories/group-blacklist.repository';
import { SystemConfigService } from './services/system-config.service';
import { GroupBlacklistService } from './services/group-blacklist.service';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';
import { HostingConfigController } from './hosting-config.controller';
import { UserModule } from '../user/user.module';
import { GroupTaskModule } from '@biz/group-task/group-task.module';

@Module({
  imports: [UserModule, forwardRef(() => GroupTaskModule)],
  providers: [
    // repositories
    SystemConfigRepository,
    GroupBlacklistRepository,
    // services
    SystemConfigService,
    GroupBlacklistService,
    HostingConfigFacadeService,
  ],
  controllers: [HostingConfigController],
  exports: [SystemConfigService, GroupBlacklistService],
})
export class HostingConfigModule {}
