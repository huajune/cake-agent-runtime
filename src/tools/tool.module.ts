import { ActionPermitModule } from '@biz/action-permit/action-permit.module';
import { Module } from '@nestjs/common';
import { ToolActionService } from './actions/tool-action.service';
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
import { BookingSnapshotService } from './booking/booking-snapshot.service';

@Module({
  imports: [
    ActionPermitModule,
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
  providers: [
    ToolActionService,
    CollectionFormStore,
    CollectionFormService,
    BookingSnapshotService,
    ToolRegistryService,
  ],
  exports: [CollectionFormService, BookingSnapshotService, ToolRegistryService],
})
export class ToolModule {}
