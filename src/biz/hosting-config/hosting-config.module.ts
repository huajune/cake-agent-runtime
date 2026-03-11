import { Module, forwardRef } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { GroupBlacklistService } from './group-blacklist.service';
import { HostingConfigController } from './hosting-config.controller';
import { UserModule } from '../user/user.module';
import { MessageModule } from '@wecom/message/message.module';

@Module({
  imports: [UserModule, forwardRef(() => MessageModule)],
  providers: [SystemConfigService, GroupBlacklistService],
  controllers: [HostingConfigController],
  exports: [SystemConfigService, GroupBlacklistService],
})
export class HostingConfigModule {}
