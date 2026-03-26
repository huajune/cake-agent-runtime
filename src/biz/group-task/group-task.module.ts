import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SpongeModule } from '@sponge/sponge.module';
import { RoomModule } from '@channels/wecom/room/room.module';
import { MessageSenderModule } from '@channels/wecom/message-sender/message-sender.module';
import { CompletionService } from '@agent/completion.service';
import { GroupTaskSchedulerService } from './services/group-task-scheduler.service';
import { GroupResolverService } from './services/group-resolver.service';
import { NotificationSenderService } from './services/notification-sender.service';
import { BrandRotationService } from './services/brand-rotation.service';
import { OrderGrabStrategy } from './strategies/order-grab.strategy';
import { PartTimeJobStrategy } from './strategies/part-time-job.strategy';
import { StoreManagerStrategy } from './strategies/store-manager.strategy';
import { WorkTipsStrategy } from './strategies/work-tips.strategy';
import { GroupTaskController } from './group-task.controller';

/**
 * 群任务定时通知模块
 *
 * 四种自动化通知：抢单群、兼职群、店长群、工作小贴士
 * 定时拉取数据 → AI生成文案 → 发送到企微群 → 飞书通知结果
 */
@Module({
  imports: [ScheduleModule.forRoot(), SpongeModule, RoomModule, MessageSenderModule],
  controllers: [GroupTaskController],
  providers: [
    // 核心服务（CompletionService 依赖的 RouterService 是 Global 的）
    CompletionService,
    GroupTaskSchedulerService,
    GroupResolverService,
    NotificationSenderService,
    BrandRotationService,
    // 四种策略
    OrderGrabStrategy,
    PartTimeJobStrategy,
    StoreManagerStrategy,
    WorkTipsStrategy,
  ],
  exports: [GroupTaskSchedulerService],
})
export class GroupTaskModule {}
