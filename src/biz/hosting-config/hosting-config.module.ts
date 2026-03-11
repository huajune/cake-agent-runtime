import { Module, forwardRef } from '@nestjs/common';
import { SystemConfigRepository } from './repositories/system-config.repository';
import { GroupBlacklistRepository } from './repositories/group-blacklist.repository';
import { SystemConfigService } from './services/system-config.service';
import { GroupBlacklistService } from './services/group-blacklist.service';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';
import { HostingConfigController } from './hosting-config.controller';
import { UserModule } from '../user/user.module';
import { MessageModule } from '@wecom/message/message.module';

/**
 * HostingConfigModule imports MessageModule so the controller can inject
 * MessageService and MessageProcessor directly (presentation-layer access).
 * MessageModule → BizModule → HostingConfigModule creates a circular module
 * reference, which NestJS resolves safely with forwardRef at the module level.
 * The facade service itself has no wecom dependency.
 */
@Module({
  imports: [UserModule, forwardRef(() => MessageModule)],
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
