import { Module } from '@nestjs/common';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [GroupController],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
