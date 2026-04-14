import { Module } from '@nestjs/common';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { BizMessageModule } from '@biz/message/message.module';
import { GroupTaskModule } from '@biz/group-task/group-task.module';
import { RoomModule } from '@channels/wecom/room/room.module';
import { MessageSenderModule } from '@channels/wecom/message-sender/message-sender.module';
import { UserModule } from '@biz/user/user.module';
import { NotificationModule } from '@notification/notification.module';
import { ToolRegistryService } from './tool-registry.service';

@Module({
  imports: [
    MemoryModule,
    SpongeModule,
    BizMessageModule,
    GroupTaskModule,
    RoomModule,
    MessageSenderModule,
    UserModule,
    NotificationModule,
  ],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolModule {}
