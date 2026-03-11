import { Module, Global, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MonitoringService } from './monitoring.service';
import { DashboardController } from './dashboard.controller';
import { MonitoringCacheService } from './monitoring-cache.service';
import { DataCleanupService } from './data-cleanup.service';
import { MessageTrackingService } from './services/message-tracking.service';
import { MessageModule } from '@wecom/message/message.module';
import { FeishuModule } from '@/core/feishu/feishu.module';

/**
 * 核心监控模块 (Infrastructure Layer)
 * 负责系统的运行时监控、消息追踪、告警与维护
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot(), forwardRef(() => MessageModule), FeishuModule],
  controllers: [DashboardController],
  providers: [
    MonitoringCacheService,
    MessageTrackingService,
    MonitoringService,
    DataCleanupService,
  ],
  exports: [MonitoringService, MessageTrackingService, MonitoringCacheService, DataCleanupService],
})
export class MonitoringModule {}
