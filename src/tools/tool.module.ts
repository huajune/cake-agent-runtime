import { Module } from '@nestjs/common';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { BrandResolutionModule } from '@resolution/brand/brand-resolution.module';
import { BizMessageModule } from '@biz/message/message.module';
import { GroupTaskModule } from '@biz/group-task/group-task.module';
import { RoomModule } from '@channels/wecom/room/room.module';
import { MessageSenderModule } from '@channels/wecom/message-sender/message-sender.module';
import { UserModule } from '@biz/user/user.module';
import { NotificationModule } from '@notification/notification.module';
import { InterventionModule } from '@biz/intervention/intervention.module';
import { ToolRegistryService } from './tool-registry.service';
import { LlmModule } from '@/llm/llm.module';
import { CollectionFormService } from './collection/collection-form.service';
import { CollectionFormStore } from './collection/collection-form.store';

@Module({
  imports: [
    MemoryModule,
    SpongeModule,
    BrandResolutionModule,
    BizMessageModule,
    GroupTaskModule,
    RoomModule,
    MessageSenderModule,
    UserModule,
    NotificationModule,
    InterventionModule,
    LlmModule,
  ],
  providers: [CollectionFormStore, CollectionFormService, ToolRegistryService],
  exports: [CollectionFormService, ToolRegistryService],
})
export class ToolModule {}
