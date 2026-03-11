import { Module, forwardRef } from '@nestjs/common';
import { SystemConfigService, GroupBlacklistService, HostingConfigFacadeService } from './services';
import { HostingConfigController } from './hosting-config.controller';
import { UserModule } from '../user/user.module';
import { MessageModule } from '@wecom/message/message.module';

@Module({
  imports: [UserModule, forwardRef(() => MessageModule)],
  providers: [SystemConfigService, GroupBlacklistService, HostingConfigFacadeService],
  controllers: [HostingConfigController],
  exports: [SystemConfigService, GroupBlacklistService],
})
export class HostingConfigModule {}
