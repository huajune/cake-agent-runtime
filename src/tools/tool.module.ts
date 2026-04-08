import { Module } from '@nestjs/common';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { BizMessageModule } from '@biz/message/message.module';
import { GroupTaskModule } from '@biz/group-task/group-task.module';
import { RoomModule } from '@channels/wecom/room/room.module';
import { ToolRegistryService } from './tool-registry.service';

@Module({
  imports: [MemoryModule, SpongeModule, BizMessageModule, GroupTaskModule, RoomModule],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolModule {}
