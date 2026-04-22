import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { SpongeModule } from '@sponge/sponge.module';
import { LlmModule } from '@/llm/llm.module';
import { RoomModule } from '@channels/wecom/room/room.module';
import { MessageSenderModule } from '@channels/wecom/message-sender/message-sender.module';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { GroupTaskSchedulerService } from './services/group-task-scheduler.service';
import { GroupResolverService } from './services/group-resolver.service';
import { GroupMembershipService } from './services/group-membership.service';
import { NotificationSenderService } from './services/notification-sender.service';
import { BrandRotationService } from './services/brand-rotation.service';
import { OrderGrabStrategy } from './strategies/order-grab.strategy';
import { PartTimeJobStrategy } from './strategies/part-time-job.strategy';
import { StoreManagerStrategy } from './strategies/store-manager.strategy';
import { WorkTipsStrategy } from './strategies/work-tips.strategy';
import { GroupTaskController } from './group-task.controller';
import { GroupTaskProcessor } from './queue/group-task.processor';
import { GROUP_TASK_QUEUE_NAME } from './queue/group-task-queue.constants';

/**
 * 群任务定时通知模块
 *
 * 四种自动化通知：抢单群、兼职群、店长群、工作小贴士
 * 流程：Cron 入队 plan → prepare 拉数据/生成消息 → send 单群幂等发送 → summarize 飞书汇总
 */
@Module({
  imports: [
    SpongeModule,
    LlmModule,
    RoomModule,
    MessageSenderModule,
    HostingConfigModule,
    BullModule.registerQueue({
      name: GROUP_TASK_QUEUE_NAME,
      defaultJobOptions: {
        // 单 job 默认保留 7 天，便于 web 端看历史、必要时点重试
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
      },
    }),
  ],
  controllers: [GroupTaskController],
  providers: [
    GroupTaskSchedulerService,
    GroupTaskProcessor,
    GroupResolverService,
    GroupMembershipService,
    NotificationSenderService,
    BrandRotationService,
    OrderGrabStrategy,
    PartTimeJobStrategy,
    StoreManagerStrategy,
    WorkTipsStrategy,
  ],
  exports: [GroupTaskSchedulerService, GroupResolverService, GroupMembershipService],
})
export class GroupTaskModule {}
