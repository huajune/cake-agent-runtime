import { Module } from '@nestjs/common';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [GroupController],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
