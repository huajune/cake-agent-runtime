import { Global, Module } from '@nestjs/common';
import { GROUP_DIRECTORY_PROVIDER } from '@biz/ops-events/providers/group-directory.provider';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

@Global()
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [GroupController],
  providers: [GroupService, { provide: GROUP_DIRECTORY_PROVIDER, useExisting: GroupService }],
  exports: [GroupService, GROUP_DIRECTORY_PROVIDER],
})
export class GroupModule {}
